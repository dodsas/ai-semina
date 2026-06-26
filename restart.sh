#!/usr/bin/env bash
# 세미나 서버 재기동 + 로그 tail
#   사용법:
#     ./restart.sh            → 운영 모드 (Turso 운영 DB)
#     ./restart.sh local      → 로컬 모드 (local.db, 운영 DB 영향 없음)
#   - 기존 server.js 프로세스를 종료하고 백그라운드로 재기동한 뒤 로그를 tail 합니다.
#   - Ctrl+C 로 tail 을 빠져나가도 서버는 계속 실행됩니다(nohup).
set -uo pipefail
cd "$(dirname "$0")"

MODE="${1:-production}"
LOG="server.log"

echo "[restart] 기존 서버 종료..."
for pid in $(pgrep -f "[n]ode server.js"); do
  kill "$pid" 2>/dev/null && echo "  - killed pid $pid"
done
sleep 1

if [ "$MODE" = "local" ]; then
  echo "[restart] local 모드 (local.db)"
  NODE_ENV="" nohup node server.js > "$LOG" 2>&1 &
else
  echo "[restart] production 모드 (Turso 운영 DB)"
  NODE_ENV=production nohup node server.js > "$LOG" 2>&1 &
fi

echo "[restart] started pid=$! · log=$LOG"
echo "[restart] ---- 로그 (Ctrl+C 로 빠져나가도 서버는 계속 실행) ----"
sleep 1
tail -f "$LOG"
