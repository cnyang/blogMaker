#!/usr/bin/env bash
# 建置兩站並驗證廣告與安全行為
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $1"; exit 1; }
build() { hugo -s "$1" --themesDir ../themes --destination "$2" "${@:3}" >"$tmp/log" 2>&1 || { cat "$tmp/log"; fail "$1 建置失敗"; }; }

node --test tests/*.test.mjs

# 未設定 client：完全不載入廣告
for s in kids tech; do
  build "$s" "$tmp/$s-off"
  ! grep -rq adsbygoogle "$tmp/$s-off" || fail "$s: 無 client 卻輸出廣告"
done

# 設定 client：兒童站每個版位都要帶年齡標記且沒有頂部版位
export HUGO_PARAMS_ADS_CLIENT=ca-pub-1 HUGO_PARAMS_ADS_SLOTS_TOP=11 HUGO_PARAMS_ADS_SLOTS_BOTTOM=22
build kids "$tmp/kids-on"; build tech "$tmp/tech-on"
units=$(grep -rho '<ins class="adsbygoogle"[^>]*>' "$tmp/kids-on" --include='*.html')
[ -n "$units" ] || fail "kids: 沒有廣告版位"
! grep -v 'data-tag-for-age-treatment="1"' <<<"$units" || fail "kids: 廣告缺少年齡標記"
grep -q 'data-ad-slot="22"' <<<"$units" || fail "kids: 缺底部版位"
! grep -rq 'data-tag-for-age-treatment' "$tmp/tech-on" || fail "tech: 不該有年齡標記"
grep -q 'data-ad-slot="11"' "$tmp/tech-on/posts/hello/index.html" || fail "tech: 缺頂部版位"
unset HUGO_PARAMS_ADS_CLIENT HUGO_PARAMS_ADS_SLOTS_TOP HUGO_PARAMS_ADS_SLOTS_BOTTOM

# LLM 內容中的 raw HTML 必須被擋
mkdir -p "$tmp/evil/posts"
printf -- '---\ntitle: x\n---\n<script>alert(1)</script>\n' > "$tmp/evil/posts/x.md"
build tech "$tmp/evil-out" --contentDir "$tmp/evil"
! grep -q 'alert(1)' "$tmp/evil-out/posts/x/index.html" || fail "raw HTML 未被擋"

# 兒童站影片走 nocookie 網域
grep -q 'youtube-nocookie.com' "$tmp/kids-off/posts/hello/index.html" || fail "kids: 未使用 youtube-nocookie"

# CSS 不走 Function，省 Functions 額度；HTML 仍要走 middleware
for s in kids tech; do
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(r.include.includes("/*")&&r.exclude.includes("/css/*")?0:1)' "$tmp/$s-off/_routes.json" || fail "$s: _routes.json 錯誤"
done

# 子路徑部署：資源與連結都要帶 base path
build kids "$tmp/sub" --baseURL https://example.github.io/repo/kids/
grep -qE 'href="/repo/kids/css/main\.[0-9a-f]+\.css"' "$tmp/sub/index.html" || fail "css 未帶 base path 或內容 hash"
ls "$tmp"/kids-off/css/main.*.css >/dev/null || fail "css 檔未輸出到 /css/，_routes.json 會失效"
grep -q 'href="/repo/kids/privacy/"' "$tmp/sub/index.html" || fail "連結未帶 base path"

# 預覽站要 noindex；正式站不可帶
HUGO_PARAMS_NOINDEX=true build tech "$tmp/noindex"
grep -q 'name="robots" content="noindex"' "$tmp/noindex/index.html" || fail "預覽站缺 noindex"
! grep -q 'content="noindex"' "$tmp/tech-off/index.html" || fail "正式站不該 noindex"

# 兒童站首頁不對第三方發出請求
! grep -qE '(src|href)="https?://' "$tmp/kids-off/index.html" || fail "kids 首頁有第三方資源"

echo "OK"
