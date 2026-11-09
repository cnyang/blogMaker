import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requestJson } from '../src/http.mjs';

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('用法：npm run auth -- credentials/client_secret.json');
  const client = JSON.parse(await readFile(path, 'utf8')).installed;
  if (!client?.client_id || !client?.client_secret) throw new Error('請使用 Google Cloud「Desktop app」類型的 OAuth client JSON');
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let callback;
  let rejectCallback;
  const codePromise = new Promise((resolveCode, rejectCode) => { callback = resolveCode; rejectCallback = rejectCode; });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/oauth2callback') { res.writeHead(404).end(); return; }
    if (url.searchParams.get('state') !== state) { res.writeHead(400).end('Invalid OAuth state.'); return; }
    if (url.searchParams.has('error') || !url.searchParams.get('code')) {
      res.writeHead(400).end('Authorization denied.');
      rejectCallback(new Error('Google 授權未完成'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('授權已收到，請回到終端機查看結果。');
    callback(url.searchParams.get('code'));
  });
  await new Promise((listenResolve, listenReject) => { server.once('error', listenReject); server.listen(0, '127.0.0.1', listenResolve); });
  const redirect = `http://127.0.0.1:${server.address().port}/oauth2callback`;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code',
    scope: 'https://www.googleapis.com/auth/blogger', access_type: 'offline', prompt: 'consent', state,
    code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  console.log(`請在這台電腦的瀏覽器開啟此網址（5 分鐘內完成）：\n${url}`);
  const timer = setTimeout(() => rejectCallback(new Error('Google 授權逾時，請重新執行')), 300_000);
  let token;
  try {
    const code = await codePromise;
    token = await requestJson('https://oauth2.googleapis.com/token', {
      service: 'Google OAuth', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, code,
        code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' }),
    });
  } finally { clearTimeout(timer); server.close(); server.closeAllConnections(); }
  if (!token.refresh_token) throw new Error('Google 未回傳 refresh token，請重新授權並同意 offline access');
  const credentials = { type: 'authorized_user', client_id: client.client_id, client_secret: client.client_secret, refresh_token: token.refresh_token };
  await mkdir('credentials', { recursive: true, mode: 0o700 });
  const output = resolve('credentials/token.json');
  await writeFile(output, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
  await chmod(output, 0o600);
  console.log(`憑證已儲存：${output}（已由 .gitignore 排除）`);
  const blogs = await requestJson('https://www.googleapis.com/blogger/v3/users/self/blogs', {
    service: 'Blogger', headers: { Authorization: `Bearer ${token.access_token}` },
  });
  for (const blog of blogs.items ?? []) console.log(`Blog ID: ${blog.id} — ${blog.name}`);
}

main().catch(error => { console.error(`錯誤：${error.message}`); process.exitCode = 1; });
