#!/usr/bin/env node
import { emitKeypressEvents } from 'node:readline';
import { stripVTControlCharacters, parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listArticles, previewArticle, publishArticle } from './article-actions.mjs';

const categories = ['all', 'tech', 'kids', 'husky'];
const labels = { all: '全部', tech: 'Tech', kids: '兒童', husky: 'Husky', other: '未分類' };
const statuses = { DRAFT: 'Blogger 草稿', LIVE: '已公開紀錄', SCHEDULED: '排程紀錄', UNKNOWN: '待確認' };
const execute = promisify(execFile);

export function terminalText(text) {
  return stripVTControlCharacters(String(text)).replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '').replace(/\t/g, '  ');
}

function wrap(text, columns) {
  const lines = [];
  for (const line of terminalText(text).split('\n')) {
    let current = '', width = 0;
    for (const character of line) {
      const size = /\p{Mark}/u.test(character) ? 0 : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\u3000-\u33FF\uFE30-\uFE6F\uFF01-\uFF60\uFFE0-\uFFE6]/u.test(character) ? 2 : 1;
      if (width + size > columns) { lines.push(current); current = ''; width = 0; }
      current += character;
      width += size;
    }
    lines.push(current);
  }
  return lines;
}

function visible(state) {
  return state.entries.filter(item => state.category === 'all' || item.category === state.category);
}

export function renderTui(state, { columns = 80, rows = 24 } = {}) {
  if (columns < 40 || rows < 12) return '請放大終端機至至少 40 欄、12 列；q 離開。';
  const entries = visible(state);
  const selected = entries[state.index];
  const title = `blogMaker · 文章發布　${labels[state.category]} ${entries.length} 篇`;
  const header = [title, state.warning ? `發布紀錄無法讀取，列表狀態僅供參考：${state.warning}` : state.blogId ? `Blogger Blog ID：${state.blogId}　（本機紀錄非即時遠端狀態）` : 'Blogger 尚未設定；可離線閱讀與預覽', '─'.repeat(columns)];
  const content = [];
  if (state.pending) {
    content.push(...wrap(`文章：${state.pending.post.meta.title}\n檔案：${state.pending.post.path}\n目標 Blog ID：${state.blogId}\n動作：${state.pending.status === 'published' ? '公開／更新公開文章，任何人都可能看見內容' : '上傳／更新 Blogger 草稿，不公開'}\n僅處理這一篇，使用目前 Markdown，不呼叫 AI。`, columns));
    content.push('');
    content.push(...wrap(state.pending.status === 'published' ? `確認公開請輸入 PUBLISH 後按 Enter：${state.token}` : '確認上傳草稿？y 確認／n 取消', columns));
    state.confirmationFits = content.length <= rows - 6;
  } else if (state.view === 'error' || (state.view === 'detail' && selected)) {
    const post = selected?.post;
    const lines = wrap(state.view === 'error' ? state.message : `${post.meta.title}\n${post.path}\n分類：${labels[selected.category]}　標籤：${post.meta.labels.join('、')}\n\n${post.meta.summary ?? ''}\n\n${post.body}`, columns);
    state.scroll = Math.min(state.scroll, Math.max(0, lines.length - (rows - 7)));
    content.push(...lines.slice(state.scroll, state.scroll + rows - 7));
  } else {
    const pageSize = rows - 7;
    const start = Math.floor(state.index / pageSize) * pageSize;
    for (const [offset, item] of entries.slice(start, start + pageSize).entries()) {
      const record = item.record ? `${statuses[item.record.status] ?? '有上傳紀錄'}${item.changed ? '·有修改' : ''}` : '未上傳';
      const text = `${start + offset === state.index ? '>' : ' '} [${labels[item.category]}] [${record}] ${item.post.meta.title}`;
      content.push(wrap(text, columns - 1)[0]);
    }
    if (!entries.length) content.push('沒有符合分類的文章。');
  }
  const footer = [
    '─'.repeat(columns),
    state.pending ? 'Esc 取消' : state.view !== 'list' ? '↑↓ / PgUp PgDn 捲動　p 預覽　u 草稿　P 公開　Esc 返回' : '↑↓ 選擇　Enter 內容　c 分類　p 預覽　u 草稿　P 公開　r 更新　q 離開',
    state.pending && !state.confirmationFits ? '請放大終端機以顯示完整確認內容；目前無法送出。' : `${state.busy ? '處理中：' : ''}${state.message || '操作只針對目前選取的文章。'}`,
  ];
  return [...header.map(line => wrap(line, columns)[0]), ...content.slice(0, rows - 6), ...footer.map(line => wrap(line, columns)[0])].join('\r\n');
}

