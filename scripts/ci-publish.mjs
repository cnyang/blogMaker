import { resolve, join } from 'node:path';
import { rm } from 'node:fs/promises';
import { validate, settings, runPipeline } from '../src/pipeline.mjs';
import { BloggerClient, loadCredentials } from '../src/blogger.mjs';
import { FileState, withPublishLock } from '../src/state.mjs';
import { restoreGitState, persistGitState } from './git-state.mjs';

async function main() {
  const root = resolve('.');
  const posts = await validate(root);
  if (!posts.some(post => post.meta.publish)) { console.log('沒有 publish: true 的文章'); return; }
  await withPublishLock(join(root, '.blogger/publish.lock'), async () => {
    const blogger = new BloggerClient(process.env.BLOGGER_BLOG_ID, await loadCredentials());
    const config = await settings(root);
    const path = join(root, '.blogger/state.json');
    // The remote branch is authoritative. A stale workspace must not leak into a new blog.
    await rm(path, { force: true });
    const snapshot = await restoreGitState(root, path);
    const store = await FileState.load(path, blogger.blogId);
    try { await runPipeline({ root, posts, config, blogger, store }); }
    finally { await persistGitState(root, path, snapshot); }
  });
}

main().catch(error => { console.error(`錯誤：${error.message}`); process.exitCode = 1; });
