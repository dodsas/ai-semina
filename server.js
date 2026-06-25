import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initDb, newSubmissionId } from './db.js';
import { TEAMS } from './teams.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// 세미나 고정 시간
const SEMINAR_TIME = '15:00';
const DATE_RE = /^2026-06-(0[1-9]|[12]\d|30)$/;

app.use(express.json());

// 쇼케이스(우리가 만든 사이트 모음)는 /showcase 로 진입
app.get('/showcase', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'showcase.html'));
});

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

// ---- 과제 제출 (인원당 대표 사이트 링크 1개) ----
function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().slice(0, 500);
  if (!s) return ''; // 빈 문자열 = 제출 취소
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s; // 스킴 생략 시 보정
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

// 팀 전체 제출 현황 (인원 명단 + 링크)
app.get('/api/submissions', async (req, res) => {
  const team = String(req.query.team || '');
  if (!TEAM_IDS.has(team)) {
    return res.status(400).json({ error: 'unknown team' });
  }
  try {
    const r = await db.execute({
      sql: 'SELECT id, member, title, url, updated_at FROM submissions WHERE team = ?',
      args: [team]
    });
    const byMember = {};
    for (const row of r.rows) byMember[row.member] = row;
    const members = (TEAMS.find((t) => t.id === team)?.members || []).map((m) => {
      const row = byMember[m.name];
      return {
        id: row?.id || null,
        name: m.name,
        dept: m.dept,
        title: row?.title || '',
        url: row?.url || '',
        updatedAt: row?.updated_at || null
      };
    });
    res.json({ team, members });
  } catch (err) {
    console.error('[GET /api/submissions]', err);
    res.status(500).json({ error: 'db error' });
  }
});

// ---- 사이트 아이콘 배치 (하루 1회, 아이콘 바이트를 DB 에 data URI 로 저장) ----
// 외부 파비콘 서비스는 일부 사이트에서 기본 지구본만 반환하므로, 사이트가 직접 선언한
// <link rel=icon> 을 우선 사용하고, 실패 시 /favicon.ico → DuckDuckGo 순으로 폴백.
// 한 번 받은 아이콘 바이트를 DB 에 저장해 두면 재시작/콜드스타트와 무관하게 즉시 렌더된다.

// 현재 서울(KST) 시각/날짜
function seoulNow() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

// 사이트 HTML 에서 <link rel=icon> 후보 URL 추출 (절대경로, 일반 icon 우선)
async function iconCandidatesFromHtml(siteUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const resp = await fetch(siteUrl, {
      redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (favicon-bot)' }
    });
    if (!resp.ok) return [];
    const html = (await resp.text()).slice(0, 300_000);
    const base = resp.url || siteUrl;
    const links = html.match(/<link\b[^>]*>/gi) || [];
    const normal = [], apple = [];
    for (const tag of links) {
      if (!/rel\s*=\s*["']?[^"'>]*icon/i.test(tag)) continue;
      const href = (tag.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (!href) continue;
      let abs;
      if (href.startsWith('data:')) abs = href;
      else { try { abs = new URL(href, base).toString(); } catch { continue; } }
      (/apple-touch-icon/i.test(tag) ? apple : normal).push(abs);
    }
    return [...normal, ...apple];
  } catch { return []; } finally { clearTimeout(timer); }
}

// 아이콘 URL → data URI (이미지 검증 + 용량 제한). data: 면 그대로 사용.
async function fetchImageDataUri(url) {
  if (url.startsWith('data:')) return url.length <= 200_000 ? url : null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const resp = await fetch(url, {
      redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (favicon-bot)' }
    });
    if (!resp.ok) return null;
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    const looksImg = ct.startsWith('image/') || ct.includes('icon') || ct.includes('svg');
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length || buf.length > 80_000) return null;
    if (!looksImg && !url.toLowerCase().match(/\.(ico|png|svg|gif|jpe?g|webp)(\?|$)/)) return null;
    const mime = (ct.split(';')[0] || '').startsWith('image/') ? ct.split(';')[0] : 'image/x-icon';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; } finally { clearTimeout(timer); }
}

// 한 사이트의 최선 아이콘 레코드 생성 (src + data URI)
async function buildIconRecord(siteUrl) {
  const candidates = await iconCandidatesFromHtml(siteUrl);
  try {
    const u = new URL(siteUrl);
    candidates.push(`${u.origin}/favicon.ico`);
    candidates.push(`https://icons.duckduckgo.com/ip3/${u.hostname}.ico`);
  } catch { /* 무시 */ }
  for (const c of candidates) {
    const data = await fetchImageDataUri(c);
    if (data) return { src: c.startsWith('data:') ? '' : c, data };
  }
  return { src: '', data: '' };
}

// 동시 실행 제한 풀
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return out;
}

