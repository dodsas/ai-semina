import { createClient } from '@libsql/client';
import crypto from 'node:crypto';
import { TEAMS } from './teams.js';
import 'dotenv/config';

// 과제(제출)별 고유키 생성기
export const newSubmissionId = () => 's_' + crypto.randomBytes(12).toString('hex');

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
  // 과제별 고유키(id) 컬럼 추가 + 유니크 인덱스
  if (!subCols.includes('id')) {
    await db.execute("ALTER TABLE submissions ADD COLUMN id TEXT");
    await db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_id ON submissions (id)');
    console.log('[DB] submissions.id(고유키) 컬럼 추가');
  }
  // 사이트 요약 컬럼 (더블클릭 수정 가능)
  if (!subCols.includes('summary')) {
    await db.execute("ALTER TABLE submissions ADD COLUMN summary TEXT NOT NULL DEFAULT ''");
    console.log('[DB] submissions.summary 컬럼 추가');
  }
  // 사이트 카테고리 컬럼
  if (!subCols.includes('category')) {
    await db.execute("ALTER TABLE submissions ADD COLUMN category TEXT NOT NULL DEFAULT ''");
    console.log('[DB] submissions.category 컬럼 추가');
  }
  // 쇼케이스 링크 클릭수 컬럼
  if (!subCols.includes('clicks')) {
    await db.execute("ALTER TABLE submissions ADD COLUMN clicks INTEGER NOT NULL DEFAULT 0");
    console.log('[DB] submissions.clicks 컬럼 추가');
  }
  // 고유키 누락 행 백필 (매 기동 시 보강 — 구버전으로 들어온 행 대비)
  const missing = await db.execute("SELECT team, member FROM submissions WHERE id IS NULL OR id = ''");
  for (const row of missing.rows) {
    await db.execute({
      sql: 'UPDATE submissions SET id = ? WHERE team = ? AND member = ?',
      args: [newSubmissionId(), row.team, row.member]
    });
  }
  if (missing.rows.length) console.log(`[DB] 고유키 누락 ${missing.rows.length}건 백필`);

  // 사이트 아이콘 캐시 (하루 1회 배치로 갱신, 바이트를 data URI 로 저장)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS site_icons (
      url        TEXT PRIMARY KEY,
      icon_src   TEXT NOT NULL DEFAULT '',
      icon_data  TEXT NOT NULL DEFAULT '',
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // 배치 실행 기록 (name + 실행일(KST) 기준, 하루 1회 보장)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS batch_runs (
      name     TEXT NOT NULL,
      run_date TEXT NOT NULL,
      ran_at   TEXT NOT NULL DEFAULT (datetime('now')),
      detail   TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (name, run_date)
    )
  `);

  // 사이트 HTML 해시 (하루 1회 변경 감지 + NEW 마커)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS site_pages (
      url        TEXT PRIMARY KEY,
      html_hash  TEXT NOT NULL DEFAULT '',
      is_new     INTEGER NOT NULL DEFAULT 0,
      checked_at TEXT,
      changed_at TEXT
    )
  `);

  // 사이트별 요청(피드백) — 등록 시 담당자 이메일로 발송, 완료 체크 가능
  await db.execute(`
    CREATE TABLE IF NOT EXISTS requests (
      id            TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      content       TEXT NOT NULL,
      requester     TEXT NOT NULL DEFAULT '',
      done          INTEGER NOT NULL DEFAULT 0,
      emailed       INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_requests_sub ON requests (submission_id)');
  // 요청자 이메일(완료 알림 콜백용) + 알림 발송 여부 컬럼 보강
  const reqInfo = await db.execute('PRAGMA table_info(requests)');
  const reqCols = reqInfo.rows.map((r) => r.name);
  if (!reqCols.includes('requester_email')) {
    await db.execute("ALTER TABLE requests ADD COLUMN requester_email TEXT NOT NULL DEFAULT ''");
    console.log('[DB] requests.requester_email 컬럼 추가');
  }
  if (!reqCols.includes('notified')) {
    await db.execute('ALTER TABLE requests ADD COLUMN notified INTEGER NOT NULL DEFAULT 0');
    console.log('[DB] requests.notified 컬럼 추가');
  }

  // 팀별 세미나 인원 (관리자가 추가/삭제). 비어 있으면 teams.js 로 최초 시드.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS team_members (
      team  TEXT NOT NULL,
      name  TEXT NOT NULL,
      dept  TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      sort  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (team, name)
    )
  `);
  // 기존 team_members 테이블에 email 컬럼 보강
  const tmInfo = await db.execute('PRAGMA table_info(team_members)');
  if (!tmInfo.rows.some((r) => r.name === 'email')) {
    await db.execute("ALTER TABLE team_members ADD COLUMN email TEXT NOT NULL DEFAULT ''");
    console.log('[DB] team_members.email 컬럼 추가');
  }
  const cnt = await db.execute('SELECT COUNT(*) AS n FROM team_members');
  if (Number(cnt.rows[0]?.n || 0) === 0) {
    let seeded = 0;
    for (const t of TEAMS) {
      let i = 0;
      for (const m of t.members) {
        await db.execute({
          sql: 'INSERT INTO team_members (team, name, dept, sort) VALUES (?, ?, ?, ?)',
          args: [t.id, m.name, m.dept || '', i++]
        });
        seeded++;
      }
    }
    console.log(`[DB] team_members 최초 시드 완료 (${seeded}명)`);
  }
  console.log('[DB] 연결 및 테이블 준비 완료');
}
