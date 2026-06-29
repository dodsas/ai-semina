import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { db, initDb, newSubmissionId } from './db.js';
import { TEAMS } from './teams.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// 세미나 고정 시간
const SEMINAR_TIME = '15:00';
const DATE_RE = /^2026-06-(0[1-9]|[12]\d|30)$/;

app.use(express.json());

// 메인(/)·/showcase = 과제 쇼케이스, 세미나 일정 앱은 /seminar
app.get(['/', '/showcase'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'showcase.html'));
});
app.get('/seminar', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

const TEAM_IDS = new Set(TEAMS.map((t) => t.id));

// 팀별 인원은 DB(team_members)에서 관리. 메모리 캐시로 동기 조회.
let membersByTeam = {};
async function loadMembersCache() {
  const r = await db.execute('SELECT team, name, dept, email FROM team_members ORDER BY team, sort, rowid');
  const m = {};
  for (const t of TEAMS) m[t.id] = [];
  for (const row of r.rows) (m[row.team] ??= []).push({ name: row.name, dept: row.dept, email: row.email || '' });
  membersByTeam = m;
}
const teamMembers = (teamId) => membersByTeam[teamId] || [];
const memberNames = (teamId) => new Set(teamMembers(teamId).map((m) => m.name));
const deptOf = (teamId, name) => teamMembers(teamId).find((m) => m.name === name)?.dept || '';
const emailOf = (teamId, name) => teamMembers(teamId).find((m) => m.name === name)?.email || '';

// 이메일 정규화: 빈 문자열은 허용(삭제), 형식 불일치는 null
function normalizeEmail(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim().slice(0, 100);
  if (!s) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

// --- 메일 발송 ---
// 1순위: Resend HTTP API(포트 443 — Render 등 PaaS 에서 SMTP 차단 우회)
// 2순위: SMTP(nodemailer). 둘 다 없으면 발송 스킵(요청은 저장됨).
const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_USER || 'onboarding@resend.dev';
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE) === '1' || Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000
  });
}

if (BREVO_API_KEY) console.log(`[mail] Brevo(HTTP) 발송 활성 · from=${MAIL_FROM}`);
else if (RESEND_API_KEY) console.log(`[mail] Resend(HTTP) 발송 활성 · from=${MAIL_FROM}`);
else if (mailer) console.log('[mail] SMTP 발송 활성');
else console.log('[mail] 발송 수단 미설정 — 요청은 저장되며 메일은 발송되지 않음');

// 메일 본문에 들어갈 쇼케이스 전체 URL (고정, 필요 시 SHOWCASE_URL 로 override)
const SHOWCASE_URL = process.env.SHOWCASE_URL || 'https://ai-semina-ap4u.onrender.com/showcase';
const showcaseLink = () => SHOWCASE_URL;

// 통합 발송: Brevo → Resend → SMTP 순으로 시도 (앞 것이 실패/미설정이면 다음으로)
async function deliverMail({ to, subject, text }) {
  if (BREVO_API_KEY) {
    try {
      const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: MAIL_FROM, name: '과제 쇼케이스' },
          to: [{ email: to }],
          subject,
          textContent: text
        }),
        signal: AbortSignal.timeout(10000)
      });
      if (resp.ok) return true;
      const errText = await resp.text().catch(() => '');
      console.error('[mail] Brevo 실패:', resp.status, errText.slice(0, 300));
    } catch (err) {
      console.error('[mail] Brevo 오류:', err.message);
    }
  }
  if (RESEND_API_KEY) {
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text }),
        signal: AbortSignal.timeout(10000)
      });
      if (resp.ok) return true;
      const errText = await resp.text().catch(() => '');
      console.error('[mail] Resend 실패:', resp.status, errText.slice(0, 300));
      // Resend 실패 시 SMTP 폴백 시도
    } catch (err) {
      console.error('[mail] Resend 오류:', err.message);
    }
  }
  if (mailer) {
    try {
      await mailer.sendMail({ from: MAIL_FROM, to, subject, text });
      return true;
    } catch (err) {
      console.error('[mail] SMTP 실패:', err.message);
    }
  }
  return false;
}

