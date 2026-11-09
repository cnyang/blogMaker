import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runArticleCli } from '../src/article-cli.mjs';

const env = { BLOGGER_BLOG_ID: '123' };
const document = (id, title, body = '這是審稿內容。') => `---\n${JSON.stringify({ id, title, publish: false, status: 'draft', ai: true, category: 'tech', date: '2026-11-09', labels: ['技術'] })}\n---\n\n${body}\n`;

class Blogger {
  blogId = '123'; posts = new Map();
  async get(id) { if (!this.posts.has(id)) throw new Error('Blogger HTTP 404'); return structuredClone(this.posts.get(id)); }
  async findManaged() { return new Map(); }
  async insertDraft(payload) { const post = { ...payload, id: '77', status: 'DRAFT', url: 'https://example.test/77' }; this.posts.set('77', post); return structuredClone(post); }
  async update() { throw new Error('unexpected'); }
  async publish(id) { this.posts.get(id).status = 'LIVE'; return this.get(id); }
  async revert() { throw new Error('不得取消公開'); }
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'blogmaker-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'posts'));
  await writeFile(join(root, 'posts/a.md'), document('a', '文章 A'));
  return { root, client: new Blogger(), options: { env } };
}

const run = (root, args, options) => runArticleCli(['--root', root, ...args], options);

test('list returns what the TUI needs, including the fingerprint of the version it shows', async t => {
  const { root, client } = await setup(t);
  const result = await run(root, ['list'], { env, client });
  assert.equal(result.blogId, '123');
  assert.deepEqual(result.warnings, []);
  const [article] = result.articles;
  assert.deepEqual({ id: article.id, title: article.title, category: article.category, labels: article.labels, record: article.record, changed: article.changed, remote: article.remote },
    { id: 'a', title: '文章 A', category: 'tech', labels: ['技術'], record: null, changed: false, remote: null });
  assert.match(article.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(article.body, /這是審稿內容/);
  assert.equal(typeof article.path, 'string');
});

test('preview and publish act only on the version identified by id and fingerprint', async t => {
  const { root, client } = await setup(t);
  const [{ fingerprint }] = (await run(root, ['list'], { env, client })).articles;
  const { path } = await run(root, ['preview', '--id', 'a', '--fingerprint', fingerprint], { env, client });
  assert.match(await readFile(path, 'utf8'), /這是審稿內容/);
  const draft = await run(root, ['publish', '--id', 'a', '--fingerprint', fingerprint, '--status', 'draft'], { env, client });
  assert.deepEqual({ postId: draft.postId, status: draft.status }, { postId: '77', status: 'DRAFT' });
  await writeFile(join(root, 'posts/a.md'), document('a', '文章 A', '看過之後又被改了。'));
  await assert.rejects(run(root, ['publish', '--id', 'a', '--fingerprint', fingerprint, '--status', 'published'], { env, client }), /已變更/);
  assert.equal(client.posts.get('77').status, 'DRAFT');
});

test('list with --remote shows the real status; the draft action still refuses to unpublish', async t => {
  const { root, client } = await setup(t);
  const [{ fingerprint }] = (await run(root, ['list'], { env, client })).articles;
  await run(root, ['publish', '--id', 'a', '--fingerprint', fingerprint, '--status', 'draft'], { env, client });
  client.posts.get('77').status = 'LIVE';
  const [article] = (await run(root, ['list', '--remote'], { env, client })).articles;
  assert.equal(article.record.status, 'DRAFT');
  assert.equal(article.remote.status, 'LIVE');
  await assert.rejects(run(root, ['publish', '--id', 'a', '--fingerprint', fingerprint, '--status', 'draft'], { env, client }), /取消公開/);
});

test('bad commands, ids, fingerprints and statuses are rejected before any remote call', async t => {
  const { root, client } = await setup(t);
  const good = 'a'.repeat(64);
  await assert.rejects(run(root, [], { env, client }), /用法/);
  await assert.rejects(run(root, ['delete'], { env, client }), /用法/);
  await assert.rejects(run(root, ['preview', '--fingerprint', good], { env, client }), /id/);
  await assert.rejects(run(root, ['preview', '--id', 'a', '--fingerprint', 'short'], { env, client }), /fingerprint/);
  await assert.rejects(run(root, ['publish', '--id', 'a', '--fingerprint', good, '--status', 'scheduled'], { env, client }), /發布狀態/);
  assert.equal(client.posts.size, 0);
});