// 전 사이트 아이콘 갱신 — 일일 배치 작업 중 하나
async function refreshAllIcons() {
  const r = await db.execute("SELECT DISTINCT url FROM submissions WHERE url <> ''");
  const urls = r.rows.map((x) => x.url);
  const recs = await mapPool(urls, 6, async (url) => ({ url, ...(await buildIconRecord(url)) }));
  for (const rec of recs) {
    await db.execute({
      sql: `INSERT INTO site_icons (url, icon_src, icon_data, fetched_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(url) DO UPDATE SET
              icon_src = excluded.icon_src, icon_data = excluded.icon_data, fetched_at = excluded.fetched_at`,
      args: [rec.url, rec.src || '', rec.data || '']
    });
  }
  const found = recs.filter((x) => x.data).length;
  return `아이콘 ${found}/${urls.length}`;
}

// ---- 공통 일일 배치 ----
// 매일 1회(08:30 KST) 실행되어야 하는 작업들을 이 목록에 묶는다.
// 추후 기능은 BATCH_TASKS 에 { name, run } 으로 추가하면 같은 배치/새로고침에 함께 실행된다.
const BATCH_TASKS = [
  { name: 'icons', run: refreshAllIcons }
];

const BATCH_NAME = 'daily';
let batchRunning = false;

async function lastBatchAt() {
  const r = await db.execute({
    sql: 'SELECT ran_at FROM batch_runs WHERE name = ? ORDER BY ran_at DESC LIMIT 1',
    args: [BATCH_NAME]
  });
  return r.rows[0]?.ran_at || null;
}

async function batchRanToday() {
  const { date } = seoulNow();
  const r = await db.execute({
    sql: 'SELECT 1 FROM batch_runs WHERE name = ? AND run_date = ?',
    args: [BATCH_NAME, date]
  });
  return r.rows.length > 0;
}

// 등록된 모든 배치 작업을 순차 실행하고 결과를 기록
async function runDailyBatch(trigger = 'auto') {
  if (batchRunning) return { skipped: 'running' };
  batchRunning = true;
  const started = Date.now();
  try {
    const details = [];
    for (const task of BATCH_TASKS) {
      try {
        details.push(await task.run());
      } catch (e) {
        console.error(`[batch:${task.name}] 실패:`, e);
        details.push(`${task.name} 실패`);
      }
    }
    const { date } = seoulNow();
    const detail = `${details.join(' · ')} (${trigger}, ${Math.round((Date.now() - started) / 1000)}s)`;
    await db.execute({
      sql: `INSERT INTO batch_runs (name, run_date, ran_at, detail)
            VALUES (?, ?, datetime('now'), ?)
            ON CONFLICT(name, run_date) DO UPDATE SET ran_at = excluded.ran_at, detail = excluded.detail`,
      args: [BATCH_NAME, date, detail]
    });
    console.log(`[batch] 완료 · ${detail}`);
    return { ok: true, detail, ranAt: await lastBatchAt() };
  } catch (err) {
    console.error('[batch] 실패:', err);
    return { error: 'batch failed' };
  } finally {
    batchRunning = false;
  }
}

// 기동 시 오늘 미실행이면 실행 + 매일 08:30(KST) 보장
function startDailyBatchScheduler() {
  batchRanToday()
    .then((ran) => {
      if (ran) { console.log('[batch] 오늘 이미 실행됨 → 기동 시 스킵'); }
      else { console.log('[batch] 오늘 미실행 → 기동 시 실행'); runDailyBatch('startup'); }
    })
    .catch((e) => console.error('[batch] 기동 확인 실패:', e));

  // 5분마다: 08:30(KST) 이 지났고 오늘 미실행이면 실행
  setInterval(async () => {
    try {
      const { hour, minute } = seoulNow();
      const past0830 = hour > 8 || (hour === 8 && minute >= 30);
      if (past0830 && !(await batchRanToday())) runDailyBatch('scheduled');
    } catch (e) {
      console.error('[batch] 스케줄 확인 실패:', e);
    }
  }, 5 * 60 * 1000);
}

// 전체 팀 제출 사이트 모음 (쇼케이스용 — 팀 구분 없이 제출된 사이트만)
app.get('/api/all-submissions', async (_req, res) => {
  try {
    const [subs, icons] = await Promise.all([
      db.execute("SELECT id, team, member, title, url, summary, category, updated_at FROM submissions WHERE url <> '' ORDER BY updated_at"),
      db.execute('SELECT url, icon_src, icon_data FROM site_icons')
    ]);
    const iconByUrl = {};
    for (const row of icons.rows) iconByUrl[row.url] = row;
    // 부서 정보는 teams.js 에서 보강
    const deptOf = (team, member) =>
      (TEAMS.find((t) => t.id === team)?.members || []).find((m) => m.name === member)?.dept || '';
    const sites = subs.rows.map((row) => {
      const ic = iconByUrl[row.url];
      return {
        id: row.id || null,
        member: row.member,
        dept: deptOf(row.team, row.member),
        title: row.title || '',
        url: row.url,
        summary: row.summary || '',
        category: row.category || '',
        favicon: (ic && (ic.icon_data || ic.icon_src)) || null, // DB 저장 아이콘 우선
        updatedAt: row.updated_at || null
      };
    });
    res.json({ sites, count: sites.length, batchUpdatedAt: await lastBatchAt() });
  } catch (err) {
    console.error('[GET /api/all-submissions]', err);
    res.status(500).json({ error: 'db error' });
  }
});

