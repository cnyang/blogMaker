import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function validateState(data, blogId) {
  if (!data || data.version !== 1 || typeof data.posts !== 'object' || !data.posts || Array.isArray(data.posts)) throw new Error('發布紀錄格式錯誤，請還原備份');
  if (data.blogId !== blogId) throw new Error('發布紀錄的 blog ID 與 BLOGGER_BLOG_ID 不同；請使用另一個 state 檔案');
  const seen = new Set();
  for (const [id, record] of Object.entries(data.posts)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id) || !record || typeof record.postId !== 'string' || !/^\d+$/.test(record.postId) || !(record.sourceHash === null || /^[a-f0-9]{64}$/.test(record.sourceHash))) throw new Error('發布紀錄損壞，請還原備份');
    if (seen.has(record.postId)) throw new Error('發布紀錄中多篇文章指向相同 post ID');
    seen.add(record.postId);
  }
  return data;
}

export class FileState {
  static async load(path, blogId) {
    let data;
    try { data = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('無法讀取發布紀錄，請先修復 state 檔案');
      data = { version: 1, blogId, posts: {} };
    }
    return new FileState(path, validateState(data, blogId));
  }

  constructor(path, data) { this.path = path; this.data = data; }
  get(id) { return Object.hasOwn(this.data.posts, id) ? this.data.posts[id] : undefined; }

  checkOwnership(id, postId) {
    for (const [other, record] of Object.entries(this.data.posts)) {
      if (other !== id && record.postId === postId) throw new Error(`${id} 與 ${other} 指向相同 Blogger post ID`);
    }
  }

  async set(id, record) {
    this.checkOwnership(id, record.postId);
    this.data.posts[id] = record;
    validateState(this.data, this.data.blogId);
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, this.path);
  }
}

export async function withPublishLock(path, fn) {
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`已有發布程序，若先前程序意外中斷，確認沒有程序執行後移除 ${path}`);
    throw error;
  }
  try {
    await handle.writeFile(String(process.pid));
    return await fn();
  } finally {
    await handle.close();
    await unlink(path);
  }
}
