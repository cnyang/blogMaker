import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePost, normalizeMarkdown, renderBody, fingerprint, loadPosts, createPost, protectedContent } from '../src/posts.mjs';

const meta = { id: 'hello', title: '測試文章', publish: true, labels: ['技術'] };
const doc = (body, fields = {}) => `---\n${JSON.stringify({ ...meta, ...fields })}\n---\n\n${body}\n`;

test('parse metadata, remove duplicate title, preserve code and hard line breaks', () => {
  const post = parsePost(doc('# 測試文章\n\n段落  \n換行\n\n```js\n  const x = 1;  \n```').replaceAll('\n', '\r\n'));
  assert.equal(post.meta.status, 'published');
  assert.equal(post.meta.ai, true);
  assert.match(post.body, /^段落  \n/);
  assert.match(post.body, /  const x = 1;  \n/);
  assert.equal(normalizeMarkdown(post.body), post.body);
});

test('metadata rejects ambiguous booleans, typos and invalid identifiers', () => {
  for (const fields of [{ publish: 'true' }, { id: '../escape' }, { status: 'live' }, { ai: 'false' }, { publsh: true }, { post_id: 123 }]) {
    assert.throws(() => parsePost(doc('內容', fields)));
  }
  assert.throws(() => parsePost('---\nid: hello\n---\n內容'), /JSON/);
  assert.throws(() => parsePost(doc('   ')), /正文/);
});

test('GFM rendering supports tables and escaped code without JavaScript', () => {
  const html = renderBody('## 標題\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```html\n<script>alert(1)</script>\n```\n\n<script>alert(2)</script>');
  assert.match(html, /<table>/);
  assert.match(html, /<h2 id="標題">/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('links and images require usable public URLs', () => {
  assert.match(renderBody('![圖](https://example.com/a.png)\n\n[連結](https://example.com)'), /loading="lazy"/);
  for (const body of ['[點我](javascript:alert%281%29)', '[文章](./other.md)', '![圖片](./a.png)', '![圖](data:image/png;base64,aaaa)']) {
    assert.throws(() => renderBody(body));
  }
});

test('fingerprint changes for source, prompt and AI model but ignores AI config when disabled', () => {
  const post = parsePost(doc('內容'));
  const opts = { prompt: 'a', model: 'model-a' };
  const hash = fingerprint(post, opts);
  assert.notEqual(hash, fingerprint(post, { ...opts, model: 'b' }));
  assert.notEqual(hash, fingerprint(post, { ...opts, prompt: 'b' }));
  assert.notEqual(hash, fingerprint(parsePost(doc('新內容')), opts));
  assert.equal(fingerprint(post, { ...opts, noAI: true }), fingerprint(post, { prompt: 'other', model: 'b', noAI: true }));
});

test('reject duplicate IDs before publication even when paths differ', async t => {
  const root = await mkdtemp(join(tmpdir(), 'blogger-posts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'posts'));
  await writeFile(join(root, 'posts/a.md'), doc('A'));
  await writeFile(join(root, 'posts/b.md'), doc('B'));
  await assert.rejects(loadPosts(root), /重複文章 id/);
});

test('shared metadata preserves Hugo fields and merges tags into Blogger labels', () => {
  const post = parsePost(doc('內容', { date: '2026-11-06', kind: 'facts', description: '簡介', tags: ['Hugo', '技術'] }));
  assert.equal(post.meta.date, '2026-11-06');
  assert.equal(post.meta.kind, 'facts');
  assert.equal(post.meta.description, '簡介');
  assert.deepEqual(post.meta.labels, ['技術', 'Hugo']);
  for (const fields of [{ kind: 'unknown' }, { tags: 'Hugo' }, { date: 2026 }, { description: true }, { labels: '技術' }]) {
    assert.throws(() => parsePost(doc('內容', fields)));
  }
});

test('new posts and both Hugo sites share discovery and reject cross-site duplicate IDs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'blogmaker-sites-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = [];
  for (const site of [undefined, 'kids', 'tech']) paths.push(await createPost(root, '新文章', site));
  const posts = await loadPosts(root);
  assert.equal(posts.length, 3);
  assert.ok(posts.every(post => post.meta.publish === false));
  const kids = posts.find(post => post.path.startsWith('kids/'));
  assert.equal(kids.meta.kind, 'facts');
  assert.deepEqual(kids.meta.labels, ['兒童']);
  assert.match(kids.meta.date, /^\d{4}-\d{2}-\d{2}$/);
  await assert.rejects(createPost(root, '標題', '../escape'), /site/);
  await writeFile(paths[2], await readFile(paths[1], 'utf8'));
  await assert.rejects(loadPosts(root), /重複文章 id/);
});

test('Facebook shortcode accepts spacing variants and reports Facebook-specific errors', () => {
  for (const code of ['{{<facebook id="123">}}', '{{<  facebook  id="123"  >}}']) {
    assert.match(renderBody(`${code}\n`, { facebook: true }), /facebook\.com\/plugins\/video\.php/);
    assert.throws(() => renderBody(`${code}\n`), /posts\/video/);
  }
  assert.throws(() => renderBody('{{<facebook id="bad">}}\n', { facebook: true }), /Facebook shortcode 必須/);
  assert.deepEqual(protectedContent('{{<facebook id="123">}}\n'), [JSON.stringify(['facebook', '123'])]);
});

test('YouTube shortcodes embed with nocookie, preserve IDs and keep code examples as text', () => {
  const shortcode = '{{< youtube id="jNQXAC9IVRw" loading="lazy" >}}';
  const html = renderBody(`段落\n\n${shortcode}\n\n後續內容`);
  assert.match(html, /src="https:\/\/www.youtube-nocookie.com\/embed\/jNQXAC9IVRw"/);
  assert.match(html, /後續內容/);
  assert.deepEqual(protectedContent(`${shortcode}\n`), [JSON.stringify(['youtube', 'jNQXAC9IVRw'])]);
  assert.doesNotMatch(renderBody(`\`\`\`text\n${shortcode}\n\`\`\``), /<iframe/);
  assert.throws(() => renderBody('{{< youtube id="bad" >}}\n'), /shortcode/);
  assert.throws(() => renderBody('{{< include file="private" >}}\n'), /shortcode/);
});
