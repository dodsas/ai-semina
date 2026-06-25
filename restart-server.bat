@echo off
chcp 65001 >nul
setlocal

REM ============================================================
REM  세미나 서버 재시작 (WSL 안에서 실행)
REM   - 이 프로젝트는 WSL(리눅스)에서 동작하므로 WSL 로 명령을 전달합니다.
REM   - 사용법:
REM       restart-server.bat          → 운영 모드 (Turso 운영 DB)
REM       restart-server.bat local    → 로컬 모드 (local.db, 운영 DB 영향 없음)
REM   - 운영 모드는 .env 의 TURSO_URL / TURSO_TOKEN 이 필요합니다.
REM   - 이 창을 닫으면 서버도 종료됩니다.
REM ============================================================

set "PROJ=/home/ysnam/projects/ai-semina"
set "NODE_ENV_VAL=production"
if /i "%~1"=="local" set "NODE_ENV_VAL="

if defined NODE_ENV_VAL (
  echo [모드] production  ^(Turso 운영 DB^)
) else (
  echo [모드] local  ^(local.db · 운영 DB 영향 없음^)
)
echo.
echo 기존 서버 종료 후 재시작합니다...
echo.

wsl bash -lc "cd '%PROJ%' && (pkill -f '[n]ode server.js' >/dev/null 2>&1; sleep 1); NODE_ENV='%NODE_ENV_VAL%' node server.js"

echo.
echo 서버가 종료되었습니다.
pause
