import test from 'node:test';
import assert from 'node:assert/strict';
import { BloggerClient } from '../src/blogger.mjs';

const credentials = { client_id: 'test-client', client_secret: 'test-secret', refresh_token: 'test-refresh' };

test('OAuth refresh, admin pagination and draft insertion use documented parameters', async () => {
  const calls = [];
  const hash = 'a'.repeat(64);
  const client = new BloggerClient('123', credentials, async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('oauth2')) return Response.json({ access_token: 'test-access', expires_in: 3600 });
    if (options.method === 'POST') {
      assert.equal(new URL(url).searchParams.get('isDraft'), 'true');
      return Response.json({ id: '77', status: 'DRAFT' });
    }
    const params = new URL(url).searchParams;
    assert.equal(params.get('view'), 'ADMIN');
    assert.deepEqual(params.getAll('status'), ['live', 'draft', 'scheduled']);
    if (params.has('pageToken')) return Response.json({ items: [{ id: '42', status: 'DRAFT', content: `<!-- blogger-pipeline:id=managed;source=${hash} -->` }] });
    return Response.json({ nextPageToken: 'page-2' });
  });
  const managed = await client.findManaged();
  assert.equal(managed.get('managed').id, '42');
  await client.insertDraft({ title: 'Test', content: 'Body', labels: [] });
  assert.equal(calls.filter(call => call.url.includes('oauth2')).length, 1);
});

test('get asks for the ADMIN view so the real API returns post status', async () => {
  // 真實 API 的預設 view 不含 status；缺了它，TUI 與管線會把已存在的草稿誤判為「已公開」而拒絕更新。
  let params;
  const client = new BloggerClient('123', credentials, async url => {
    if (String(url).includes('oauth2')) return Response.json({ access_token: 'test-access', expires_in: 3600 });
    params = new URL(url).searchParams;
    return Response.json({ id: '77', status: 'DRAFT' });
  });
  await client.get('77');
  assert.equal(params.get('view'), 'ADMIN');
  assert.equal(params.get('fetchBody'), 'true');
});

test('ambiguous insert failure is never retried and does not leak server body or tokens', async () => {
  let inserts = 0;
  const client = new BloggerClient('123', credentials, async (url, options) => {
    if (String(url).includes('oauth2')) return Response.json({ access_token: 'test-access', expires_in: 3600 });
    inserts++;
    return new Response('sensitive upstream response', { status: 503 });
  });
  await assert.rejects(client.insertDraft({}), error => {
    assert.match(error.message, /503/);
    assert.doesNotMatch(error.message, /sensitive|test-access|test-secret/);
    return true;
  });
  assert.equal(inserts, 1);
});

test('duplicate remote markers stop publication', async () => {
  const client = new BloggerClient('123', credentials, async url => String(url).includes('oauth2')
    ? Response.json({ access_token: 'access', expires_in: 3600 })
    : Response.json({ items: ['1', '2'].map(id => ({ id, content: `<!-- blogger-pipeline:id=same;source=${'a'.repeat(64)} -->` })) }));
  await assert.rejects(client.findManaged(), /重複文章/);
});
