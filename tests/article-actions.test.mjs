import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveVideoPost } from '../src/video.mjs';
import { runPipeline } from '../src/pipeline.mjs';
import { FileState } from '../src/state.mjs';
import { listArticles, previewArticle, publishArticle } from '../src/article-actions.mjs';

const env = { BLOGGER_BLOG_ID: '123' };
const document = (id, title, extra = {}, body = '這是審稿內容。') => `---\n${JSON.stringify({ id, title, publish: false, status: 'draft', ai: true, category: 'tech', date: '2026-11-09', ...extra })}\n---\n\n${body}\n`;

class Blogger {
  blogId = '123'; posts = new Map(); calls = [];
  async get(id) { this.calls.push('get'); if (!this.posts.has(id)) throw new Error('Blogger HTTP 404'); return structuredClone(this.posts.get(id)); }
  async findManaged() {
    this.calls.push('list');
    return new Map([...this.posts.values()].flatMap(post => {
      const id = post.content.match(/blogger-pipeline:id=([^;]+);/)?.[1];
      return id ? [[id, structuredClone(post)]] : [];
    }));
  }
  async insertDraft(payload) {
    this.calls.push('insert');
    const post = { ...payload, id: '77', status: 'DRAFT', url: 'https://example.test/77' };
    this.posts.set(post.id, post); return structuredClone(post);
  }
  async update(id, payload) { this.calls.push('update'); Object.assign(this.posts.get(id), payload); return this.get(id); }
  async publish(id) { this.calls.push('publish'); this.posts.get(id).status = 'LIVE'; return this.get(id); }
  async revert() { this.calls.push('revert'); throw new Error('不得取消公開'); }
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'blogmaker-tui-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'posts'));
  await writeFile(join(root, 'posts/a.md'), document('a', '文章 A'));
  await writeFile(join(root, 'posts/b.md'), document('b', '文章 B', { category: 'kids', publish: true }));
  const client = new Blogger();
  const snapshot = (await listArticles(root, env))[0].post;
  return { root, client, snapshot, options: { env, client } };
}

test('selected draft then public publication reuses the post and leaves local flags and other articles untouched', async t => {
  const { root, snapshot, client, options } = await setup(t);
  const before = await readFile(join(root, 'posts/a.md'), 'utf8');
  assert.match(await readFile(await previewArticle(root, snapshot), 'utf8'), /這是審稿內容/);
  assert.equal((await publishArticle(root, snapshot, 'draft', options)).status, 'DRAFT');
  assert.equal((await publishArticle(root, snapshot, 'published', options)).status, 'LIVE');
  assert.equal(client.posts.size, 1);
  assert.equal(client.calls.filter(x => x === 'insert').length, 1);
  assert.equal(client.calls.filter(x => x === 'publish').length, 1);
  assert.equal(await readFile(join(root, 'posts/a.md'), 'utf8'), before);
  const rows = await listArticles(root, env);
  assert.equal(rows.find(row => row.post.meta.id === 'a').record.status, 'LIVE');
  assert.equal(rows.find(row => row.post.meta.id === 'a').changed, false);
  assert.equal(rows.find(row => row.post.meta.id === 'b').record, undefined);
});

test('uploading a new article scans the remote blog only once', async t => {
  const { root, snapshot, client, options } = await setup(t);
  await publishArticle(root, snapshot, 'draft', options);
  assert.equal(client.calls.filter(x => x === 'list').length, 1);
});

test('missing configuration, edited source and unapproved video imports stop before remote mutations', async t => {
  const { root, snapshot, client, options } = await setup(t);
  await assert.rejects(publishArticle(root, snapshot, 'draft', { env: {}, client }), /BLOGGER_BLOG_ID/);
  await writeFile(join(root, 'posts/a.md'), document('a', '文章 A', {}, '已經被其他編輯修改。'));
  await assert.rejects(publishArticle(root, snapshot, 'published', options), /已變更/);
  assert.deepEqual(client.calls, []);
  await writeFile(join(root, 'posts/video.md'), document('vmk-example', '影片文章', { category: 'husky' }));
  const video = (await listArticles(root, env)).find(row => row.category === 'husky').post;
  await assert.rejects(publishArticle(root, video, 'published', options), /videoMaker/);
  assert.deepEqual(client.calls, []);
});

test('draft action cannot unpublish a live post, including a status change after the initial read', async t => {
  const { root, snapshot, client, options } = await setup(t);
  await publishArticle(root, snapshot, 'published', options);
  await assert.rejects(publishArticle(root, snapshot, 'draft', options), /取消公開/);
  client.posts.get('77').status = 'DRAFT';
  let reads = 0;
  const get = client.get.bind(client);
  client.get = async id => {
    if (++reads === 2) client.posts.get(id).status = 'LIVE';
    return get(id);
  };
  await writeFile(join(root, 'posts/a.md'), document('a', '文章 A', {}, '更新正文。'));
  const fresh = (await listArticles(root, env)).find(row => row.post.meta.id === 'a').post;
  await assert.rejects(publishArticle(root, fresh, 'draft', options), /取消公開/);
  assert.equal(client.calls.includes('revert'), false);
});

test('publishing rechecks manual remote draft changes instead of trusting a stale LIVE journal', async t => {
  const { root, snapshot, client, options } = await setup(t);
  await publishArticle(root, snapshot, 'published', options);
  client.posts.get('77').status = 'DRAFT';
  await publishArticle(root, snapshot, 'published', options);
  assert.equal(client.calls.filter(x => x === 'publish').length, 2);
  assert.equal(client.posts.get('77').status, 'LIVE');
});

