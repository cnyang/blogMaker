import { readFile } from 'node:fs/promises';
import { requestJson } from './http.mjs';

export async function loadCredentials(env = process.env) {
  let credentials;
  try {
    credentials = JSON.parse(env.GOOGLE_CREDENTIALS_JSON || await readFile(env.GOOGLE_TOKEN_FILE || 'credentials/token.json', 'utf8'));
  } catch { throw new Error('找不到有效 Google 憑證；請執行 npm run auth 或設定 GOOGLE_CREDENTIALS_JSON'); }
  for (const key of ['client_id', 'client_secret', 'refresh_token']) {
    if (typeof credentials[key] !== 'string' || !credentials[key].trim()) throw new Error(`Google 憑證缺少 ${key}`);
  }
  return credentials;
}

export class BloggerClient {
  constructor(blogId, credentials, fetcher = fetch) {
    if (!/^\d+$/.test(blogId ?? '')) throw new Error('BLOGGER_BLOG_ID 必須是數字字串');
    this.blogId = blogId;
    this.credentials = credentials;
    this.fetcher = fetcher;
    this.expiresAt = 0;
  }

  async accessToken() {
    if (Date.now() < this.expiresAt) return this.token;
    const result = await requestJson('https://oauth2.googleapis.com/token', {
      service: 'Google OAuth', fetcher: this.fetcher, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: this.credentials.client_id, client_secret: this.credentials.client_secret, refresh_token: this.credentials.refresh_token }),
    });
    if (typeof result.access_token !== 'string' || !result.access_token) throw new Error('Google OAuth 未回傳 access token');
    this.token = result.access_token;
    this.expiresAt = Date.now() + Math.max(0, Number(result.expires_in || 0) - 60) * 1000;
    return this.token;
  }

  async request(method, suffix = '', body, query = {}) {
    const url = new URL(`https://www.googleapis.com/blogger/v3/blogs/${this.blogId}/posts${suffix}`);
    for (const [key, value] of Object.entries(query)) {
      for (const item of [].concat(value)) url.searchParams.append(key, String(item));
    }
    return requestJson(url, {
      service: 'Blogger', fetcher: this.fetcher, method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  get(postId) {
    if (!/^\d+$/.test(postId)) throw new Error('無效 Blogger post ID');
    // 預設 view 不回傳 status；沒有它，呼叫端無法分辨草稿與已公開。
    return this.request('GET', `/${postId}`, undefined, { view: 'ADMIN', fetchBody: true });
  }

  async findManaged() {
    const posts = new Map();
    const pages = new Set();
    let pageToken;
    do {
      const result = await this.request('GET', '', undefined, {
        view: 'ADMIN', status: ['live', 'draft', 'scheduled'], fetchBodies: true, maxResults: 500,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const post of result.items ?? []) {
        const markers = [...(post.content ?? '').matchAll(/<!-- blogger-pipeline:id=([a-zA-Z0-9][a-zA-Z0-9_-]{0,79});source=([a-f0-9]{64}) -->/g)];
        for (const [, id, sourceHash] of markers) {
          if (posts.has(id)) throw new Error(`遠端出現重複文章識別碼 ${id}，請先檢查 Blogger`);
          posts.set(id, { ...post, sourceHash });
        }
      }
      pageToken = result.nextPageToken;
      if (pageToken && pages.has(pageToken)) throw new Error('Blogger 回傳重複分頁 token');
      pages.add(pageToken);
    } while (pageToken);
    return posts;
  }

  insertDraft(payload) { return this.request('POST', '', payload, { isDraft: true }); }
  update(postId, payload) { return this.request('PATCH', `/${postId}`, payload); }
  publish(postId) { return this.request('POST', `/${postId}/publish`); }
  revert(postId) { return this.request('POST', `/${postId}/revert`); }
}
