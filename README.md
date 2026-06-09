# AI 세미나 일정 투표

세미나 1·2·3팀이 **2026년 6월** 중 가능한 날짜에 투표하는 웹 서비스입니다.

- 상단 탭에서 **세미나 1팀 / 2팀 / 3팀** 선택
- 팀 탭에서 **본인 이름 클릭** (투표 완료자는 접힌 "투표 완료" 섹션으로 이동)
- 6월 달력에서 가능한 **날짜 선택 후 "확인"** → 투표 저장
- 투표 데이터는 **Turso(libSQL) DB** 에 영구 저장 (재배포·재시작에도 유지)
- **세미나 시간은 15:00 고정** (사이트 안내 및 확정 일정에 표시)
- **관리자 로그인** 후 팀별 **일정 확정** 가능 — 확정 날짜는 달력에 강조색 + "일정확정 15:00" 로 표시

## 기술 구성

- Node.js + Express (정적 프론트엔드 + REST API)
- Turso (`@libsql/client`)
- 프레임워크 없는 순수 HTML/CSS/JS 프론트엔드

## 로컬 실행

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # 파일 변경 시 자동 재시작
```

> **DB 분리**: 로컬 실행(`NODE_ENV` 미설정)은 **로컬 SQLite 파일 `local.db`** 를 사용합니다.
> 운영 Turso 데이터에 전혀 영향을 주지 않습니다. (`local.db` 는 `.gitignore` 로 제외)
> 운영(Render)은 `NODE_ENV=production` 이라 Turso 원격 DB를 사용합니다.

## 환경변수

| 변수 | 설명 |
|------|------|
| `TURSO_URL` | Turso DB 주소 (`libsql://...turso.io`) |
| `TURSO_TOKEN` | Turso 인증 토큰 (JWT) |
| `ADMIN` | 관리자 로그인 아이디 |
| `PW` | 관리자 로그인 비밀번호 |
| `PORT` | (선택) 서버 포트, 기본 3000 |

> ⚠️ `.env` 는 `.gitignore` 에 포함되어 **커밋되지 않습니다.** 운영 환경에는 절대 올리지 마세요.

## Render 배포 (Blueprint)

배포 관련 파일: `render.yaml`(Blueprint 정의), `.node-version`(Node 22 고정), `package.json`(start 스크립트)

1. 이 저장소를 GitHub 에 push (`.env` 는 `.gitignore` 로 제외됨)
2. Render 대시보드 → **New +** → **Blueprint** → 저장소 선택 (`render.yaml` 자동 인식)
3. 최초 배포 화면에서 환경변수 입력: `TURSO_URL`, `TURSO_TOKEN`, `ADMIN`, `PW`
4. **Apply** → 빌드(`npm ci`) 후 자동 실행(`npm start`). 이후 push 시 자동 재배포

> Turso DB 가 도쿄(ap-northeast-1) 리전이라 `render.yaml` 의 서비스 리전을 `singapore`(가장 가까운 무료 리전)로 지정했습니다.

## API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/teams` | 팀/인원 목록 + 고정 세미나 시간 |
| GET | `/api/votes?team=team1` | 해당 팀의 날짜별 투표 현황 + 확정 일정 |
| POST | `/api/votes` | 본인 투표 저장 `{ team, member, dates: [] }` (기존 투표는 교체) |
| POST | `/api/admin/login` | 관리자 로그인 `{ username, password }` → `{ token }` |
| POST | `/api/confirm` | (관리자) 일정 확정 `{ team, date }` — `date` 없으면 확정 취소. `Authorization: Bearer <token>` 필요 |
