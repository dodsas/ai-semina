import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initDb } from './db.js';
import { TEAMS } from './teams.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// 세미나 고정 시간
const SEMINAR_TIME = '15:00';
const DATE_RE = /^2026-06-(0[1-9]|[12]\d|30)$/;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TEAM_IDS = new Set(TEAMS.map((t) => t.id));
const memberNames = (teamId) =>
  new Set((TEAMS.find((t) => t.id === teamId)?.members || []).map((m) => m.name));

// --- 관리자 인증 (메모리 토큰; 재시작 시 재로그인 필요) ---
const adminTokens = new Set();

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token && adminTokens.has(token)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const ADMIN = process.env.ADMIN;
  const PW = process.env.PW;
  if (!ADMIN || !PW) {
    return res.status(500).json({ error: 'admin not configured' });
  }
  if (username === ADMIN && password === PW) {
    const token = crypto.randomBytes(24).toString('hex');
    adminTokens.add(token);
    return res.json({ ok: true, token });
  }
  res.status(401).json({ error: 'invalid credentials' });
});

// 팀/인원 목록 + 고정 세미나 시간
app.get('/api/teams', (_req, res) => {
  res.json({ teams: TEAMS, seminarTime: SEMINAR_TIME });
});

// 특정 팀의 투표 현황 (날짜별 투표자 목록)
app.get('/api/votes', async (req, res) => {
  const team = String(req.query.team || '');
  if (!TEAM_IDS.has(team)) {
    return res.status(400).json({ error: 'unknown team' });
  }
  try {
    // 두 조회를 한 번의 batch 로 묶어 왕복 최소화
    const [result, conf] = await db.batch(
      [
        { sql: 'SELECT member, vote_date FROM votes WHERE team = ? ORDER BY vote_date', args: [team] },
        { sql: 'SELECT vote_date, memo, start_time FROM confirmed WHERE team = ? ORDER BY vote_date', args: [team] }
      ],
      'read'
    );
    // { '2026-06-12': ['김양헌', ...], ... }
    const byDate = {};
    for (const row of result.rows) {
      (byDate[row.vote_date] ??= []).push(row.member);
    }
    const confirmed = conf.rows.map((r) => ({
      date: r.vote_date,
      memo: r.memo || '',
      time: r.start_time || SEMINAR_TIME
    }));
    res.json({ team, votes: byDate, confirmed, seminarTime: SEMINAR_TIME });
  } catch (err) {
    console.error('[GET /api/votes]', err);
    res.status(500).json({ error: 'db error' });
  }
});

const MAX_CONFIRMED = 3;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

async function confirmedDates(team) {
  const r = await db.execute({
    sql: 'SELECT vote_date, memo, start_time FROM confirmed WHERE team = ? ORDER BY vote_date',
    args: [team]
  });
  return r.rows.map((row) => ({
    date: row.vote_date,
    memo: row.memo || '',
    time: row.start_time || SEMINAR_TIME
  }));
}

// 관리자: 일정 확정 토글 (팀당 최대 3개, 메모/시작시간 포함) / clearAll 로 전체 취소
app.post('/api/confirm', requireAdmin, async (req, res) => {
  const { team, date, clearAll } = req.body || {};
  const memo = typeof req.body?.memo === 'string' ? req.body.memo.trim().slice(0, 200) : '';
  const time = TIME_RE.test(req.body?.time) ? req.body.time : SEMINAR_TIME;
  if (!TEAM_IDS.has(team)) {
    return res.status(400).json({ error: 'unknown team' });
  }
  try {
    if (clearAll) {
      await db.execute({ sql: 'DELETE FROM confirmed WHERE team = ?', args: [team] });
      return res.json({ ok: true, confirmed: [] });
    }
    if (!DATE_RE.test(date)) {
      return res.status(400).json({ error: 'invalid date' });
    }
    const existing = await db.execute({
      sql: 'SELECT id FROM confirmed WHERE team = ? AND vote_date = ?',
      args: [team, date]
    });
    if (existing.rows.length) {
      // 이미 확정된 날짜 → 해제
      await db.execute({
        sql: 'DELETE FROM confirmed WHERE team = ? AND vote_date = ?',
        args: [team, date]
      });
    } else {
      const current = await confirmedDates(team);
      if (current.length >= MAX_CONFIRMED) {
        return res
          .status(400)
          .json({ error: 'max confirmed', max: MAX_CONFIRMED, confirmed: current });
      }
      await db.execute({
        sql: 'INSERT INTO confirmed (team, vote_date, memo, start_time) VALUES (?, ?, ?, ?)',
        args: [team, date, memo, time]
      });
    }
    res.json({ ok: true, confirmed: await confirmedDates(team) });
  } catch (err) {
    console.error('[POST /api/confirm]', err);
    res.status(500).json({ error: 'db error' });
  }
});

// ---- 인원 추가정보 (구독 중인 유료 AI 계정) ----
const ALLOWED_AI = new Set(['CLAUDE', 'CHATGPT', 'NONE', 'OTHER']);

