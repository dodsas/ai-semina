import { createClient } from '@libsql/client';
import 'dotenv/config';

const url = process.env.TURSO_URL;
const authToken = process.env.TURSO_TOKEN;

if (!url || !authToken) {
  console.error('[DB] TURSO_URL / TURSO_TOKEN 환경변수가 설정되지 않았습니다.');
  console.error('     로컬: .env 파일,  운영(Render): 환경변수에 설정하세요.');
  process.exit(1);
}

// 원격 Turso 클라이언트. (임베디드 레플리카는 요청당 동기화 오버헤드로 오히려 느려
// 사용하지 않음 — 대신 /api/votes 의 조회를 batch 로 묶어 왕복을 최소화)
export const db = createClient({ url, authToken });

// 투표 데이터는 DB 에 영구 저장됩니다.
export async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS votes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      team       TEXT NOT NULL,
      member     TEXT NOT NULL,
      vote_date  TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (team, member, vote_date)
    )
  `);
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_votes_team ON votes (team)`
  );
  // 팀별 확정 일정 (관리자가 확정한 날짜, 팀당 최대 3개)
  const NEW_CONFIRMED = `
    CREATE TABLE confirmed (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      team       TEXT NOT NULL,
      vote_date  TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (team, vote_date)
    )
  `;
  const info = await db.execute('PRAGMA table_info(confirmed)');
  const cols = info.rows.map((r) => r.name);
  if (cols.length === 0) {
    await db.execute(NEW_CONFIRMED);
  } else if (!cols.includes('id')) {
    // 구 스키마(team PRIMARY KEY, 단일) → 다중 허용 스키마로 마이그레이션
    await db.execute('ALTER TABLE confirmed RENAME TO confirmed_old');
    await db.execute(NEW_CONFIRMED);
    await db.execute(
      'INSERT OR IGNORE INTO confirmed (team, vote_date) SELECT team, vote_date FROM confirmed_old'
    );
    await db.execute('DROP TABLE confirmed_old');
    console.log('[DB] confirmed 테이블 마이그레이션 완료 (다중 확정 허용)');
  }
  // 인원 추가정보 (구독 중인 유료 AI 계정)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS member_info (
      team       TEXT NOT NULL,
      member     TEXT NOT NULL,
      accounts   TEXT NOT NULL DEFAULT '',
      etc_text   TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (team, member)
    )
  `);
  console.log('[DB] 연결 및 테이블 준비 완료');
}
