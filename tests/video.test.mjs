import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { videoPost, saveVideoPost, checkVideoDraft } from '../src/video.mjs';
import { renderBody, protectedContent } from '../src/posts.mjs';
import { runPipeline, validate } from '../src/pipeline.mjs';
import { importVideo, readStdin } from '../src/video-cli.mjs';
import { FileState } from '../src/state.mjs';

const digest = 'a'.repeat(64);
const packet = {
  version: 1, job: '2026-11-09_husky-snack', category: 'husky',
  video_sha256: digest, source_hash: 'b'.repeat(64),
  title: 'Husky 的點心故事', summary: '兩隻 Husky 的互動介紹。',
  markdown: '## 內容介紹\n\n兩隻 Husky 的點心故事。\n\n## 推薦觀看理由\n\n觀察角色互動。',
  review_status: 'approved', approved_sha256: digest,
  youtube_id: 'jNQXAC9IVRw', youtube_sha256: digest, youtube_privacy: 'private',
  facebook_reel: { video_id: '123456', phase: 'draft', sha256: digest },
  sources: [{ title: '參考資料', url: 'https://example.com/source', license: 'CC BY-SA 4.0' }],
};

test('video import creates categorized drafts with both real video links and protected embeds', () => {
  for (const category of ['kids', 'husky']) {
    const { post } = videoPost({ ...packet, category }, { upload: true });
    assert.equal(post.meta.category, category);
    assert.equal(post.meta.status, 'draft');
    assert.equal(post.meta.publish, false);
    assert.equal(post.meta.ai, false);
    assert.ok(post.path.startsWith(`posts/video/${category}/vmk-`));
    const html = renderBody(post.body, { facebook: true });
    assert.match(html, /youtube-nocookie.com\/embed\/jNQXAC9IVRw/);
    assert.match(html, /facebook.com\/plugins\/video.php/);
    assert.match(html, /facebook.com\/watch\/\?v=123456/);
    assert.match(html, /CC BY-SA 4.0/);
    assert.ok(protectedContent(post.body).includes(JSON.stringify(['facebook', '123456'])));
  }
});

