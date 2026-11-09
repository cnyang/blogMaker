import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePost } from '../src/posts.mjs';
import { FileState, withPublishLock } from '../src/state.mjs';
import { runPipeline } from '../src/pipeline.mjs';

const config = { prompt: 'test', model: 'test-model', apiKey: 'test' };
function post(fields = {}, body = '正文內容。') {
  return parsePost(`---\n${JSON.stringify({ id: 'article', title: '文章標題', publish: true, ai: true, ...fields })}\n---\n${body}`);
}
class FakeBlogger {
  constructor() { this.posts = new Map(); this.calls = []; this.next = 100; this.failPublish = false; }
  async get(id) { this.calls.push('get'); if (!this.posts.has(id)) throw new Error('Blogger HTTP 404'); return structuredClone(this.posts.get(id)); }
  async findManaged() {
    this.calls.push('list');
    return new Map([...this.posts.values()].map(p => [p.content.match(/id=([^;]+);/)[1], structuredClone(p)]));
  }
  async insertDraft(payload) {
    this.calls.push('insert');
    const p = { ...payload, id: String(this.next++), status: 'DRAFT', url: 'https://example.test/post' };
    this.posts.set(p.id, p); return structuredClone(p);
  }
  async update(id, payload) { this.calls.push('update'); Object.assign(this.posts.get(id), payload); return structuredClone(this.posts.get(id)); }
  async publish(id) {
    this.calls.push('publish');
    if (this.failPublish) throw new Error('simulated publish failure');
    this.posts.get(id).status = 'LIVE'; return structuredClone(this.posts.get(id));
  }
  async revert(id) { this.calls.push('revert'); this.posts.get(id).status = 'DRAFT'; return structuredClone(this.posts.get(id)); }
}
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'blogger-pipeline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await FileState.load(join(root, '.blogger/state.json'), '123');
  const blogger = new FakeBlogger();
  let aiCalls = 0;
  const editor = async p => { aiCalls++; return { markdown: p.body, summary: '摘要內容。', labels: ['AI'] }; };
  const run = (posts, extra = {}) => runPipeline({ root, posts, config, store, blogger, editor, log: () => {}, ...extra });
  return { root, store, blogger, run, aiCalls: () => aiCalls };
}

test('create → publish → unchanged skip → source update keeps the same post ID', async t => {
  const ctx = await setup(t);
  await ctx.run([post()]);
  assert.equal(ctx.blogger.posts.size, 1);
  assert.equal(ctx.store.get('article').status, 'LIVE');
  assert.ok(ctx.store.get('article').sourceHash);
  assert.match(await readFile(join(ctx.root, 'build/article.html'), 'utf8'), /摘要內容/);
  await ctx.run([post()]);
  assert.equal(ctx.aiCalls(), 1);
  await ctx.run([post({}, '修改後內容。')]);
  assert.equal(ctx.blogger.posts.size, 1);
  assert.equal(ctx.aiCalls(), 2);
  assert.ok(ctx.blogger.calls.includes('update'));
  assert.equal(ctx.store.get('article').postId, '100');
});

test('publish failure persists post ID and rerun recovers without another insert or AI call', async t => {
  const ctx = await setup(t);
  ctx.blogger.failPublish = true;
  await assert.rejects(ctx.run([post()]), /simulated/);
  const saved = await FileState.load(ctx.store.path, '123');
  assert.equal(saved.get('article').postId, '100');
  assert.equal(saved.get('article').sourceHash, null);
  ctx.blogger.failPublish = false;
  await ctx.run([post()], { store: saved });
  assert.equal(ctx.blogger.calls.filter(x => x === 'insert').length, 1);
  assert.equal(ctx.aiCalls(), 1);
  assert.equal(saved.get('article').status, 'LIVE');
});

test('remote marker recovers when state is absent', async t => {
  const ctx = await setup(t);
  await ctx.run([post()]);
  const empty = await FileState.load(join(ctx.root, 'new-state.json'), '123');
  await ctx.run([post()], { store: empty });
  assert.equal(empty.get('article').postId, '100');
  assert.equal(ctx.blogger.posts.size, 1);
  assert.equal(ctx.aiCalls(), 1);
});