test('unreadable publish records degrade to an offline list with a warning instead of aborting', async t => {
  const { root } = await setup(t);
  await mkdir(join(root, '.blogger'), { recursive: true });
  for (const content of [JSON.stringify({ version: 1, blogId: '999', posts: {} }), 'not json']) {
    await writeFile(join(root, '.blogger/state.json'), content);
    const warnings = [];
    const rows = await listArticles(root, env, message => warnings.push(message));
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.record === undefined));
    assert.equal(warnings.length, 1);
  }
});

test('a snapshot may be just the id and fingerprint the user saw, and a stale fingerprint is refused', async t => {
  const { root, client, options } = await setup(t);
  const seen = (await listArticles(root, env)).find(row => row.post.meta.id === 'a');
  assert.match(seen.fingerprint, /^[a-f0-9]{64}$/);
  const snapshot = { id: 'a', fingerprint: seen.fingerprint };
  assert.match(await readFile(await previewArticle(root, snapshot), 'utf8'), /這是審稿內容/);
  assert.equal((await publishArticle(root, snapshot, 'draft', options)).status, 'DRAFT');
  await writeFile(join(root, 'posts/a.md'), document('a', '文章 A', {}, '看過之後又被改了。'));
  await assert.rejects(publishArticle(root, snapshot, 'draft', options), /已變更/);
  await assert.rejects(previewArticle(root, { id: 'missing', fingerprint: seen.fingerprint }), /已變更或移除/);
  assert.equal(client.calls.filter(x => x === 'insert').length, 1);
});

test('remote check reports the real Blogger status next to a stale local record', async t => {
  const { root, snapshot, client, options } = await setup(t);
  await publishArticle(root, snapshot, 'draft', options);
  client.posts.get('77').status = 'LIVE'; // 使用者在 Blogger 後台手動公開；本機紀錄仍是 DRAFT
  const offline = (await listArticles(root, env)).find(row => row.post.meta.id === 'a');
  assert.equal(offline.record.status, 'DRAFT');
  assert.equal(offline.remote, undefined);
  const warnings = [];
  const rows = await listArticles(root, env, message => warnings.push(message), { remote: true, client });
  assert.equal(rows.find(row => row.post.meta.id === 'a').remote.status, 'LIVE');
  assert.equal(rows.find(row => row.post.meta.id === 'a').record.status, 'DRAFT'); // 只顯示，不改寫發布紀錄
  assert.equal(rows.find(row => row.post.meta.id === 'b').remote, undefined);
  assert.deepEqual(warnings, []);
});

test('remote check keeps the list usable when one post is gone or credentials are missing', async t => {
  const { root, snapshot, client, options } = await setup(t);
  await publishArticle(root, snapshot, 'draft', options);
  client.posts.delete('77');
  const rows = await listArticles(root, env, () => {}, { remote: true, client });
  assert.match(rows.find(row => row.post.meta.id === 'a').remote.error, /404/);
  const warnings = [];
  // 明確指到不存在的檔案：否則會讀到專案根目錄真正的 credentials/token.json 並連線 Google。
  const noCredentials = { ...env, GOOGLE_TOKEN_FILE: join(root, 'missing.json') };
  const offline = await listArticles(root, noCredentials, message => warnings.push(message), { remote: true });
  assert.equal(offline.length, 2);
  assert.equal(offline.find(row => row.post.meta.id === 'a').remote, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /遠端/);
});

const digest = 'a'.repeat(64);
const videoPacket = job => ({
  version: 1, job, category: 'husky', video_sha256: digest, source_hash: 'b'.repeat(64),
  title: 'Husky 影片', summary: '兩隻 Husky 的互動。', markdown: '## 內容介紹\n\n故事。\n\n## 推薦觀看理由\n\n角色互動。',
  review_status: 'approved', approved_sha256: digest, youtube_id: 'jNQXAC9IVRw', youtube_sha256: digest,
  facebook_reel: { video_id: '123', phase: 'draft', sha256: digest },
});

// 模擬 videoMaker TUI 的 b：匯入、核准後上傳草稿，回傳可供 publishArticle 使用的快照。
async function uploadedVideo(root, client, job) {
  const post = await saveVideoPost(root, videoPacket(job), { upload: true });
  const store = await FileState.load(join(root, '.blogger/state.json'), client.blogId);
  await runPipeline({ root, posts: [{ ...post, meta: { ...post.meta, publish: true } }], config: {}, noAI: true, blogger: client, store, log: () => {} });
  const snapshot = (await listArticles(root, env)).find(row => row.post.meta.id === post.meta.id).post;
  return { post, snapshot };
}

test('a video draft verified by the video pipeline can be published without editing the local Markdown', async t => {
  const { root, client, options } = await setup(t);
  const { post, snapshot } = await uploadedVideo(root, client, '2026-11-09_husky-tui');
  assert.equal((await publishArticle(root, snapshot, 'published', options)).status, 'LIVE');
  assert.match(await readFile(join(root, post.path), 'utf8'), /"publish": false/);
});

test('a failed video publish keeps the verified journal so the same publish can be retried', async t => {
  const { root, client, options } = await setup(t);
  const { snapshot } = await uploadedVideo(root, client, '2026-11-09_husky-retry');
  const publish = client.publish.bind(client);
  client.publish = async () => { throw new Error('Blogger 逾時'); };
  await assert.rejects(publishArticle(root, snapshot, 'published', options), /逾時/);
  client.publish = publish;
  assert.equal((await publishArticle(root, snapshot, 'published', options)).status, 'LIVE');
});