test('offline article preview works before video approval or uploads without inventing links', () => {
  const { post } = videoPost({ ...packet, review_status: 'pending_review', youtube_id: null, facebook_reel: {} });
  assert.match(post.body, /YouTube 影片尚未上傳/);
  assert.match(post.body, /Facebook 影片尚未完成上傳/);
  assert.doesNotMatch(post.body, /{{</);
});

test('upload requires human approval and matching hashes for both completed platform uploads', () => {
  for (const fields of [
    { review_status: 'pending_review' }, { approved_sha256: null }, { youtube_id: null },
    { youtube_sha256: null }, { youtube_sha256: 'c'.repeat(64) },
    { facebook_reel: { ...packet.facebook_reel, phase: 'processing' } },
    { facebook_reel: { ...packet.facebook_reel, sha256: 'c'.repeat(64) } },
  ]) assert.throws(() => videoPost({ ...packet, ...fields }, { upload: true }));
});

test('video import rejects bad paths, unsupported categories, IDs and invented markup', () => {
  for (const fields of [
    { job: '../escape' }, { category: 'tech' }, { youtube_id: 'bad" onload="x' },
    { facebook_reel: { video_id: '1/../../x' } }, { markdown: packet.markdown + '\nhttps://invented.test' },
    { markdown: packet.markdown + '\n<iframe src="https://evil.test"></iframe>' }, { summary: '' },
    { sources: [{ title: 'x', url: 'javascript:alert(1)' }] },
    // license 不得夾帶連結、圖片、網址或信箱（GFM 會自動轉成連結）
    ...['CC [x](https://evil.test/)', '![x](https://evil.test/p.gif)', 'CC https://evil.test', 'www.evil.test', 'a@evil.test']
      .map(license => ({ sources: [{ title: 'x', url: 'https://example.com/source', license }] })),
  ]) assert.throws(() => videoPost({ ...packet, ...fields }));
  for (const license of [undefined, '', 'CC0', 'CC BY-SA 4.0', 'Apache-2.0']) {
    videoPost({ ...packet, sources: [{ title: 'x', url: 'https://example.com/source', license }] });
  }
  assert.throws(() => renderBody('{{< facebook id="bad" >}}\n', { facebook: true }), /純數字影片 ID/);
  assert.doesNotMatch(renderBody('```text\n{{< facebook id="123" >}}\n```'), /<iframe/);
});

test('repeated imports and draft uploads reuse one Blogger post and skip unchanged content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'blogmaker-video-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await saveVideoPost(root, packet, { upload: true });
  const again = await saveVideoPost(root, packet, { upload: true });
  assert.equal(first.meta.id, again.meta.id);
  assert.equal(first.body, again.body);
  const store = await FileState.load(join(root, '.blogger/state.json'), '99');
  const calls = [];
  const remote = new Map();
  const blogger = {
    findManaged: async () => new Map(), get: async id => remote.get(id),
    insertDraft: async payload => {
      calls.push('insert');
      remote.set('777', { ...payload, id: '777', status: 'DRAFT' });
      return remote.get('777');
    },
    publish: async () => { throw new Error('文章不可公開'); },
  };
  const run = post => {
    post.meta.publish = true;
    return runPipeline({ root, posts: [post], config: {}, noAI: true, store, blogger, log: () => {} });
  };
  assert.equal((await run(first))[0].status, 'DRAFT');
  assert.equal((await run(again))[0].action, 'skipped');
  assert.deepEqual(calls, ['insert']);
  assert.equal(JSON.parse((await readFile(join(root, first.path), 'utf8')).split('---\n')[1]).publish, false);
});

test('the same video job cannot be imported under a second category', async t => {
  const root = await mkdtemp(join(tmpdir(), 'blogmaker-video-category-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const kids = await saveVideoPost(root, { ...packet, category: 'kids' }, { upload: true });
  await assert.rejects(saveVideoPost(root, { ...packet, category: 'husky' }, { upload: true }), /kids/);
  await assert.rejects(access(join(root, 'posts/video/husky', `${kids.meta.id}.md`)), { code: 'ENOENT' });
  // 同分類重新匯入仍可更新同一篇
  assert.equal((await saveVideoPost(root, { ...packet, category: 'kids' }, { upload: true })).meta.id, kids.meta.id);
});

test('stdin packets keep multibyte characters that straddle chunk boundaries and stay under 1 MB', async () => {
  const bytes = Buffer.from('中中中中中');
  const split = Readable.from([bytes.subarray(0, 4), bytes.subarray(4)], { objectMode: false });
  assert.equal(await readStdin(split), '中中中中中');
  await assert.rejects(readStdin(Readable.from([Buffer.alloc(1_000_001, 97)], { objectMode: false })), /1 MB/);
});

test('Facebook shortcode is only accepted in posts/video articles', async t => {
  const root = await mkdtemp(join(tmpdir(), 'blogmaker-video-facebook-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const article = `---\n${JSON.stringify({ id: 'fb-test', title: 'x', publish: false, status: 'draft', ai: false })}\n---\n\n{{< facebook id="123" >}}\n`;
  // Hugo 沒有 facebook shortcode；手寫在 Hugo 內容會讓網站建置失敗，所以 validate 就要擋下。
  await mkdir(join(root, 'kids/content/posts'), { recursive: true });
  await writeFile(join(root, 'kids/content/posts/fb.md'), article);
  await assert.rejects(validate(root), /Facebook shortcode/);
  await rm(join(root, 'kids'), { recursive: true });
  await mkdir(join(root, 'posts/video/husky'), { recursive: true });
  await writeFile(join(root, 'posts/video/husky/fb.md'), article);
  assert.equal((await validate(root)).length, 1);
  assert.throws(() => renderBody('{{< facebook id="123" >}}\n'), /Facebook shortcode/);
});

test('video CLI accepts the Python packet contract on stdin and produces an offline HTML preview', async t => {
  const root = await mkdtemp(join(tmpdir(), 'blogmaker-video-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/video-cli.mjs', import.meta.url))], {
    cwd: root, input: JSON.stringify(packet), encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'preview');
  assert.match(await readFile(receipt.path, 'utf8'), /Facebook 影片/);
});

const videoId = videoPost(packet).post.meta.id;

test('draft upload through importVideo creates one Blogger draft and keeps publish false on disk', async t => {
  const root = await mkdtemp(join(tmpdir(), 'blogmaker-video-upload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = {
    blogId: '99', findManaged: async () => new Map(),
    insertDraft: async () => ({ id: '777', status: 'DRAFT', url: 'https://example.blogspot.com/draft' }),
  };
  const receipt = await importVideo({ root, packet, upload: true, client, log: () => {} });
  assert.equal(receipt.action, 'created');
  assert.equal(receipt.status, 'DRAFT');
  const file = await readFile(join(root, `posts/video/husky/${videoId}.md`), 'utf8');
  assert.equal(JSON.parse(file.split('---\n')[1]).publish, false);
});

test('a refused upload of a live article leaves the local Markdown untouched', async t => {
  const root = await mkdtemp(join(tmpdir(), 'blogmaker-video-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = await saveVideoPost(root, packet, { upload: true });
  const path = join(root, old.path);
  const before = await readFile(path, 'utf8');
  const client = {
    blogId: '99', findManaged: async () => new Map([[videoId, { id: '777', status: 'LIVE' }]]),
    revert: async () => { throw new Error('不可呼叫 revert'); },
  };
  const changed = { ...packet, markdown: `${packet.markdown}\n\n新增段落。` };
  await assert.rejects(importVideo({ root, packet: changed, upload: true, client, log: () => {} }), /取消公開/);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('an upload never reverts an article that went live after the draft check', async t => {
  const root = await mkdtemp(join(tmpdir(), 'blogmaker-video-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let scans = 0;
  const calls = [];
  const client = {
    blogId: '99',
    // 第一次掃描（checkVideoDraft）仍是草稿，第二次（管線）已被手動公開。
    findManaged: async () => new Map([[videoId, { id: '777', status: ++scans === 1 ? 'DRAFT' : 'LIVE' }]]),
    revert: async id => { calls.push('revert'); return { id, status: 'DRAFT' }; },
    update: async (id, payload) => { calls.push('update'); return { id, status: 'DRAFT', content: payload.content }; },
  };
  await assert.rejects(importVideo({ root, packet, upload: true, client, log: () => {} }), /取消公開/);
  assert.deepEqual(calls, []);
});

test('TUI never reverts an article that was manually published or scheduled in Blogger', async () => {
  for (const status of ['LIVE', 'SCHEDULED']) {
    const blogger = {
      get: async () => ({ status }),
      findManaged: async () => new Map([['video', { status }]]),
    };
    await assert.rejects(checkVideoDraft(blogger, { get: () => ({ postId: '77' }) }, 'video'), /取消公開/);
    await assert.rejects(checkVideoDraft(blogger, { get: () => undefined }, 'video'), /取消公開/);
  }
  await checkVideoDraft({ get: async () => ({ status: 'DRAFT' }) }, { get: () => ({ postId: '77' }) }, 'video');
});
