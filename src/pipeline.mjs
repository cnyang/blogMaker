import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPosts, fingerprint, renderBody, renderPost, writePreview, allowsFacebook } from './posts.mjs';
import { editPost } from './ai.mjs';

export async function settings(root, env = process.env) {
  return { prompt: await readFile(join(root, 'prompts/editor.txt'), 'utf8'), model: env.OPENAI_MODEL || 'gpt-4.1-mini', apiKey: env.OPENAI_API_KEY };
}

export async function validate(root) {
  const posts = await loadPosts(root);
  for (const post of posts) renderBody(post.body, { facebook: allowsFacebook(post) });
  return posts;
}

export async function runPipeline({ root, posts, config, dryRun = false, noAI = false, store, blogger, editor = editPost, log = console.log, allowRevert = true }) {
  posts ??= await validate(root);
  const selected = dryRun ? posts : posts.filter(post => post.meta.publish);
  // Validate all local pointers before any external mutations.
  if (!dryRun) {
    for (const post of selected) {
      const record = store.get(post.meta.id);
      if (record && post.meta.post_id && record.postId !== post.meta.post_id) throw new Error(`${post.path}: post_id 與發布紀錄不一致`);
      if (post.meta.post_id) store.checkOwnership(post.meta.id, post.meta.post_id);
    }
  }
  let managed;
  const results = [];
  for (const post of selected) {
    const id = post.meta.id;
    const hash = fingerprint(post, { ...config, noAI });
    const record = dryRun ? undefined : store.get(id);
    if (record?.sourceHash === hash) {
      log(`略過 ${post.path}（內容未變更）`);
      results.push({ id, action: 'skipped', postId: record.postId });
      continue;
    }
    let remote;
    if (!dryRun) {
      const postId = record?.postId ?? post.meta.post_id;
      if (postId) remote = await blogger.get(postId); // A 404 must not silently create a duplicate.
      else {
        managed ??= await blogger.findManaged();
        remote = managed.get(id);
      }
      if (remote) {
        if (!/^\d+$/.test(remote.id)) throw new Error('Blogger 未回傳有效 post ID');
        store.checkOwnership(id, remote.id);
      }
    }
    const marker = `<!-- blogger-pipeline:id=${id};source=${hash} -->`;
    let payload;
    if (remote?.content?.endsWith(marker) || remote?.content?.includes(marker)) {
      // Recover after a crash/ambiguous insert without paying for another AI call.
      payload = { title: remote.title, content: remote.content, labels: remote.labels ?? [] };
    } else {
      const edited = post.meta.ai && !noAI
        ? await editor(post, config)
        : { markdown: post.body, summary: post.meta.summary ?? '', labels: [] };
      payload = renderPost(post, edited, hash);
      await writePreview(root, post, edited, payload);
    }
    if (dryRun) {
      log(`預覽 ${post.path} → build/${id}.html`);
      results.push({ id, action: 'preview' });
      continue;
    }
    const checkpoint = async sourceHash => {
      await store.set(id, { postId: remote.id, sourceHash, status: remote.status ?? 'UNKNOWN', url: remote.url ?? '' });
    };
    const action = remote ? 'updated' : 'created';
    if (!remote) {
      remote = await blogger.insertDraft(payload);
      if (!/^\d+$/.test(remote.id)) throw new Error('Blogger 新增文章後未回傳有效 ID；重新執行前請核對遠端紀錄');
      await checkpoint(null); // Persist the ID BEFORE attempting to publish.
    } else {
      if (!['DRAFT', 'LIVE', 'SCHEDULED'].includes(remote.status)) remote = await blogger.get(remote.id);
      if (post.meta.status === 'draft' && remote.status !== 'DRAFT') {
        if (!allowRevert) throw new Error('文章已公開或排程；此操作不允許取消公開');
        remote = await blogger.revert(remote.id);
        await checkpoint(null);
      }
      if (!remote.content?.includes(marker)) {
        remote = await blogger.update(remote.id, payload);
        await checkpoint(null);
      }
    }
    if (!['DRAFT', 'LIVE', 'SCHEDULED'].includes(remote.status)) remote = await blogger.get(remote.id);
    if (post.meta.status === 'published' && remote.status !== 'LIVE') remote = await blogger.publish(remote.id);
    if (post.meta.status === 'draft' && remote.status !== 'DRAFT') {
      if (!allowRevert) throw new Error('文章已公開或排程；此操作不允許取消公開');
      remote = await blogger.revert(remote.id);
    }
    const expected = post.meta.status === 'published' ? 'LIVE' : 'DRAFT';
    if (remote.status !== expected) remote = await blogger.get(remote.id);
    if (remote.status !== expected) throw new Error(`${post.path}: Blogger 狀態未符合 ${expected}，請重新執行`);
    await checkpoint(hash);
    log(`${expected === 'LIVE' ? '已發布' : '已儲存草稿'} ${post.path}（${remote.id}）`);
    results.push({ id, action, postId: remote.id, status: remote.status });
  }
  return results;
}
