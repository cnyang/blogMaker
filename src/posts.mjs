import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative, dirname } from 'node:path';
import { Marked } from 'marked';

export const FORMAT_VERSION = 1;
const fields = new Set(['id', 'title', 'publish', 'status', 'ai', 'labels', 'summary', 'post_id', 'date', 'tags', 'kind', 'description', 'category']);

// 只接受下表的影片 shortcode，維持 raw HTML 跳脫與兒童站的 nocookie 網域。
// 新增一種只要加一列；id 的格式限制就是安全邊界（iframe 網址只由固定網域加 id 組成）。
const shortcodes = {
  youtube: {
    pattern: /^\{\{<\s*youtube\s+id="([A-Za-z0-9_-]{11})"(?:\s+loading="lazy")?\s*>}}[^\S\n]*(?:\n|$)/,
    error: '僅支援獨立一行的 YouTube shortcode，id 必須是 11 個英數字、底線或連字號',
    html: id => `<iframe src="https://www.youtube-nocookie.com/embed/${id}" title="YouTube 影片" loading="lazy" style="width:100%;aspect-ratio:16/9;border:0" allowfullscreen></iframe>\n`,
  },
  facebook: {
    pattern: /^\{\{<\s*facebook\s+id="(\d+)"\s*>}}[^\S\n]*(?:\n|$)/,
    error: 'Facebook shortcode 必須使用純數字影片 ID，並獨立一行',
    html: id => `<iframe src="https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(`https://www.facebook.com/watch/?v=${id}`)}&amp;show_text=false" title="Facebook 影片" loading="lazy" style="width:100%;aspect-ratio:9/16;max-height:640px;border:0" allowfullscreen></iframe>\n`,
  },
};

// Hugo 沒有 facebook shortcode；只有不進 Hugo 站的 posts/video 影片文章可使用，其他文章一律拒絕以免網站建置失敗。
export const allowsFacebook = post => post.path.startsWith('posts/video/');

