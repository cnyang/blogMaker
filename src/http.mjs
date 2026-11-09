export class ApiError extends Error {
  constructor(service, status) {
    super(`${service} HTTP ${status}。請檢查憑證、權限、配額與服務狀態。`);
    this.status = status;
  }
}

export async function requestJson(url, { service, fetcher = fetch, timeout = 120_000, ...options } = {}) {
  // Never automatically retry POST: Blogger insert has no idempotency key.
  let response;
  try { response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeout) }); }
  catch { throw new Error(`${service} 連線失敗或逾時。若正在新增文章，請重新執行以核對遠端紀錄。`); }
  if (!response.ok) throw new ApiError(service, response.status);
  try { return await response.json(); }
  catch { throw new Error(`${service} 回傳無效 JSON`); }
}
