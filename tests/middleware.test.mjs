import assert from "node:assert/strict";
import test from "node:test";
import { onRequest } from "../functions/_middleware.js";

const html = (body = '<script nonce="__CSP_NONCE__"></script>') =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8", etag: "x" } });

test("HTML 的 nonce 與 CSP 一致且每次不同", async () => {
  const get = async () => {
    const r = await onRequest({ next: async () => html() });
    const nonce = (await r.text()).match(/nonce="([^"]+)"/)[1];
    assert.notEqual(nonce, "__CSP_NONCE__");
    assert.ok(r.headers.get("content-security-policy").includes(`'nonce-${nonce}'`));
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("etag"), null);
    return nonce;
  };
  assert.notEqual(await get(), await get());
});

test("Report-Only 開關", async () => {
  const r = await onRequest({ next: async () => html(), env: { CSP_REPORT_ONLY: "1" } });
  assert.ok(r.headers.get("content-security-policy-report-only"));
  assert.equal(r.headers.get("content-security-policy"), null);
});

test("非 HTML 不改內容，且有基本 header", async () => {
  const next = async () => new Response("a{}", { headers: { "content-type": "text/css" } });
  const r = await onRequest({ next });
  assert.equal(await r.text(), "a{}");
  assert.equal(r.headers.get("content-security-policy"), null);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});

test("304 無 body 不會崩潰", async () => {
  const r = await onRequest({ next: async () => new Response(null, { status: 304 }) });
  assert.equal(r.status, 304);
});
