import { createClient } from '@libsql/client';
import 'dotenv/config';

// 운영(Render, NODE_ENV=production): Turso 원격 DB
// 로컬 개발: local.db (순수 로컬 SQLite) — 운영 데이터에 전혀 영향 없음
const isProd = process.env.NODE_ENV === 'production';

let client;
if (isProd) {
  const url = process.env.TURSO_URL;
  const authToken = process.env.TURSO_TOKEN;
  if (!url || !authToken) {
    console.error('[DB] 운영 모드: TURSO_URL / TURSO_TOKEN 환경변수가 필요합니다.');
    process.exit(1);
  }
  client = createClient({ url, authToken });
  console.log('[DB] 운영 모드: Turso 원격 DB 사용');
} else {
  client = createClient({ url: 'file:local.db' });
  console.log('[DB] 로컬 모드: local.db 사용 (운영 DB 영향 없음)');
}
export const db = client;

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
  // 팀별 확정 일정 (관리자가 확정한 날짜, 팀당 최대 3개, 메모 포함)
  const NEW_CONFIRMED = `
    CREATE TABLE confirmed (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      team       TEXT NOT NULL,
      vote_date  TEXT NOT NULL,
      memo       TEXT NOT NULL DEFAULT '',
      start_time TEXT NOT NULL DEFAULT '15:00',
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
  // 누락 컬럼 보강 (점진적 마이그레이션)
  if (cols.length && cols.includes('id') && !cols.includes('memo')) {
    await db.execute("ALTER TABLE confirmed ADD COLUMN memo TEXT NOT NULL DEFAULT ''");
    console.log('[DB] confirmed.memo 컬럼 추가');
  }
  if (cols.length && cols.includes('id') && !cols.includes('start_time')) {
    await db.execute("ALTER TABLE confirmed ADD COLUMN start_time TEXT NOT NULL DEFAULT '15:00'");
    console.log('[DB] confirmed.start_time 컬럼 추가');
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
  // 과제 제출 (인원당 대표 링크 1개 + 과제명)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS submissions (
      team       TEXT NOT NULL,
      member     TEXT NOT NULL,
      title      TEXT NOT NULL DEFAULT '',
      url        TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (team, member)
    )
  `);
  // 기존 submissions 테이블에 title 컬럼 보강
  const subInfo = await db.execute('PRAGMA table_info(submissions)');
  const subCols = subInfo.rows.map((r) => r.name);
  if (!subCols.includes('title')) {
    await db.execute("ALTER TABLE submissions ADD COLUMN title TEXT NOT NULL DEFAULT ''");
    console.log('[DB] submissions.title 컬럼 추가');
  }
  console.log('[DB] 연결 및 테이블 준비 완료');
}
