#!/usr/bin/env bash
# Đẩy toàn bộ biến trong file .env lên Vercel (Production + Preview + Development).
# Yêu cầu: đã cài Vercel CLI (npm i -g vercel), đã `vercel login` và `vercel link`.
# Dùng: bash scripts/vercel-env-push.sh [.env]
set -euo pipefail

ENV_FILE="${1:-.env}"
[ -f "$ENV_FILE" ] || { echo "Không thấy file $ENV_FILE"; exit 1; }

while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
  name="${line%%=*}"
  value="${line#*=}"
  value="${value%\"}"; value="${value#\"}"
  [ -z "$name" ] || [ -z "$value" ] && continue
  for target in production preview development; do
    vercel env rm "$name" "$target" --yes >/dev/null 2>&1 || true
    printf '%s' "$value" | vercel env add "$name" "$target" >/dev/null
  done
  echo "✔ $name"
done < "$ENV_FILE"

echo "Xong. Chạy 'vercel --prod' hoặc push code lên GitHub để deploy lại."
