// AdSense 只支援 nonce 型 strict CSP，靜態 _headers 無法每次請求換 nonce，所以由這裡注入。
const PLACEHOLDER = "__CSP_NONCE__";

const BASE_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

export function csp(nonce) {
  return [
    "object-src 'none'",
    `script-src 'nonce-${nonce}' 'unsafe-inline' 'unsafe-eval' 'strict-dynamic' https: http:`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export async function onRequest({ next, env }) {
  const res = await next();
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(BASE_HEADERS)) headers.set(k, v);

  const isHtml = headers.get("content-type")?.includes("text/html");
  if (!isHtml || !res.body) return new Response(res.body, { status: res.status, headers });

  const nonce = crypto.randomUUID();
  const html = (await res.text()).replaceAll(PLACEHOLDER, nonce);
  // 每次回應 nonce 都不同：快取 HTML 會讓舊 nonce 配到新 CSP，廣告腳本因而被擋
  headers.delete("etag");
  headers.set("Cache-Control", "no-store");
  // CSP_REPORT_ONLY=1 用於 AdSense 上線初期，只回報不阻擋
  const name = env?.CSP_REPORT_ONLY === "1" ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
  headers.set(name, csp(nonce));
  return new Response(html, { status: res.status, headers });
}