test('insert that succeeds remotely but loses its response is recovered on the next run', async t => {
  const ctx = await setup(t);
  const insert = ctx.blogger.insertDraft.bind(ctx.blogger);
  ctx.blogger.insertDraft = async payload => {
    await insert(payload);
    throw new Error('response lost after remote creation');
  };
  await assert.rejects(ctx.run([post()]), /response lost/);
  assert.equal(ctx.store.get('article'), undefined);
  ctx.blogger.insertDraft = insert;
  await ctx.run([post()]);
  assert.equal(ctx.store.get('article').status, 'LIVE');
  assert.equal(ctx.blogger.calls.filter(x => x === 'insert').length, 1);
  assert.equal(ctx.aiCalls(), 1);
});

test('explicit post_id takes over an existing Blogger post without inserting another', async t => {
  const ctx = await setup(t);
  ctx.blogger.posts.set('777', { id: '777', title: '舊標題', content: '舊內容', status: 'LIVE' });
  await ctx.run([post({ post_id: '777' })]);
  assert.equal(ctx.store.get('article').postId, '777');
  assert.equal(ctx.blogger.posts.size, 1);
  assert.equal(ctx.blogger.calls.filter(x => x === 'insert').length, 0);
  assert.match(ctx.blogger.posts.get('777').content, /正文內容/);
});

test('explicit draft transition reverts a live post, then published restores it', async t => {
  const ctx = await setup(t);
  await ctx.run([post()]);
  await ctx.run([post({ status: 'draft' })]);
  assert.equal(ctx.store.get('article').status, 'DRAFT');
  await ctx.run([post({ status: 'published' })]);
  assert.equal(ctx.store.get('article').status, 'LIVE');
  assert.equal(ctx.blogger.posts.size, 1);
});

test('publish false excludes article; offline dry run includes it without API calls or state', async t => {
  const ctx = await setup(t);
  await ctx.run([post({ publish: false })]);
  assert.equal(ctx.blogger.calls.length, 0);
  await ctx.run([post({ publish: false })], { dryRun: true, noAI: true });
  assert.equal(ctx.blogger.calls.length, 0);
  assert.equal(ctx.aiCalls(), 0);
  assert.equal(ctx.store.get('article'), undefined);
  assert.match(await readFile(join(ctx.root, 'build/article.html'), 'utf8'), /正文內容/);
});

test('existing post 404 stops rather than creating a replacement', async t => {
  const ctx = await setup(t);
  await ctx.store.set('article', { postId: '999', sourceHash: null });
  await assert.rejects(ctx.run([post()]), /404/);
  assert.equal(ctx.blogger.posts.size, 0);
});

test('AI failure and invalid URLs stop before creating a Blogger post', async t => {
  const ctx = await setup(t);
  await assert.rejects(ctx.run([post()], { editor: async () => { throw new Error('AI failed'); } }), /AI failed/);
  await assert.rejects(ctx.run([post({ ai: false }, '![圖](relative.png)')]), /圖片/);
  assert.equal(ctx.blogger.posts.size, 0);
});

test('state corruption, cross-blog state and conflicting post ownership are rejected', async t => {
  const ctx = await setup(t);
  await ctx.store.set('article', { postId: '100', sourceHash: null });
  await assert.rejects(FileState.load(ctx.store.path, '456'), /blog ID/);
  await assert.rejects(ctx.store.set('other', { postId: '100', sourceHash: null }), /相同/);
  await writeFile(ctx.store.path, 'bad-json');
  await assert.rejects(FileState.load(ctx.store.path, '123'), /修復/);
});

test('local publication lock prevents concurrent publishers', async t => {
  const ctx = await setup(t);
  const path = join(ctx.root, '.blogger/lock');
  await withPublishLock(path, async () => {
    await assert.rejects(withPublishLock(path, async () => {}), /已有發布程序/);
  });
  await withPublishLock(path, async () => {});
});