const shortcode = allowFacebook => ({
  name: 'shortcode', level: 'block',
  start(source) { return source.indexOf('{{<'); },
  tokenizer(source) {
    if (!source.startsWith('{{<')) return;
    const name = source.match(/^\{\{<\s*([A-Za-z]+)/)?.[1];
    if (name === 'facebook' && !allowFacebook) throw new Error('Facebook shortcode 只能用在 posts/video/ 的影片文章');
    if (!Object.hasOwn(shortcodes, name)) throw new Error('僅支援獨立一行的 YouTube 與 Facebook shortcode');
    const match = source.match(shortcodes[name].pattern);
    if (!match) throw new Error(shortcodes[name].error);
    return { type: 'shortcode', raw: match[0], name, id: match[1] };
  },
  renderer(token) { return shortcodes[token.name].html(token.id); },
});

export function normalizeMarkdown(text) {
  // Preserve indentation, hard line breaks and code block whitespace.
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\n*$/, '\n');
}

export function validateLabels(labels, name = 'labels') {
  if (!Array.isArray(labels) || labels.some(x => typeof x !== 'string' || !x.trim() || x.length > 40 || x.includes(','))) {
    throw new Error(`${name} 必須是非空字串陣列，每個最多 40 字且不含逗號`);
  }
  const result = [...new Set(labels.map(x => x.trim()))];
  if (result.length > 20) throw new Error(`${name} 最多 20 個`);
  return result;
}

export function parsePost(text, path = 'article.md') {
  const source = normalizeMarkdown(text);
  const match = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) throw new Error(`${path}: 缺少 JSON front matter（參考 posts/example.md）`);
  let meta;
  try { meta = JSON.parse(match[1]); }
  catch { throw new Error(`${path}: front matter 必須是有效 JSON，不支援 YAML 簡寫`); }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error(`${path}: metadata 必須是物件`);
  for (const key of Object.keys(meta)) if (!fields.has(key)) throw new Error(`${path}: 未知欄位 ${key}`);
  if (typeof meta.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(meta.id)) {
    throw new Error(`${path}: id 須為 1–80 個英數字、底線或連字號`);
  }
  if (typeof meta.title !== 'string' || !meta.title.trim() || meta.title.length > 200) throw new Error(`${path}: 缺少標題或標題超過 200 字`);
  if (typeof meta.publish !== 'boolean') throw new Error(`${path}: publish 必須明確填 true 或 false`);
  if (meta.status !== undefined && !['draft', 'published'].includes(meta.status)) throw new Error(`${path}: status 只能填 draft 或 published`);
  if (meta.ai !== undefined && typeof meta.ai !== 'boolean') throw new Error(`${path}: ai 必須是布林值`);
  if (meta.summary !== undefined && (typeof meta.summary !== 'string' || meta.summary.length > 400)) throw new Error(`${path}: summary 必須是最多 400 字的字串`);
  if (meta.post_id !== undefined && (typeof meta.post_id !== 'string' || !/^\d+$/.test(meta.post_id))) throw new Error(`${path}: post_id 必須是引號包住的數字字串`);
  for (const key of ['date', 'description']) {
    if (meta[key] !== undefined && typeof meta[key] !== 'string') throw new Error(`${path}: ${key} 必須是字串`);
  }
  if (meta.kind !== undefined && !['music', 'facts', 'english'].includes(meta.kind)) throw new Error(`${path}: kind 只能填 music、facts 或 english`);
  if (meta.category !== undefined && !['kids', 'husky', 'tech'].includes(meta.category)) throw new Error(`${path}: category 只能填 kids、husky 或 tech`);
  const tags = validateLabels(meta.tags ?? [], 'tags');
  let body = match[2].replace(/^\n+/, '');
  // Blogger already renders the title. Remove only an identical leading H1.
  const firstHeading = body.match(/^# ([^\n]+)\n(?:\n|$)/);
  if (firstHeading?.[1].trim() === meta.title.trim()) body = body.slice(firstHeading[0].length);
  if (!body.trim()) throw new Error(`${path}: 正文不可為空`);
  return {
    path, meta: { ...meta, title: meta.title.trim(), status: meta.status ?? 'published', ai: meta.ai ?? true, labels: validateLabels([...validateLabels(meta.labels ?? []), ...tags]) },
    body: normalizeMarkdown(body),
  };
}

export async function loadPosts(root) {
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const paths = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) paths.push(...await walk(path));
      else if (entry.isFile() && entry.name.endsWith('.md')) paths.push(path);
    }
    return paths;
  }
  const paths = [];
  for (const source of ['posts', 'kids/content/posts', 'tech/content/posts']) {
    try { paths.push(...await walk(join(root, source))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const posts = [];
  const ids = new Set();
  const postIds = new Set();
  for (const path of paths) {
    const post = parsePost(await readFile(path, 'utf8'), relative(root, path));
    if (ids.has(post.meta.id)) throw new Error(`重複文章 id: ${post.meta.id}`);
    ids.add(post.meta.id);
    if (post.meta.post_id) {
      if (postIds.has(post.meta.post_id)) throw new Error(`重複 Blogger post_id: ${post.meta.post_id}`);
      postIds.add(post.meta.post_id);
    }
    posts.push(post);
  }
  return posts;
}

export function fingerprint(post, { prompt, model, noAI = false }) {
  const useAI = post.meta.ai && !noAI;
  return createHash('sha256').update(JSON.stringify({ version: FORMAT_VERSION, meta: post.meta, body: post.body, useAI, prompt: useAI ? prompt : '', model: useAI ? model : '' })).digest('hex');
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[x]);
}

function allowedUrl(url, image = false) {
  if (!image && /^#[\w\p{L}\p{N}%-]+$/u.test(url)) return true;
  if (/[\u0000-\u0020]/u.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (image ? ['https:', 'http:'] : ['https:', 'http:', 'mailto:']).includes(parsed.protocol);
  } catch { return false; }
}

export function protectedContent(body) {
  const values = [];
  const parser = new Marked({ extensions: [shortcode(true)] }); // 只比對 token，是否允許由 renderBody 決定
  parser.walkTokens(parser.lexer(body), token => {
    if (token.type === 'code') values.push(JSON.stringify(['code', token.lang ?? '', token.text]));
    if (token.type === 'codespan') values.push(JSON.stringify(['codespan', token.text]));
    if (['link', 'image'].includes(token.type)) values.push(JSON.stringify([token.type, token.href]));
    if (token.type === 'shortcode') values.push(JSON.stringify([token.name, token.id]));
  });
  return values.sort();
}

export function renderBody(body, { facebook: allowFacebook = false } = {}) {
  const headings = new Map();
  const parser = new Marked({
    gfm: true,
    extensions: [shortcode(allowFacebook)],
    renderer: {
      html({ text }) { return escapeHtml(text); },
      link({ href, title, tokens }) {
        if (!allowedUrl(href)) throw new Error(`連結需使用完整 http(s)/mailto URL 或頁內錨點: ${href}`);
        return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${this.parser.parseInline(tokens)}</a>`;
      },
      image({ href, title, text }) {
        if (!allowedUrl(href, true)) throw new Error(`圖片需使用公開 http(s) URL，請先上傳圖片: ${href}`);
        return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}" loading="lazy" style="max-width:100%;height:auto"${title ? ` title="${escapeHtml(title)}"` : ''}>`;
      },
      code({ text, lang }) {
        const language = (lang ?? '').split(/\s/)[0];
        return `<pre style="overflow-x:auto;padding:1em;background:#f5f5f5"><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(text)}\n</code></pre>\n`;
      },
      heading({ depth, text, tokens }) {
        const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
        const count = headings.get(base) ?? 0;
        headings.set(base, count + 1);
        const id = count ? `${base}-${count + 1}` : base;
        return `<h${depth} id="${escapeHtml(id)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
    },
  });
  return parser.parse(body);
}

export function renderPost(post, edited, hash) {
  const summary = post.meta.summary ?? edited.summary;
  const labels = validateLabels([...post.meta.labels, ...edited.labels]);
  const content = `${summary ? `<p><strong>摘要：</strong>${escapeHtml(summary)}</p>\n<!--more-->\n` : ''}${renderBody(edited.markdown, { facebook: allowsFacebook(post) })}\n<!-- blogger-pipeline:id=${post.meta.id};source=${hash} -->`;
  return { title: post.meta.title, content, labels };
}

export async function writePreview(root, post, edited, payload) {
  const dir = join(root, 'build');
  await mkdir(dir, { recursive: true });
  const prefix = join(dir, post.meta.id);
  await writeFile(`${prefix}.md`, edited.markdown);
  await writeFile(`${prefix}.json`, JSON.stringify({ ...payload, summary: post.meta.summary ?? edited.summary, status: post.meta.status }, null, 2) + '\n');
  await writeFile(`${prefix}.html`, `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(payload.title)}</title><style>body{max-width:780px;margin:40px auto;padding:0 20px;font:18px/1.8 system-ui;color:#253044}table{border-collapse:collapse}th,td{border:1px solid #ccd1d8;padding:8px 12px}blockquote{border-left:4px solid #ccd1d8;padding-left:1em}a{color:#215dbc}img{max-width:100%}</style><h1>${escapeHtml(payload.title)}</h1>${payload.content}</html>`);
}

export async function createPost(root, title, site) {
  if (!title?.trim() || title.length > 200) throw new Error('請提供 1–200 字的文章標題');
  if (site !== undefined && !['kids', 'tech'].includes(site)) throw new Error('site 只能填 kids 或 tech');
  const id = randomUUID();
  const path = resolve(root, ...(site ? [site, 'content'] : []), 'posts', `${id}.md`);
  await mkdir(dirname(path), { recursive: true });
  const meta = { id, title: title.trim(), publish: false, status: 'published', ai: true, labels: [] };
  if (site) Object.assign(meta, { date: new Date().toISOString().slice(0, 10), labels: [site === 'kids' ? '兒童' : '技術'], ...(site === 'kids' ? { kind: 'facts' } : {}) });
  await writeFile(path, `---\n${JSON.stringify(meta, null, 2)}\n---\n\n在這裡開始撰寫文章。\n`, { flag: 'wx' });
  return path;
}
