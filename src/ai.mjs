import { requestJson } from './http.mjs';
import { normalizeMarkdown, protectedContent, validateLabels } from './posts.mjs';

export const EDIT_SCHEMA = {
  type: 'object',
  properties: {
    markdown: { type: 'string' },
    summary: { type: 'string' },
    labels: { type: 'array', items: { type: 'string' } },
  },
  required: ['markdown', 'summary', 'labels'],
  additionalProperties: false,
};

export async function editPost(post, { apiKey, model, prompt, fetcher = fetch }) {
  if (!apiKey?.trim()) throw new Error('AI 處理需要 OPENAI_API_KEY；離線預覽可用 --no-ai');
  const result = await requestJson('https://api.openai.com/v1/responses', {
    service: 'OpenAI', fetcher,
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, store: false, max_output_tokens: 16000,
      instructions: prompt,
      input: JSON.stringify({ title: post.meta.title, markdown: post.body }),
      text: { format: { type: 'json_schema', name: 'edited_article', strict: true, schema: EDIT_SCHEMA } },
    }),
  });
  if (result.status !== 'completed') throw new Error('AI 回覆尚未完成或被截斷，未發布文章');
  const parts = (result.output ?? []).filter(x => x.type === 'message').flatMap(x => x.content ?? []);
  if (parts.some(x => x.type === 'refusal')) throw new Error('AI 拒絕處理這篇文章，未發布文章');
  let edited;
  try { edited = JSON.parse(parts.filter(x => x.type === 'output_text').map(x => x.text).join('')); }
  catch { throw new Error('AI 回覆不是有效 JSON，未發布文章'); }
  if (!edited || typeof edited.markdown !== 'string' || !edited.markdown.trim() || typeof edited.summary !== 'string' || !edited.summary.trim() || edited.summary.length > 400) {
    throw new Error('AI 回覆缺少正文或摘要格式不正確，未發布文章');
  }
  edited.labels = validateLabels(edited.labels, 'AI labels');
  edited.markdown = normalizeMarkdown(edited.markdown);
  if (JSON.stringify(protectedContent(post.body)) !== JSON.stringify(protectedContent(edited.markdown))) {
    throw new Error('AI 修改了程式碼或連結網址（含影片 ID），未發布文章。請調整原文或設定 ai: false');
  }
  return edited;
}
