#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listArticles, previewArticle, publishArticle } from './article-actions.mjs';

// 給 Python TUI 呼叫的 JSON 介面：畫面在另一個程序，所有發布規則（鎖、journal、不得取消公開）仍在 article-actions。
// preview／publish 只接受畫面上看到的 id 與 fingerprint；檔案在那之後被改過就拒絕。
export async function runArticleCli(argv, { env = process.env, client } = {}) {
  const { positionals: [command], values } = parseArgs({
    args: argv, allowPositionals: true,
    options: { root: { type: 'string', default: '.' }, remote: { type: 'boolean', default: false }, id: { type: 'string' }, fingerprint: { type: 'string' }, status: { type: 'string' } },
  });
  const root = resolve(values.root);
  if (command === 'list') {
    const warnings = [];
    const rows = await listArticles(root, env, message => warnings.push(message), { remote: values.remote, client });
    return {
      blogId: env.BLOGGER_BLOG_ID ?? '', warnings,
      articles: rows.map(({ post, category, record, changed, fingerprint, remote }) => ({
        id: post.meta.id, title: post.meta.title, path: post.path, category, date: post.meta.date ?? '',
        labels: post.meta.labels ?? [], summary: post.meta.summary ?? '', body: post.body, fingerprint,
        record: record ? { postId: record.postId, status: record.status, url: record.url } : null, changed, remote: remote ?? null,
      })),
    };
  }
  if (!['preview', 'publish'].includes(command)) throw new Error('用法：article-cli list [--remote] | preview --id ID --fingerprint HASH | publish --id ID --fingerprint HASH --status draft|published');
  if (!values.id) throw new Error('缺少 --id');
  if (!/^[a-f0-9]{64}$/.test(values.fingerprint ?? '')) throw new Error('缺少或不合法的 --fingerprint');
  const snapshot = { id: values.id, fingerprint: values.fingerprint };
  if (command === 'preview') return { path: await previewArticle(root, snapshot) };
  const record = await publishArticle(root, snapshot, values.status, { env, client });
  return { postId: record.postId, status: record.status, url: record.url };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runArticleCli(process.argv.slice(2))
    .then(result => process.stdout.write(JSON.stringify(result)))
    .catch(error => { console.error(`錯誤：${error.message}`); process.exitCode = 1; });
}
