import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const branch = 'blogger-state';
const exec = promisify(execFile);
async function git(root, args, input) {
  if (input === undefined) return (await exec('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd: root, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function restoreGitState(root, path) {
  let exists;
  try { await git(root, ['ls-remote', '--exit-code', '--heads', 'origin', branch]); exists = true; }
  catch (error) {
    if (error.code !== 2) throw new Error('無法讀取遠端發布紀錄，請檢查 origin 與 GitHub 權限');
    exists = false;
  }
  if (!exists) return { parent: null, original: null };
  await git(root, ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const parent = await git(root, ['rev-parse', `refs/remotes/origin/${branch}`]);
  const original = await git(root, ['show', `${parent}:posts.json`]) + '\n';
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, original, { mode: 0o600 });
  return { parent, original };
}

export async function persistGitState(root, path, snapshot) {
  let current;
  try { current = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (current === snapshot.original) return;
  const blob = await git(root, ['hash-object', '-w', '--stdin'], current);
  const tree = await git(root, ['mktree'], `100644 blob ${blob}\tposts.json\n`);
  const commit = await git(root, ['-c', 'user.name=Blogger Pipeline', '-c', 'user.email=blogger-pipeline@users.noreply.github.com', 'commit-tree', tree,
    ...(snapshot.parent ? ['-p', snapshot.parent] : []), '-m', 'Update Blogger publication state']);
  try { await git(root, ['push', 'origin', `${commit}:refs/heads/${branch}`]); }
  catch { throw new Error('發布紀錄無法推送到 blogger-state；請保留 state artifact，確認 Actions 有 contents: write 並重新執行'); }
}
