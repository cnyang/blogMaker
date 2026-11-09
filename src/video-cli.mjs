#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { videoPost, saveVideoPost, checkVideoDraft } from './video.mjs';
import { runPipeline } from './pipeline.mjs';
import { BloggerClient, loadCredentials } from './blogger.mjs';
import { FileState, withPublishLock } from './state.mjs';

export async function importVideo({ root, packet, upload = false, env = process.env, client, log = message => console.error(message) }) {
  return withPublishLock(join(root, '.blogger/publish.lock'), async () => {
    let blogger, store;
    if (upload) {
      // 先驗證封包並確認遠端仍是草稿，通過後才寫入本機檔案；被拒絕的上傳不得改動既有文章。
      const { post: draft } = videoPost(packet, { upload });
      blogger = client ?? new BloggerClient(env.BLOGGER_BLOG_ID, await loadCredentials(env));
      store = await FileState.load(join(root, '.blogger/state.json'), blogger.blogId);
      await checkVideoDraft(blogger, store, draft.meta.id);
    }
    const post = await saveVideoPost(root, packet, { upload });
    const options = { root, posts: [post], config: {}, noAI: true, log };
    if (!upload) {
      await runPipeline({ ...options, dryRun: true });
      return { id: post.meta.id, status: 'preview', path: join(root, 'build', `${post.meta.id}.html`) };
    }
    // 只同步這次 TUI 選取的文章；磁碟上的 publish 維持 false，避免 GitHub CI 自動重傳。
    post.meta.publish = true;
    // allowRevert:false：檢查之後若文章被手動公開，管線也不得把它取消公開。
    const [result] = await runPipeline({ ...options, blogger, store, allowRevert: false });
    const record = store.get(post.meta.id);
    return { ...result, status: record.status, url: record.url };
  });
}

export async function readStdin(stream = process.stdin) {
  stream.setEncoding('utf8'); // 讓 decoder 處理跨 chunk 的多位元組字元，否則會變成 U+FFFD
  let input = '';
  for await (const chunk of stream) {
    input += chunk;
    if (Buffer.byteLength(input) > 1_000_000) throw new Error('影片文章資料超過 1 MB');
  }
  return input;
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('videoMaker 文章匯入需要 Node.js 24 以上');
  const { values } = parseArgs({ options: { upload: { type: 'boolean', default: false } } });
  const receipt = await importVideo({ root: resolve('.'), packet: JSON.parse(await readStdin()), upload: values.upload });
  console.log(JSON.stringify(receipt));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`錯誤：${error.message}`); process.exitCode = 1; });
}
