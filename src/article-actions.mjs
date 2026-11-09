import { join } from 'node:path';
import { fingerprint } from './posts.mjs';
import { validate, runPipeline } from './pipeline.mjs';
import { BloggerClient, loadCredentials } from './blogger.mjs';
import { FileState, withPublishLock } from './state.mjs';

export function categoryOf(post) {
  return post.meta.category ?? (post.path.startsWith('kids/') ? 'kids' : post.path.startsWith('tech/') ? 'tech' : 'other');
}

function uploadVersion(post, status) {
  return { ...post, meta: { ...post.meta, publish: true, status } };
}

// 逐篇向 Blogger 查實際狀態，只填進 row.remote、不改寫發布紀錄（使用者可能在後台手動改過狀態）。
// 單篇失敗（如 404）只標在該篇；憑證讀不到則整體退回離線並警告。
async function checkRemote(rows, env, client, onWarning) {
  const targets = rows.filter(row => row.record);
  if (!targets.length) return;
  let blogger = client;
  try { blogger ??= new BloggerClient(env.BLOGGER_BLOG_ID, await loadCredentials(env)); }
  catch (error) { onWarning(`無法核對 Blogger 遠端狀態：${error.message}`); return; }
  await Promise.all(targets.map(async row => {
    try { const post = await blogger.get(row.record.postId); row.remote = { status: post.status, url: post.url }; }
    catch (error) { row.remote = { error: error.message }; }
  }));
}

export async function listArticles(root, env = process.env, onWarning = () => {}, { remote = false, client } = {}) {
  const posts = await validate(root);
  let store;
  if (/^\d+$/.test(env.BLOGGER_BLOG_ID ?? '')) {
    // 發布紀錄損毀或屬於別的 blog 時，仍須能離線閱讀與預覽；真正上傳時 publishArticle 會再報出同一個錯誤。
    try { store = await FileState.load(join(root, '.blogger/state.json'), env.BLOGGER_BLOG_ID); }
    catch (error) { onWarning(error.message); }
  }
  const rows = posts.sort((a, b) => (b.meta.date ?? '').localeCompare(a.meta.date ?? '') || a.meta.title.localeCompare(b.meta.title, 'zh-TW')).map(post => {
    const record = store?.get(post.meta.id);
    const status = record?.status === 'LIVE' ? 'published' : 'draft';
    const changed = Boolean(record && record.sourceHash !== fingerprint(uploadVersion(post, status), { noAI: true }));
    return { post, category: categoryOf(post), record, changed, fingerprint: fingerprint(post, { noAI: true }) };
  });
  if (remote) await checkRemote(rows, env, client, onWarning);
  return rows;
}

// snapshot 可以是整篇 post，或畫面上看到的版本 { id, fingerprint }（TUI 在另一個程序，只帶得走這兩個值）。
async function latestPost(root, snapshot) {
  const id = snapshot.meta?.id ?? snapshot.id;
  const seen = snapshot.fingerprint ?? fingerprint(snapshot, { noAI: true });
  const post = (await validate(root)).find(item => item.meta.id === id);
  if (!post || fingerprint(post, { noAI: true }) !== seen) {
    throw new Error('文章已變更或移除；請重新整理、查看內容後再操作');
  }
  return post;
}

export async function previewArticle(root, snapshot) {
  const post = await latestPost(root, snapshot);
  await runPipeline({ root, posts: [post], config: {}, noAI: true, dryRun: true, log: () => {} });
  return join(root, 'build', `${post.meta.id}.html`);
}

export async function publishArticle(root, snapshot, status, { env = process.env, client, log = () => {} } = {}) {
  if (!['draft', 'published'].includes(status)) throw new Error('發布狀態不合法');
  if (!/^\d+$/.test(env.BLOGGER_BLOG_ID ?? '')) throw new Error('請先設定 BLOGGER_BLOG_ID 與 Blogger OAuth；仍可離線預覽');
  return withPublishLock(join(root, '.blogger/publish.lock'), async () => {
    const post = await latestPost(root, snapshot);
    const blogger = client ?? new BloggerClient(env.BLOGGER_BLOG_ID, await loadCredentials(env));
    const store = await FileState.load(join(root, '.blogger/state.json'), blogger.blogId);
    const record = store.get(post.meta.id);
    // 影片文章先經 videoMaker 驗證核准及雙平台 hash；一般文章 TUI 不繞過這道檢查。
    const isVideo = post.path.startsWith('posts/video/') || post.meta.id.startsWith('vmk-');
    if (isVideo) {
      const previous = record?.status === 'LIVE' ? 'published' : 'draft';
      if (!record || record.sourceHash !== fingerprint(uploadVersion(post, previous), { noAI: true })) {
        throw new Error('影片文章請先在 videoMaker TUI 按 b 驗證並上傳目前版本，再到這裡發布');
      }
    }
    if (record && post.meta.post_id && record.postId !== post.meta.post_id) throw new Error('post_id 與發布紀錄不一致');
    // 只有已有紀錄時才預讀遠端（核對 journal、提早擋下取消公開）；新文章的遠端查找交給 runPipeline，避免整站掃描兩次。
    const remote = record ? await blogger.get(record.postId) : undefined;
    if (status === 'draft' && remote && remote.status !== 'DRAFT') {
      throw new Error('這篇文章已公開或排程；草稿動作不會取消公開，請到 Blogger 處理');
    }
    // TUI 以遠端實際狀態核對 journal，避免使用者在 Blogger 手動改狀態後被本機快取略過。
    if (record && remote?.status !== record.status) await store.set(post.meta.id, { ...record, sourceHash: null });
    try {
      await runPipeline({ root, posts: [uploadVersion(post, status)], config: {}, noAI: true, blogger, store, log, allowRevert: false });
    } catch (error) {
      // 管線中途失敗會把 sourceHash 設為 null；影片文章的核准驗證綁在原本的 hash，不還原就無法重試或改按 b。
      // 還原失敗時仍以原始錯誤為準。
      if (isVideo && store.get(post.meta.id)?.sourceHash === null) {
        await store.set(post.meta.id, { ...store.get(post.meta.id), sourceHash: record.sourceHash }).catch(() => {});
      }
      throw error;
    }
    return store.get(post.meta.id);
  });
}
