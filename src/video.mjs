import { createHash } from 'node:crypto';
import { access, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePost, renderBody, allowsFacebook } from './posts.mjs';

// 授權只接受短文字標籤（如 CC BY-SA 4.0）：不含 : @ [ ] ( ) < > 等符號，也不含 www.，避免被 GFM 轉成連結或圖片。
const safeLicense = text => typeof text === 'string' && /^[\p{L}\p{N} .+\-/]{0,60}$/u.test(text) && !/www\./i.test(text);

export function videoPost(packet, { upload = false } = {}) {
  if (!packet || packet.version !== 1 || !['kids', 'husky'].includes(packet.category)
      || typeof packet.job !== 'string' || !/^\d{4}-\d{2}-\d{2}_[a-z0-9]+(-[a-z0-9]+)*$/.test(packet.job)
      || typeof packet.video_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(packet.video_sha256)
      || typeof packet.source_hash !== 'string' || !/^[a-f0-9]{64}$/.test(packet.source_hash)) {
    throw new Error('videoMaker 文章來源格式不正確');
  }
  if (typeof packet.markdown !== 'string' || !packet.markdown.trim()
      || !packet.markdown.includes('## 內容介紹') || !packet.markdown.includes('## 推薦觀看理由')
      || /https?:\/\/|www\.|\]\(|<|\{\{/i.test(packet.markdown)
      || typeof packet.summary !== 'string' || !packet.summary.trim()) {
    throw new Error('影片文章須包含介紹與推薦，且不可自行加入連結、HTML 或 shortcode');
  }
  const yt = packet.youtube_id;
  const fb = packet.facebook_reel ?? {};
  if (yt != null && (typeof yt !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(yt))) throw new Error('YouTube ID 不合法');
  if (fb.video_id != null && (typeof fb.video_id !== 'string' || !/^\d+$/.test(fb.video_id))) throw new Error('Facebook 影片 ID 不合法');
  const hasFB = fb.video_id && ['draft', 'published'].includes(fb.phase) && fb.sha256 === packet.video_sha256;
  if (upload && (packet.review_status !== 'approved' || packet.approved_sha256 !== packet.video_sha256)) {
    throw new Error('文章上傳前必須人工核准目前成片');
  }
  if (upload && (!yt || packet.youtube_sha256 !== packet.video_sha256 || !hasFB)) throw new Error('請先完成目前成片的 YouTube 上傳與 FB 草稿，並確認兩邊上傳紀錄均綁定成片 hash，才能上傳文章');
  const id = `vmk-${createHash('sha256').update(packet.job).digest('hex').slice(0, 32)}`;
  const meta = {
    id, title: packet.title, publish: false, status: 'draft', ai: false,
    category: packet.category, date: packet.job.slice(0, 10), summary: packet.summary,
    labels: [packet.category === 'kids' ? '兒童影片' : 'Husky', '影片介紹', '觀看推薦'],
  };
  let body = `${packet.markdown.trim()}\n\n## 觀看影片\n\n`;
  body += yt ? `{{< youtube id="${yt}" loading="lazy" >}}\n\n[在 YouTube 觀看](https://www.youtube.com/watch?v=${yt})\n\n` : 'YouTube 影片尚未上傳。\n\n';
  body += hasFB ? `{{< facebook id="${fb.video_id}" >}}\n\n[在 Facebook 觀看](https://www.facebook.com/watch/?v=${fb.video_id})\n` : 'Facebook 影片尚未完成上傳。\n';
  if (packet.sources !== undefined && !Array.isArray(packet.sources)) throw new Error('影片來源必須是陣列');
  const sources = new Map();
  for (const source of packet.sources ?? []) {
    if (!source || typeof source.title !== 'string' || typeof source.url !== 'string'
        || !/^https?:\/\//.test(source.url) || /[\s<>()[\]\\]/u.test(source.url)
        || (source.license !== undefined && !safeLicense(source.license))) throw new Error('影片參考來源格式不正確');
    sources.set(source.url, source);
  }
  if (sources.size) body += '\n## 參考來源\n\n' + [...sources.values()].map(source => {
    const title = source.title.replace(/[\[\]<>\\\r\n]/g, '');
    const license = source.license ?? '';
    return `- [${title}](${source.url})${license ? `（${license}）` : ''}\n`;
  }).join('');
  const text = `---\n${JSON.stringify(meta, null, 2)}\n---\n\n${body}`;
  const post = parsePost(text, `posts/video/${packet.category}/${id}.md`);
  renderBody(post.body, { facebook: allowsFacebook(post) });
  return { post, text };
}

export async function saveVideoPost(root, packet, options) {
  const result = videoPost(packet, options);
  // id 只由 job 決定（改成含分類會讓已上傳的文章重複建立）；分類改變會在另一資料夾產生同 id 的第二份檔案，
  // 讓 TUI、validate 與 CI 全部因「重複文章 id」失敗，所以在寫入前就拒絕。
  for (const other of ['kids', 'husky'].filter(category => category !== packet.category)) {
    const duplicate = join('posts/video', other, `${result.post.meta.id}.md`);
    if (await access(join(root, duplicate)).then(() => true, () => false)) {
      throw new Error(`同一支影片已用「${other}」分類匯入（${duplicate}）；請先移除該檔案再重新匯入`);
    }
  }
  const directory = join(root, 'posts/video', packet.category);
  await mkdir(directory, { recursive: true });
  const path = join(root, result.post.path);
  // TUI 與 CLI 共用發布鎖；原子替換，避免失敗時留下半篇文章。
  const temp = `${path}.tmp`;
  await writeFile(temp, result.text);
  await rename(temp, path);
  return result.post;
}

export async function checkVideoDraft(blogger, store, id) {
  const record = store.get(id);
  const remote = record ? await blogger.get(record.postId) : (await blogger.findManaged()).get(id);
  if (remote && remote.status !== 'DRAFT') throw new Error('這篇文章已公開或排程；請到 Blogger 處理，TUI 不會把它取消公開');
}
