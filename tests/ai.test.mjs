import test from 'node:test';
import assert from 'node:assert/strict';
import { editPost } from '../src/ai.mjs';
import { parsePost } from '../src/posts.mjs';

const markdown = '原文 [來源](https://example.com) 與 `x`。\n\n```js\nconst x = 1;\n```\n';
const post = parsePost(`---\n${JSON.stringify({ id: 'ai-test', title: 'AI 測試', publish: true })}\n---\n${markdown}`);
const config = { apiKey: 'test-placeholder', model: 'test-model', prompt: 'editor' };
function response(edited, status = 'completed') {
  return Response.json({ status, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(edited) }] }] });
}
const good = { markdown, summary: '文章摘要。', labels: ['測試'] };

test('Responses structured output request is validated and storage disabled', async () => {
  const result = await editPost(post, { ...config, fetcher: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'test-model');
    assert.equal(payload.store, false);
    assert.equal(payload.text.format.strict, true);
    assert.equal(JSON.parse(payload.input).markdown, markdown);
    return response(good);
  } });
  assert.equal(result.summary, good.summary);
});

test('AI may reorganize prose but cannot edit code or URLs', async () => {
  for (const changed of [markdown.replace('const x = 1;', 'const x = 2;'), markdown.replace('https://example.com', 'https://evil.test'), markdown.replace('`x`', '`y`')]) {
    await assert.rejects(editPost(post, { ...config, fetcher: async () => response({ ...good, markdown: changed }) }), /程式碼或連結/);
  }
});

test('reject missing API key, truncated output, refusal and bad schema', async () => {
  await assert.rejects(editPost(post, { ...config, apiKey: '' }), /OPENAI_API_KEY/);
  await assert.rejects(editPost(post, { ...config, fetcher: async () => response(good, 'incomplete') }), /截斷/);
  await assert.rejects(editPost(post, { ...config, fetcher: async () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }) }), /拒絕/);
  await assert.rejects(editPost(post, { ...config, fetcher: async () => response({ ...good, markdown: '' }) }), /缺少正文/);
});

test('AI cannot change or remove a shared Hugo video', async () => {
  const video = '{{< youtube id="jNQXAC9IVRw" loading="lazy" >}}\n';
  const videoPost = { ...post, body: video };
  const result = await editPost(videoPost, { ...config, fetcher: async () => response({ ...good, markdown: video }) });
  assert.equal(result.markdown, video);
  for (const changed of [video.replace('jNQXAC9IVRw', 'dQw4w9WgXcQ'), '影片已移除。']) {
    await assert.rejects(editPost(videoPost, { ...config, fetcher: async () => response({ ...good, markdown: changed }) }), /影片 ID/);
  }
});