// 본인 추가정보 조회 (프리필용)
app.get('/api/member-info', async (req, res) => {
  const team = String(req.query.team || '');
  const member = String(req.query.member || '');
  if (!TEAM_IDS.has(team) || !memberNames(team).has(member)) {
    return res.status(400).json({ error: 'unknown member' });
  }
  try {
    const r = await db.execute({
      sql: 'SELECT accounts, etc_text FROM member_info WHERE team = ? AND member = ?',
      args: [team, member]
    });
    const row = r.rows[0];
    res.json({
      accounts: row?.accounts ? String(row.accounts).split(',').filter(Boolean) : [],
      etc: row?.etc_text || ''
    });
  } catch (err) {
    console.error('[GET /api/member-info]', err);
    res.status(500).json({ error: 'db error' });
  }
});

// 본인 추가정보 저장
app.post('/api/member-info', async (req, res) => {
  const { team, member } = req.body || {};
  if (!TEAM_IDS.has(team) || !memberNames(team).has(member)) {
    return res.status(400).json({ error: 'unknown member' });
  }
  let accounts = Array.isArray(req.body.accounts)
    ? [...new Set(req.body.accounts.filter((a) => ALLOWED_AI.has(a)))]
    : [];
  // '없음'은 단독 선택
  if (accounts.includes('NONE')) accounts = ['NONE'];
  const etc =
    accounts.includes('OTHER') && typeof req.body.etc === 'string'
      ? req.body.etc.trim().slice(0, 100)
      : '';
  try {
    await db.execute({
      sql: `INSERT INTO member_info (team, member, accounts, etc_text) VALUES (?, ?, ?, ?)
            ON CONFLICT(team, member) DO UPDATE SET
              accounts = excluded.accounts, etc_text = excluded.etc_text, updated_at = datetime('now')`,
      args: [team, member, accounts.join(','), etc]
    });
    res.json({ ok: true, accounts, etc });
  } catch (err) {
    console.error('[POST /api/member-info]', err);
    res.status(500).json({ error: 'db error' });
  }
});

// 관리자: 팀 전체 인원의 추가정보 조회
app.get('/api/admin/member-info', requireAdmin, async (req, res) => {
  const team = String(req.query.team || '');
  if (!TEAM_IDS.has(team)) {
    return res.status(400).json({ error: 'unknown team' });
  }
  try {
    const r = await db.execute({
      sql: 'SELECT member, accounts, etc_text, updated_at FROM member_info WHERE team = ?',
      args: [team]
    });
    const byMember = {};
    for (const row of r.rows) byMember[row.member] = row;
    const members = (TEAMS.find((t) => t.id === team)?.members || []).map((m) => {
      const row = byMember[m.name];
      return {
        name: m.name,
        dept: m.dept,
        accounts: row?.accounts ? String(row.accounts).split(',').filter(Boolean) : [],
        etc: row?.etc_text || '',
        updatedAt: row?.updated_at || null
      };
    });
    res.json({ team, members });
  } catch (err) {
    console.error('[GET /api/admin/member-info]', err);
    res.status(500).json({ error: 'db error' });
  }
});

// 관리자: 특정 팀의 투표·확정 데이터 전체 초기화
app.post('/api/admin/clear', requireAdmin, async (req, res) => {
  const { team } = req.body || {};
  if (!TEAM_IDS.has(team)) {
    return res.status(400).json({ error: 'unknown team' });
  }
  try {
    await db.execute({ sql: 'DELETE FROM votes WHERE team = ?', args: [team] });
    await db.execute({ sql: 'DELETE FROM confirmed WHERE team = ?', args: [team] });
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/admin/clear]', err);
    res.status(500).json({ error: 'db error' });
  }
});

// 본인의 투표 저장 (선택한 날짜 집합으로 교체)
app.post('/api/votes', async (req, res) => {
  const { team, member, dates } = req.body || {};
  if (!TEAM_IDS.has(team)) {
    return res.status(400).json({ error: 'unknown team' });
  }
  if (!member || !memberNames(team).has(member)) {
    return res.status(400).json({ error: 'unknown member' });
  }
  if (!Array.isArray(dates)) {
    return res.status(400).json({ error: 'dates must be an array' });
  }
  // 2026-06-DD 형태만 허용
  const valid = dates.filter((d) => /^2026-06-(0[1-9]|[12]\d|30)$/.test(d));

  try {
    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: 'DELETE FROM votes WHERE team = ? AND member = ?',
        args: [team, member]
      });
      for (const d of valid) {
        await tx.execute({
          sql: 'INSERT INTO votes (team, member, vote_date) VALUES (?, ?, ?)',
          args: [team, member, d]
        });
      }
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }
    res.json({ ok: true, saved: valid.length });
  } catch (err) {
    console.error('[POST /api/votes]', err);
    res.status(500).json({ error: 'db error' });
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] http://localhost:${PORT} 에서 실행 중`);
    });
  })
  .catch((err) => {
    console.error('[server] 시작 실패:', err);
    process.exit(1);
  });