async function openPreview(path) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  await execute(command, process.platform === 'win32' ? ['url.dll,FileProtocolHandler', path] : [path]);
}

export async function runTui({ root = process.cwd(), input = process.stdin, output = process.stdout, env = process.env, opener = openPreview, client } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') throw new Error('TUI 需要互動式終端機；請在終端機執行 npm run tui');
  root = resolve(root);
  env = { ...env };
  const state = { entries: [], category: 'all', index: 0, scroll: 0, view: 'list', pending: null, token: '', busy: false, message: '載入文章…', blogId: env.BLOGGER_BLOG_ID ?? '' };
  let stopped = false;
  let finish;
  const done = new Promise(resolveDone => { finish = resolveDone; });
  const draw = () => { if (!stopped) output.write('\x1b[H\x1b[2J' + renderTui(state, output)); };
  const previousRaw = input.isRaw;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    input.removeListener('keypress', onKey);
    output.removeListener('resize', draw);
    input.removeListener('end', stop);
    input.setRawMode(Boolean(previousRaw));
    input.pause();
    output.write('\x1b[?25h\x1b[?1049l');
    // 此時終端機已回到一般模式，再按一次 Ctrl+C 會由系統直接終止程序。
    if (state.busy) output.write('同步尚未完成，程式會等它結束後退出；要立即中止請再按一次 Ctrl+C。重新開啟 TUI 後請先按 r 核對狀態。\n');
    finish();
  };
  const refresh = async () => {
    const id = visible(state)[state.index]?.post.meta.id;
    state.warning = '';
    state.entries = await listArticles(root, env, message => { state.warning = message; });
    const entries = visible(state);
    const index = entries.findIndex(item => item.post.meta.id === id);
    state.index = index < 0 ? 0 : index;
  };
  const task = async (message, action) => {
    state.busy = true;
    state.message = message;
    draw();
    try { state.message = await action(); }
    catch (error) { state.message = `失敗：${error.message}`; state.view = 'error'; state.scroll = 0; }
    finally { state.busy = false; draw(); }
  };
  const send = async () => {
    const pending = state.pending;
    state.pending = null;
    state.token = '';
    await task('同步所選文章…', async () => {
      const record = await publishArticle(root, pending.post, pending.status, { env, client });
      const result = `${record.status === 'LIVE' ? '已公開' : '已儲存草稿'}：${pending.post.meta.title}（${record.postId}）`;
      // 遠端已成功；重新整理失敗只附註，不可顯示成同步失敗而誤導使用者重試。
      try { await refresh(); } catch (error) { return `${result}；重新整理失敗：${error.message}（按 r 重試）`; }
      return result;
    });
  };
  async function onKey(text, key = {}) {
    try {
      // Ctrl+C 要在 busy 檢查之前處理：raw mode 下它不會送出 SIGINT，請求卡住時使用者才有出口。
      if (key.ctrl && key.name === 'c') { stop(); return; }
      if (state.busy) { state.message = '正在處理，請等候結果後再操作；Ctrl+C 可離開'; draw(); return; }
      if (state.pending) {
        if (key.name === 'escape' || (state.pending.status === 'draft' && text?.toLowerCase() === 'n')) {
          state.pending = null; state.token = ''; state.message = '已取消，沒有上傳';
        } else if (!state.confirmationFits || (output.columns ?? 80) < 40 || (output.rows ?? 24) < 12) {
          state.message = '請先放大終端機，核對完整文章與目標後再確認';
        } else if (state.pending.status === 'draft' && text?.toLowerCase() === 'y') await send();
        else if (state.pending.status === 'published') {
          if (key.name === 'return') {
            if (state.token === 'PUBLISH') await send();
            else state.message = '確認文字不符；輸入 PUBLISH 後按 Enter，或 Esc 取消';
          } else if (key.name === 'backspace') state.token = state.token.slice(0, -1);
          else if (/^[A-Za-z]$/.test(text ?? '') && state.token.length < 20) state.token += text;
        }
        draw(); return;
      }
      if (text === 'q' || key.name === 'escape') {
        if (state.view !== 'list') { state.view = 'list'; state.scroll = 0; draw(); }
        else stop();
        return;
      }
      if ((output.columns ?? 80) < 40 || (output.rows ?? 24) < 12) return;
      const entries = visible(state);
      const selected = entries[state.index];
      const pageSize = Math.max(1, (output.rows ?? 24) - 7);
      const movement = ['down', 'pagedown'].includes(key.name) ? 1 : ['up', 'pageup'].includes(key.name) ? -1 : 0;
      if (movement) {
        const step = ['pagedown', 'pageup'].includes(key.name) ? pageSize : 1;
        if (state.view !== 'list') state.scroll = Math.max(0, state.scroll + movement * step);
        else state.index = Math.max(0, Math.min(entries.length - 1, state.index + movement * step));
      } else if (text === 'r') await task('重新整理…', async () => { await refresh(); state.view = 'list'; return '已重新整理文章與本機發布紀錄'; });
      else if (text === 'c') {
        state.category = categories[(categories.indexOf(state.category) + 1) % categories.length];
        state.index = 0; state.scroll = 0; state.view = 'list';
      } else if (key.name === 'return' && selected) { state.view = 'detail'; state.scroll = 0; }
      else if (text === 'p' && selected) await task('產生離線 HTML 預覽…', async () => {
        const path = await previewArticle(root, selected.post);
        await opener(path);
        return `已開啟預覽：${selected.post.meta.title}`;
      });
      else if (['u', 'P'].includes(text) && selected) {
        if (!/^\d+$/.test(state.blogId)) state.message = '請先設定 BLOGGER_BLOG_ID 與 OAuth；p 可離線預覽';
        else {
          state.pending = { post: selected.post, status: text === 'P' ? 'published' : 'draft' };
          state.token = '';
          state.message = '請核對文章與目標；影片的公開可見性須另到影片平台確認';
        }
      }
      draw();
    } catch (error) { state.message = `失敗：${error.message}`; state.view = 'error'; state.scroll = 0; draw(); }
  }
  emitKeypressEvents(input);
  input.setRawMode(true);
  output.write('\x1b[?1049h\x1b[?25l');
  input.on('keypress', onKey);
  input.once('end', stop);
  output.on('resize', draw);
  input.resume();
  try {
    await task('載入文章…', async () => { await refresh(); return 'Enter 閱讀內容，p 開啟離線預覽'; });
    await done;
  } finally { stop(); }
}

async function main() {
  const { values } = parseArgs({ options: { root: { type: 'string', default: '.' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log('用法：npm run tui [-- --root PATH]\n↑↓ 選文章、Enter 內容、c 分類、p 離線預覽、u 上傳草稿、P 公開發布、r 更新、q 離開。\n公開需輸入 PUBLISH 確認；使用目前 Markdown，不額外呼叫 AI。'); return; }
  await runTui({ root: values.root });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`錯誤：${error.message}`); process.exitCode = 1; });
}
