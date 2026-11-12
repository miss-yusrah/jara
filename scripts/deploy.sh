#!/usr/bin/env bash
# Push Jara to the VPS, rebuild, and restart. Secrets live only in
# /opt/jara/.env.production.local on the server and are never synced.
set -euo pipefail
HOST=${DEPLOY_HOST:-hoursback-waba-gateway}
cd "$(dirname "$0")/.."
rsync -az --delete --exclude node_modules --exclude .next --exclude data --exclude '.env*' --exclude .git --exclude '*.tsbuildinfo' --exclude output ./ "$HOST:/opt/jara/"
ssh "$HOST" 'cd /opt/jara && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null && pm2 restart jara --update-env >/dev/null && sleep 4 && curl -fsS -o /dev/null -w "jara %{http_code}\n" 127.0.0.1:3400/ && node scripts/install-auto-pay-cron.mjs'
