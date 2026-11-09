#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for file in src/*.mjs scripts/*.mjs functions/*.js tests/*.mjs; do
  node --check "$file"
done
for file in scripts/*.sh; do
  bash -n "$file"
done
echo "OK: JavaScript 與 Shell 語法檢查通過"
