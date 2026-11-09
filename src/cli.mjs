#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createPost } from './posts.mjs';
import { validate, settings, runPipeline } from './pipeline.mjs';
import { BloggerClient, loadCredentials } from './blogger.mjs';
import { FileState, withPublishLock } from './state.mjs';

async function main() {
  const { values, positionals } = parseArgs({ options: {
    'no-ai': { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
    root: { type: 'string', default: '.' }, state: { type: 'string' }, site: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  }, allowPositionals: true });
  const [command, ...args] = positionals;
  if (values.help || !command) {
    console.log('用法：npm run new -- "文章標題" [--site kids|tech] | validate | preview -- --no-ai | publish [-- --dry-run]');
    return;
  }
  const root = resolve(values.root);
  if (command === 'new') { console.log(await createPost(root, args.join(' '), values.site)); return; }
  if (values.site !== undefined) throw new Error('--site 僅適用於 new；發布目標由 BLOGGER_BLOG_ID 決定');
  if (!['validate', 'preview', 'publish'].includes(command)) throw new Error(`未知指令: ${command}`);
  const posts = await validate(root);
  if (command === 'validate') { console.log(`已驗證 ${posts.length} 篇 Markdown 文章`); return; }
  const config = await settings(root);
  const dryRun = command === 'preview' || values['dry-run'];
  if (dryRun) { await runPipeline({ root, posts, config, dryRun, noAI: values['no-ai'] }); return; }
  if (!posts.some(post => post.meta.publish)) { console.log('沒有 publish: true 的文章'); return; }
  await withPublishLock(join(root, '.blogger/publish.lock'), async () => {
    const blogger = new BloggerClient(process.env.BLOGGER_BLOG_ID, await loadCredentials());
    const store = await FileState.load(resolve(values.state ?? join(root, '.blogger/state.json')), blogger.blogId);
    await runPipeline({ root, posts, config, noAI: values['no-ai'], blogger, store });
  });
}

main().catch(error => { console.error(`錯誤：${error.message}`); process.exitCode = 1; });
