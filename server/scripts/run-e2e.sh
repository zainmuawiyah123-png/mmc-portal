#!/usr/bin/env bash
# ============================================================
# يشغّل الخادم على قاعدة نظيفة، ينفّذ سيناريو E2E الكامل، ثم يوقفه.
# كل شيء في جلسة واحدة لأن الخادم الخلفي يُقتل عند انتهاء الجلسة.
#    bash scripts/run-e2e.sh
# ============================================================
set -u
cd "$(dirname "$0")/.."

PORT="${PORT:-4100}"
export DB_PATH="$PWD/data/e2e.db"
export UPLOAD_DIR="$PWD/uploads_e2e"
export JWT_SECRET="e2e-$(date +%s)-secret"
export NODE_ENV="test"
export PORT

rm -rf "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm" "$UPLOAD_DIR"

node src/index.js > /tmp/e2e-server.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

# انتظار جاهزية الخادم (حتى 20 ثانية)
for i in $(seq 1 40); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then break; fi
  sleep 0.5
done

code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health")
if [ "$code" != "200" ]; then
  echo "✗ الخادم لم يبدأ (HTTP $code). السجل:"
  tail -30 /tmp/e2e-server.log
  exit 1
fi
echo "✓ الخادم يعمل على المنفذ $PORT"
echo ""

BASE="http://127.0.0.1:$PORT" bash scripts/e2e.sh
RC=$?

kill $SRV 2>/dev/null
wait $SRV 2>/dev/null
exit $RC