// 담당자에게 새 요청 알림
function sendRequestMail(to, site, content, requesterEmail) {
  return deliverMail({
    to,
    subject: `[과제 쇼케이스] "${site.title || site.url}" 사이트에 새 요청이 등록되었습니다`,
    text:
      `사이트: ${site.title || ''} (${site.url})\n` +
      `요청자: ${requesterEmail || '익명'}\n\n` +
      `요청 내용:\n${content}\n\n` +
      `쇼케이스에서 확인: ${showcaseLink()}`
  });
}

// 요청자에게 작업 완료 콜백 알림
function sendDoneMail(to, site, content) {
  return deliverMail({
    to,
    subject: `[과제 쇼케이스] 요청하신 작업이 완료되었습니다 — "${site.title || site.url}"`,
    text:
      `요청하신 내용이 처리 완료되었습니다. 🎉\n\n` +
      `사이트: ${site.title || ''} (${site.url})\n\n` +
      `요청 내용:\n${content}\n\n` +
      `쇼케이스에서 확인: ${showcaseLink()}`
  });
}

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
  // 공개 API — 이메일(개인정보)은 노출하지 않음
  const teams = TEAMS.map((t) => ({
    id: t.id,
    name: t.name,
    members: teamMembers(t.id).map((m) => ({ name: m.name, dept: m.dept }))
  }));
  res.json({ teams, seminarTime: SEMINAR_TIME });
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
    const members = teamMembers(team).map((m) => {
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
    const members = teamMembers(team).map((m) => {
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

// 사이트 HTML 을 받아 sha256 해시 계산 (실패 시 null)
async function fetchPageHash(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const resp = await fetch(url, {
      redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (change-bot)' }
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    return crypto.createHash('sha256').update(html).digest('hex');
  } catch { return null; } finally { clearTimeout(timer); }
}

// 사이트 변경 감지.
//  - 기준 해시(baseline=html_hash)는 하루 1회만 전진 (배치의 첫 실행 = startup/scheduled/그날 첫 manual).
//  - 새로고침(같은 날 추가 실행)은 baseline 과 비교해 다르면 UPDATED 마커를 켜기만 하고(끄지 않음),
//    baseline 은 그대로 둔다 → 마커는 하루 유지되면서 새로고침으로도 변경을 즉시 감지.
//  - 다음날 첫 실행에서 baseline 이 전진하며 마커를 재평가(변경 없으면 해제).
//  - 최초 1회(테이블 비어있음)는 기준선만 잡고 마커 없음.
async function checkSiteChanges(trigger = 'auto') {
  const { date } = seoulNow();
  const baselineDone = (await db.execute({
    sql: "SELECT 1 FROM batch_runs WHERE name = 'change-baseline' AND run_date = ?",
    args: [date]
  })).rows.length > 0;
  const advance = !baselineDone; // 오늘 첫 실행이면 기준선 전진

  const r = await db.execute("SELECT DISTINCT url FROM submissions WHERE url <> ''");
  const urls = r.rows.map((x) => x.url);
  const existing = await db.execute('SELECT url, html_hash FROM site_pages');
  const prevByUrl = {};
  for (const row of existing.rows) prevByUrl[row.url] = row.html_hash;
  const baselineEmpty = existing.rows.length === 0; // 최초 기준선

  // 하루(24h) 이상 켜져 있던 마커는 무조건 해제 — 일일 배치/새로고침 모두에서 실행.
  //  - fetch 실패(해시 못 받음) 사이트는 아래 루프에서 건너뛰므로, 이 사전 정리가 없으면 마커가 영영 안 꺼진다.
  //  - 24h 초과 마커는 "오늘 변경분"이 아니므로, 같은 날 새로고침에서 꺼도 안전.
  //  - 오늘 새로 감지되는 변경은 이후 루프에서 다시 켜지므로(changed_at=now) 영향 없음.
  if (!baselineEmpty) {
    await db.execute(
      "UPDATE site_pages SET is_new = 0 WHERE is_new = 1 AND (changed_at IS NULL OR changed_at <= datetime('now', '-1 day'))"
    );
  }

  const results = await mapPool(urls, 6, async (url) => ({ url, hash: await fetchPageHash(url) }));
  let changed = 0, fresh = 0, failed = 0;
  for (const { url, hash } of results) {
    if (!hash) { failed++; continue; } // 못 받으면 기존 상태 유지
    const prev = prevByUrl[url];

    if (baselineEmpty) {
      // 최초: 기준선만 설정, 마커 없음
      await db.execute({
        sql: `INSERT INTO site_pages (url, html_hash, is_new, checked_at) VALUES (?, ?, 0, datetime('now'))
              ON CONFLICT(url) DO UPDATE SET html_hash = excluded.html_hash, is_new = 0, checked_at = excluded.checked_at`,
        args: [url, hash]
      });
      continue;
    }

    const diff = prev === undefined ? true : prev !== hash; // 신규 사이트 or 내용 변경
    if (diff) (prev === undefined ? fresh++ : changed++);

    if (advance) {
      // 일일 첫 실행: 마커 재평가 + 기준선 전진
      await db.execute({
        sql: `INSERT INTO site_pages (url, html_hash, is_new, checked_at, changed_at)
              VALUES (?, ?, ?, datetime('now'), CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END)
              ON CONFLICT(url) DO UPDATE SET
                html_hash = excluded.html_hash, is_new = excluded.is_new, checked_at = excluded.checked_at,
                changed_at = CASE WHEN excluded.is_new = 1 THEN datetime('now') ELSE site_pages.changed_at END`,
        args: [url, hash, diff ? 1 : 0, diff ? 1 : 0]
      });
    } else if (diff) {
      // 새로고침: 기준선과 다르면 마커 ON (기준선 html_hash 는 유지, 마커는 끄지 않음)
      await db.execute({
        sql: `INSERT INTO site_pages (url, html_hash, is_new, checked_at, changed_at)
              VALUES (?, ?, 1, datetime('now'), datetime('now'))
              ON CONFLICT(url) DO UPDATE SET is_new = 1, checked_at = excluded.checked_at, changed_at = excluded.changed_at`,
        args: [url, hash]
      });
    }
  }

  const detail = baselineEmpty
    ? `변경감지 기준선 설정(${urls.length})`
    : `변경 ${changed} · 신규 ${fresh}${failed ? ` · 실패 ${failed}` : ''}${advance ? '' : ' (새로고침)'}`;

  if (advance) {
    await db.execute({
      sql: `INSERT INTO batch_runs (name, run_date, ran_at, detail)
            VALUES ('change-baseline', ?, datetime('now'), ?)
            ON CONFLICT(name, run_date) DO UPDATE SET ran_at = excluded.ran_at, detail = excluded.detail`,
      args: [date, detail]
    });
  }
  return detail;
}

// ---- 공통 일일 배치 ----
// 매일 1회(08:30 KST) 실행되어야 하는 작업들을 이 목록에 묶는다.
// 추후 기능은 BATCH_TASKS 에 { name, run } 으로 추가하면 같은 배치/새로고침에 함께 실행된다.
const BATCH_TASKS = [
  { name: 'icons', run: refreshAllIcons },
  { name: 'changes', run: checkSiteChanges }
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
        details.push(await task.run(trigger));
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
    const [subs, icons, pages, reqs] = await Promise.all([
      // 클릭수 많은 순으로 상단 노출 (동률은 먼저 제출한 순)
      db.execute("SELECT id, team, member, title, url, summary, category, clicks, updated_at FROM submissions WHERE url <> '' ORDER BY clicks DESC, updated_at ASC"),
      db.execute('SELECT url, icon_src, icon_data FROM site_icons'),
      db.execute('SELECT url, is_new FROM site_pages'),
      db.execute('SELECT submission_id, COUNT(*) AS t, SUM(CASE WHEN done = 0 THEN 1 ELSE 0 END) AS o FROM requests GROUP BY submission_id')
    ]);
    const iconByUrl = {};
    for (const row of icons.rows) iconByUrl[row.url] = row;
    const newByUrl = {};
    for (const row of pages.rows) newByUrl[row.url] = !!row.is_new;
    const reqBySub = {};
    for (const row of reqs.rows) reqBySub[row.submission_id] = { t: Number(row.t || 0), o: Number(row.o || 0) };
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
        clicks: Number(row.clicks || 0),
        updated: !!newByUrl[row.url],
        reqTotal: reqBySub[row.id]?.t || 0,
        reqOpen: reqBySub[row.id]?.o || 0,
        favicon: (ic && (ic.icon_data || ic.icon_src)) || null, // DB 저장 아이콘 우선
        updatedAt: row.updated_at || null
      };
    });
    // 업데이트(해시 변경/신규) 감지된 사이트를 최상단으로. 그 외(클릭수 DESC, 제출 순)는 안정 정렬로 유지.
    sites.sort((a, b) => (b.updated ? 1 : 0) - (a.updated ? 1 : 0));
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

// 쇼케이스 링크 클릭수 +1 (과제 고유키 id 로 식별)
app.post('/api/submissions/click', async (req, res) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  if (!id) return res.status(400).json({ error: 'missing id' });
  try {
    const r = await db.execute({
      sql: 'UPDATE submissions SET clicks = clicks + 1 WHERE id = ?',
      args: [id]
    });
    if (!r.rowsAffected) return res.status(404).json({ error: 'not found' });
    const row = await db.execute({ sql: 'SELECT clicks FROM submissions WHERE id = ?', args: [id] });
    res.json({ ok: true, id, clicks: Number(row.rows[0]?.clicks || 0) });
  } catch (err) {
    console.error('[POST /api/submissions/click]', err);
    res.status(500).json({ error: 'db error' });
  }
});

// ---- 사이트 요청(피드백) ----
// 사이트별 요청 목록 (완료 안 된 것 먼저, 최신순)
app.get('/api/requests', async (req, res) => {
  const sid = String(req.query.sid || '');
  if (!sid) return res.status(400).json({ error: 'missing sid' });
  try {
    // 최신 5개만 노출 (이전 데이터는 DB 에만 보관)
    const [r, cnt] = await Promise.all([
      db.execute({
        sql: `SELECT id, content, requester_email, done, notified, created_at FROM requests
              WHERE submission_id = ? ORDER BY created_at DESC LIMIT 5`,
        args: [sid]
      }),
      db.execute({ sql: 'SELECT COUNT(*) AS n FROM requests WHERE submission_id = ?', args: [sid] })
    ]);
    res.json({
      total: Number(cnt.rows[0]?.n || 0),
      requests: r.rows.map((x) => ({
        id: x.id, content: x.content, requesterEmail: x.requester_email || '',
        done: !!x.done, notified: !!x.notified, createdAt: x.created_at
      }))
    });
  } catch (err) {
    console.error('[GET /api/requests]', err);
    res.status(500).json({ error: 'db error' });
  }
});

// 요청 등록 — 담당자(인원) 이메일이 등록돼 있으면 메일 발송. 요청자 이메일(선택)은 완료 알림용.
app.post('/api/requests', async (req, res) => {
  const sid = typeof req.body?.sid === 'string' ? req.body.sid : '';
  const content = typeof req.body?.content === 'string' ? req.body.content.trim().slice(0, 500) : '';
  const requesterEmail = normalizeEmail(req.body?.email);
  if (!sid || !content) return res.status(400).json({ error: 'sid and content required' });
  if (requesterEmail === null) return res.status(400).json({ error: 'invalid email' });
  try {
    const sub = await db.execute({
      sql: 'SELECT id, team, member, title, url FROM submissions WHERE id = ?',
      args: [sid]
    });
    if (!sub.rows.length) return res.status(404).json({ error: 'site not found' });
    const s = sub.rows[0];
    const id = 'r_' + crypto.randomBytes(9).toString('hex');
    await db.execute({
      sql: 'INSERT INTO requests (id, submission_id, content, requester_email) VALUES (?, ?, ?, ?)',
      args: [id, sid, content, requesterEmail]
    });
    const to = emailOf(s.team, s.member);
    let emailed = false;
    if (to) {
      emailed = await sendRequestMail(to, s, content, requesterEmail);
      if (emailed) await db.execute({ sql: 'UPDATE requests SET emailed = 1 WHERE id = ?', args: [id] });
    }
    res.json({ ok: true, id, hasEmail: !!to, emailed });
  } catch (err) {
    console.error('[POST /api/requests]', err);
    res.status(500).json({ error: 'db error' });
  }
});

// 요청 완료 토글 — 완료로 바뀌고 요청자 이메일이 있으면 1회 완료 알림 발송
app.post('/api/requests/done', async (req, res) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  const done = req.body?.done ? 1 : 0;
  if (!id) return res.status(400).json({ error: 'missing id' });
  try {
    const cur = await db.execute({
      sql: 'SELECT submission_id, content, requester_email, notified FROM requests WHERE id = ?',
      args: [id]
    });
    if (!cur.rows.length) return res.status(404).json({ error: 'not found' });
    const rq = cur.rows[0];
    await db.execute({ sql: 'UPDATE requests SET done = ? WHERE id = ?', args: [done, id] });

    let notified = false;
    if (done && rq.requester_email && !rq.notified) {
      const sub = await db.execute({
        sql: 'SELECT title, url FROM submissions WHERE id = ?',
        args: [rq.submission_id]
      });
      const site = sub.rows[0] || { title: '', url: '' };
      const ok = await sendDoneMail(rq.requester_email, site, rq.content);
      if (ok) {
        await db.execute({ sql: 'UPDATE requests SET notified = 1 WHERE id = ?', args: [id] });
        notified = true;
      }
    }
    res.json({ ok: true, id, done: !!done, notified });
  } catch (err) {
    console.error('[POST /api/requests/done]', err);
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

// 관리자: 팀 인원 목록 (이메일 포함 — 관리자 전용)
app.get('/api/admin/members', requireAdmin, (req, res) => {
  const team = String(req.query.team || '');
  if (!TEAM_IDS.has(team)) return res.status(400).json({ error: 'unknown team' });
  res.json({ team, members: teamMembers(team) });
});

// 관리자: 팀 인원 추가 (이메일 선택)
app.post('/api/admin/members/add', requireAdmin, async (req, res) => {
  const { team } = req.body || {};
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 30) : '';
  const dept = typeof req.body?.dept === 'string' ? req.body.dept.trim().slice(0, 30) : '';
  const email = normalizeEmail(req.body?.email);
  if (!TEAM_IDS.has(team)) return res.status(400).json({ error: 'unknown team' });
  if (!name) return res.status(400).json({ error: 'name required' });
  if (email === null) return res.status(400).json({ error: 'invalid email' });
  if (memberNames(team).has(name)) return res.status(409).json({ error: 'duplicate name' });
  try {
    const mx = await db.execute({
      sql: 'SELECT COALESCE(MAX(sort), -1) AS m FROM team_members WHERE team = ?',
      args: [team]
    });
    const sort = Number(mx.rows[0]?.m ?? -1) + 1;
    await db.execute({
      sql: 'INSERT INTO team_members (team, name, dept, email, sort) VALUES (?, ?, ?, ?, ?)',
      args: [team, name, dept, email, sort]
    });
    await loadMembersCache();
    res.json({ ok: true, team, members: teamMembers(team) });
  } catch (err) {
    console.error('[POST /api/admin/members/add]', err);
    res.status(500).json({ error: 'db error' });
  }
});

// 관리자: 인원 이메일 저장/수정 (빈 값이면 삭제)
app.post('/api/admin/members/email', requireAdmin, async (req, res) => {
  const { team, name } = req.body || {};
  if (!TEAM_IDS.has(team)) return res.status(400).json({ error: 'unknown team' });
  if (!name || !memberNames(team).has(name)) return res.status(400).json({ error: 'unknown member' });
  const email = normalizeEmail(req.body?.email);
  if (email === null) return res.status(400).json({ error: 'invalid email' });
  try {
    await db.execute({
      sql: 'UPDATE team_members SET email = ? WHERE team = ? AND name = ?',
      args: [email, team, name]
    });
    await loadMembersCache();
    res.json({ ok: true, team, name, email });
  } catch (err) {
    console.error('[POST /api/admin/members/email]', err);
    res.status(500).json({ error: 'db error' });
  }
});

// 관리자: 팀 인원 삭제 (해당 인원의 투표·제출·추가정보도 함께 삭제)
app.post('/api/admin/members/remove', requireAdmin, async (req, res) => {
  const { team, name } = req.body || {};
  if (!TEAM_IDS.has(team)) return res.status(400).json({ error: 'unknown team' });
  if (!name || !memberNames(team).has(name)) {
    return res.status(400).json({ error: 'unknown member' });
  }
  try {
    await db.batch([
      { sql: 'DELETE FROM team_members WHERE team = ? AND name = ?', args: [team, name] },
      { sql: 'DELETE FROM votes WHERE team = ? AND member = ?', args: [team, name] },
      { sql: 'DELETE FROM submissions WHERE team = ? AND member = ?', args: [team, name] },
      { sql: 'DELETE FROM member_info WHERE team = ? AND member = ?', args: [team, name] }
    ], 'write');
    await loadMembersCache();
    res.json({ ok: true, team, members: teamMembers(team) });
  } catch (err) {
    console.error('[POST /api/admin/members/remove]', err);
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
  .then(loadMembersCache)
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