// 사이트 요약·카테고리 수정 (쇼케이스 카드 더블클릭 수정) — 과제 고유키(id)로 식별
app.post('/api/submissions/summary', async (req, res) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  if (!id) return res.status(400).json({ error: 'missing id' });
  const sets = [], args = [], out = {};
  if (typeof req.body?.summary === 'string') {
    const summary = req.body.summary.trim().slice(0, 300);
    sets.push('summary = ?'); args.push(summary); out.summary = summary;
  }
  if (typeof req.body?.category === 'string') {
    const category = req.body.category.trim().slice(0, 40);
    sets.push('category = ?'); args.push(category); out.category = category;
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  args.push(id);
  try {
    const r = await db.execute({
      sql: `UPDATE submissions SET ${sets.join(', ')} WHERE id = ?`,
      args
    });
    if (!r.rowsAffected) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, id, ...out });
  } catch (err) {
    console.error('[POST /api/submissions/summary]', err);
    res.status(500).json({ error: 'db error' });
  }
});

// 새로고침 — 공통 일일 배치를 수동 실행 후 최신 상태 반환 (사이트 상단 새로고침 버튼)
app.post('/api/refresh', async (_req, res) => {
  if (batchRunning) {
    return res.status(202).json({ running: true, batchUpdatedAt: await lastBatchAt() });
  }
  const result = await runDailyBatch('manual');
  if (result.error) return res.status(500).json(result);
  res.json({ ok: true, ...result, batchUpdatedAt: await lastBatchAt() });
});

// 본인 제출 링크 저장 (빈 url 이면 삭제 = 제출 취소)
app.post('/api/submissions', async (req, res) => {
  const { team, member } = req.body || {};
  if (!TEAM_IDS.has(team) || !memberNames(team).has(member)) {
    return res.status(400).json({ error: 'unknown member' });
  }
  const url = normalizeUrl(req.body?.url);
  const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 100) : '';
  if (url === null) {
    return res.status(400).json({ error: 'invalid url' });
  }
  try {
    if (!url) {
      await db.execute({
        sql: 'DELETE FROM submissions WHERE team = ? AND member = ?',
        args: [team, member]
      });
      return res.json({ ok: true, url: '', title: '' });
    }
    await db.execute({
      sql: `INSERT INTO submissions (id, team, member, title, url) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(team, member) DO UPDATE SET
              title = excluded.title, url = excluded.url, updated_at = datetime('now')`,
      args: [newSubmissionId(), team, member, title, url]
    });
    // 응답에 과제 고유키 동봉
    const idRow = await db.execute({
      sql: 'SELECT id FROM submissions WHERE team = ? AND member = ?',
      args: [team, member]
    });
    res.json({ ok: true, id: idRow.rows[0]?.id || null, url, title });
  } catch (err) {
    console.error('[POST /api/submissions]', err);
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

// ---- Render 무료 티어 keep-alive ----
// 제출된 모든 사이트(+서버 자신)에 10분마다 GET 을 보내 슬립을 방지합니다.
// 서버 자신도 핑해야 본 서버가 잠들지 않아 인터벌이 계속 동작합니다.
const KEEPALIVE_MS = 10 * 60 * 1000; // 10분
const KEEPALIVE_ENABLED =
  process.env.NODE_ENV === 'production' || process.env.KEEPALIVE === '1';

async function pingUrl(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
    return res.status;
  } catch (err) {
    return `ERR(${err.name || 'fetch'})`;
  } finally {
    clearTimeout(timer);
  }
}

async function keepAliveTick() {
  try {
    const targets = new Set();
    // 서버 자신을 깨워 인터벌이 계속 돌게 함 (Render 가 자동 주입하는 외부 URL)
    if (process.env.RENDER_EXTERNAL_URL) targets.add(process.env.RENDER_EXTERNAL_URL);
    const r = await db.execute("SELECT DISTINCT url FROM submissions WHERE url <> ''");
    for (const row of r.rows) if (row.url) targets.add(row.url);
    if (!targets.size) return;
    const list = [...targets];
    const results = await Promise.all(list.map(pingUrl));
    const ok = results.filter((s) => typeof s === 'number' && s < 400).length;
    console.log(`[keepalive] ${new Date().toISOString()} · ${list.length}곳 ping · 정상 ${ok}`);
  } catch (err) {
    console.error('[keepalive] tick 실패:', err);
  }
}

function startKeepAlive() {
  if (!KEEPALIVE_ENABLED) {
    console.log('[keepalive] 비활성 (운영 모드 아님). 로컬 테스트는 KEEPALIVE=1 로 실행');
    return;
  }
  console.log('[keepalive] 활성 · 10분 주기로 제출 사이트 + 서버 자신 ping');
  setTimeout(keepAliveTick, 30 * 1000); // 기동 30초 후 첫 실행
  setInterval(keepAliveTick, KEEPALIVE_MS);
}

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] http://localhost:${PORT} 에서 실행 중`);
      startKeepAlive();
      startDailyBatchScheduler();
    });
  })
  .catch((err) => {
    console.error('[server] 시작 실패:', err);
    process.exit(1);
  });
