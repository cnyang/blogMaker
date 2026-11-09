import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { saveVideoPost } from '../src/video.mjs';
import { runPipeline } from '../src/pipeline.mjs';
import { FileState } from '../src/state.mjs';
import { listArticles, previewArticle, publishArticle } from '../src/article-actions.mjs';
import { runTui, renderTui, terminalText } from '../src/tui.mjs';

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

function terminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  const output = new PassThrough();
  Object.assign(output, { isTTY: true, columns: 100, rows: 26 });
  let text = '';
  output.on('data', chunk => { text += chunk.toString(); });
  const wait = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate(text)) {
      if (Date.now() > deadline) throw new Error('TUI 畫面沒有出現預期結果：' + text.slice(-600));
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  return { input, output, wait, text: () => text };
}

test('keyboard UI reads, filters, previews, cancels drafts and requires the complete public confirmation', async t => {
  const { root, client } = await setup(t);
  const ui = terminal();
  const opened = [];
  const done = runTui({ root, input: ui.input, output: ui.output, env, client, opener: async path => { opened.push(path); } });
  t.after(() => { ui.input.end(); });
  await ui.wait(text => text.includes('Enter 閱讀內容'));
  ui.input.write('c');
  await ui.wait(text => text.includes('Tech 1 篇'));
  ui.input.write('\r');
  await ui.wait(text => text.includes('這是審稿內容'));
  // 單獨的 Esc 要等 readline 的逃脫序列逾時才會生效；等畫面真的回到列表（出現新的列表頁尾），再按下一個鍵，
  // 否則會被當成 Meta+p。不用固定 sleep，避免 CI 負載高時誤判。
  const mark = ui.text().length;
  ui.input.write('\x1b');
  await ui.wait(text => text.slice(mark).includes('c 分類'));
  ui.input.write('p');
  await ui.wait(text => text.includes('已開啟預覽'));
  assert.equal(opened.length, 1);
  assert.match(await readFile(opened[0], 'utf8'), /這是審稿內容/);
  ui.input.write('un');
  await ui.wait(text => text.includes('已取消，沒有上傳'));
  assert.deepEqual(client.calls, []);
  ui.input.write('uy');
  await ui.wait(text => text.includes('已儲存草稿：文章 A'));
  ui.input.write('P\r');
  await ui.wait(text => text.includes('確認文字不符'));
  assert.equal(client.calls.includes('publish'), false);
  ui.input.write('PUBLISH\r');
  await ui.wait(text => text.includes('已公開：文章 A'));
  assert.equal(client.calls.filter(x => x === 'publish').length, 1);
  ui.input.write('q');
  await done;
  assert.equal(ui.input.isRaw, false);
  assert.match(ui.text(), /\x1b\[\?25h\x1b\[\?1049l/);
});

test('Ctrl+C leaves the TUI and restores the terminal even while a sync is in flight', { timeout: 10_000 }, async t => {
  const { root, client } = await setup(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const insert = client.insertDraft.bind(client);
  client.insertDraft = async payload => { entered(); await gate; return insert(payload); };
  const ui = terminal();
  const done = runTui({ root, input: ui.input, output: ui.output, env, client });
  t.after(() => ui.input.end());
  await ui.wait(text => text.includes('Enter 閱讀內容'));
  ui.input.write('uy');
  await reached; // 同步已持有發布鎖並卡在遠端寫入
  ui.input.write('\x03');
  await done;
  assert.equal(ui.input.isRaw, false);
  assert.match(ui.text(), /\x1b\[\?25h\x1b\[\?1049l/);
  assert.match(ui.text(), /同步尚未完成/);
  // 放行背景中的同步，等發布鎖釋放後才讓 t.after 清掉暫存目錄
  release();
  const lock = join(root, '.blogger/publish.lock');
  while (await access(lock).then(() => true, () => false)) await new Promise(resolve => setTimeout(resolve, 5));
});

test('a successful sync is reported as success even when the follow-up refresh fails', async t => {
  const { root, client } = await setup(t);
  const insert = client.insertDraft.bind(client);
  // 遠端寫入前才出現壞檔：同步本身成功，之後的重新整理必然失敗
  client.insertDraft = async payload => { await writeFile(join(root, 'posts/bad.md'), '沒有 front matter'); return insert(payload); };
  const ui = terminal();
  const done = runTui({ root, input: ui.input, output: ui.output, env, client });
  t.after(() => ui.input.end());
  await ui.wait(text => text.includes('Enter 閱讀內容'));
  ui.input.write('uy');
  await ui.wait(text => text.includes('已儲存草稿：文章 A'));
  assert.match(ui.text(), /重新整理失敗/);
  ui.input.write('q');
  await done;
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
  const state = { entries: [], category: 'all', index: 0, view: 'list', message: '', blogId: '123', warning: '發布紀錄的 blog ID 不同' };
  assert.match(renderTui(state), /發布紀錄無法讀取/);
});

test('terminal rendering strips article control sequences and supports small-terminal recovery', () => {
  assert.equal(terminalText('標題\x1b[2J\x1b]0;owned\x07\x00\x9b'), '標題');
  const state = { entries: [], category: 'all', index: 0, view: 'list', message: '', blogId: '' };
  assert.match(renderTui(state, { columns: 25, rows: 8 }), /放大終端機/);
  assert.match(renderTui(state), /沒有符合分類/);
  assert.ok(renderTui(state, { columns: 40, rows: 12 }).split('\r\n').length <= 12);
});

// 測試用的顯示寬度：漢字、假名、諺文、CJK 標點與全形空白（U+3000）、全形符號都佔 2 欄。
const cells = text => [...text].reduce((sum, c) => sum + (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〾！-｠￠-￦]/u.test(c) ? 2 : 1), 0);

test('terminal rendering counts CJK punctuation and ideographic spaces as two columns', () => {
  const item = { post: { meta: { id: 'a', title: '「標題」，《測試》。【全形】、標點！', labels: [] }, path: 'a.md', body: '' }, category: 'tech', changed: false };
  const state = { entries: [item], category: 'all', index: 0, scroll: 0, view: 'list', pending: null, message: '全形空白　分隔　測試　訊息　很長很長很長', blogId: '123' };
  for (const columns of [40, 41, 60]) {
    for (const line of renderTui(state, { columns, rows: 12 }).split('\r\n')) assert.ok(cells(line) <= columns, `${cells(line)} > ${columns}：${line}`);
  }
});

test('TUI rejects pipes with a usable error instead of leaving the input in raw mode', async () => {
  await assert.rejects(runTui({ input: new PassThrough(), output: new PassThrough() }), /互動式終端機/);
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

test('confirmation cannot be submitted when a resized terminal hides its contents', async t => {
  const { root, client } = await setup(t);
  const ui = terminal();
  const done = runTui({ root, input: ui.input, output: ui.output, env, client });
  t.after(() => ui.input.end());
  await ui.wait(text => text.includes('Enter 閱讀內容'));
  ui.input.write('u');
  ui.output.columns = 40;
  ui.output.rows = 12;
  ui.output.emit('resize');
  await ui.wait(text => text.includes('請放大終端機以顯示完整確認內容'));
  ui.input.write('y');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(client.calls, []);
  ui.input.write('nq');
  await done;
});

test('publication errors stay readable in a scrollable view and the UI returns to the list', async t => {
  const { root, client } = await setup(t);
  client.findManaged = async () => { throw new Error('Blogger HTTP 401\n請完成 OAuth 授權後重試。\n這是詳細錯誤的最後一行。'); };
  const ui = terminal();
  const done = runTui({ root, input: ui.input, output: ui.output, env, client });
  t.after(() => ui.input.end());
  await ui.wait(text => text.includes('Enter 閱讀內容'));
  ui.input.write('uy');
  await ui.wait(text => text.includes('這是詳細錯誤的最後一行。'));
  assert.equal(client.posts.size, 0);
  ui.input.write('qq');
  await done;
  assert.equal(ui.input.isRaw, false);
});
