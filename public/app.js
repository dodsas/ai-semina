'use strict';

const YEAR = 2026;
const MONTH = 6; // 6월
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

const state = {
  teams: [],
  currentTeam: null,   // team id
  member: null,        // 선택한 본인 이름
  votesByDate: {},     // { '2026-06-12': [member, ...] }
  selected: new Set(), // 본인이 고른 날짜들 (yyyy-mm-dd)
  completedOpen: false,// '투표 완료' 섹션 펼침 여부
  confirmed: [],       // 확정된 날짜 배열 (최대 3개)
  seminarTime: '15:00',
  adminToken: localStorage.getItem('adminToken') || null,
  adminPick: null,     // 관리자가 확정하려고 고른 날짜
  view: 'submit',      // 'schedule' | 'all' | 'submit' (기본: 과제 제출)
  submissions: [],     // 과제 제출 현황 [{ name, dept, url, updatedAt }]
  allConfirmed: []     // 전체 일정 뷰: 팀별 확정/투표 [{ team, idx, confirmed, votes }]
};

// 팀 → 색상 클래스(team1/team2/team3). 탭·확정일자 공통.
function teamClassFor(teamId) {
  const idx = state.teams.findIndex((t) => t.id === teamId);
  return 'team' + ((Math.max(0, idx) % 3) + 1);
}

const MAX_CONFIRMED = 3;
const isAdmin = () => !!state.adminToken;

// 확정 일정은 [{ date, memo }] 형태
const confirmedEntry = (ds) => state.confirmed.find((c) => c.date === ds);
const isDateConfirmed = (ds) => state.confirmed.some((c) => c.date === ds);

// 구독 AI 코드 → 표시 라벨
const AI_LABEL = { CLAUDE: 'Claude', CHATGPT: 'ChatGPT', NONE: '없음', OTHER: '기타' };
function aiText(accounts, etc) {
  if (!accounts || !accounts.length) return '미입력';
  return accounts
    .map((a) => (a === 'OTHER' && etc ? `기타(${etc})` : AI_LABEL[a] || a))
    .join(', ');
}

// 투표를 1개 이상 저장한 인원 = 완료자
function completedMembers() {
  const done = new Set();
  for (const voters of Object.values(state.votesByDate)) {
    for (const v of voters) done.add(v);
  }
  return done;
}

const el = {
  tabs: document.getElementById('tabs'),
  members: document.getElementById('members'),
  memberPanel: document.getElementById('member-panel'),
  calTitle: document.getElementById('cal-title'),
  memberExtra: document.getElementById('member-extra'),
  memberExtraLabel: document.getElementById('member-extra-label'),
  infoEtc: document.getElementById('info-etc'),
  adminInfoPanel: document.getElementById('admin-info-panel'),
  adminInfoTeam: document.getElementById('admin-info-team'),
  refreshInfoBtn: document.getElementById('refresh-info-btn'),
  memberInfoTable: document.getElementById('member-info-table'),
  calendar: document.getElementById('calendar'),
  confirmBtn: document.getElementById('confirm-btn'),
  saveStatus: document.getElementById('save-status'),
  pickerInfo: document.getElementById('picker-info'),
  voteActions: document.getElementById('vote-actions'),
  confirmBanner: document.getElementById('confirm-banner'),
  adminBtn: document.getElementById('admin-btn'),
  adminBar: document.getElementById('admin-bar'),
  adminInfo: document.getElementById('admin-info'),
  setConfirmBtn: document.getElementById('set-confirm-btn'),
  clearConfirmBtn: document.getElementById('clear-confirm-btn'),
  confirmMemo: document.getElementById('confirm-memo'),
  confirmTime: document.getElementById('confirm-time'),
  clearDataBtn: document.getElementById('clear-data-btn'),
  loginModal: document.getElementById('login-modal'),
  loginId: document.getElementById('login-id'),
  loginPw: document.getElementById('login-pw'),
  loginErr: document.getElementById('login-err'),
  loginSubmit: document.getElementById('login-submit'),
  loginCancel: document.getElementById('login-cancel'),
  loading: document.getElementById('loading'),
  mtSchedule: document.getElementById('mt-schedule'),
  mtAll: document.getElementById('mt-all'),
  mtSubmit: document.getElementById('mt-submit'),
  viewSchedule: document.getElementById('view-schedule'),
  viewSubmit: document.getElementById('view-submit'),
  viewAll: document.getElementById('view-all'),
  calendarAll: document.getElementById('calendar-all'),
  allLegend: document.getElementById('all-legend'),
  allEmpty: document.getElementById('all-empty'),
  submitTeamName: document.getElementById('submit-team-name'),
  submissionSummary: document.getElementById('submission-summary'),
  submissionList: document.getElementById('submission-list')
};

// 로딩 스피너 (동시 호출 대비 카운터)
let loadingCount = 0;
function setLoading(on) {
  loadingCount = Math.max(0, loadingCount + (on ? 1 : -1));
  el.loading.hidden = loadingCount === 0;
}

const pad = (n) => String(n).padStart(2, '0');
const dateStr = (day) => `${YEAR}-${pad(MONTH)}-${pad(day)}`;
const dayOf = (ds) => Number(ds.slice(-2));
const dowKor = (ds) => DOW[new Date(YEAR, MONTH - 1, dayOf(ds)).getDay()];

// 오늘 날짜 (표시 중인 연/월에 속할 때만 달력에 표시)
const _today = new Date();
const TODAY =
  _today.getFullYear() === YEAR && _today.getMonth() === MONTH - 1
    ? dateStr(_today.getDate())
    : null;

async function init() {
  const res = await fetch('/api/teams');
  const data = await res.json();
  state.teams = data.teams || [];
  state.seminarTime = data.seminarTime || '15:00';
  renderTabs();
  applyAdminUI();
  if (state.teams.length) selectTeam(state.teams[0].id);
}

function renderTabs() {
  el.tabs.innerHTML = '';
  for (const team of state.teams) {
    const b = document.createElement('button');
    b.className =
      'tab ' + teamClassFor(team.id) + (team.id === state.currentTeam ? ' active' : '');
    b.textContent = team.name;
    b.onclick = () => selectTeam(team.id);
    el.tabs.appendChild(b);
  }
}

async function selectTeam(teamId) {
  state.currentTeam = teamId;
  // 일정 뷰의 확정색을 선택 팀 색으로 전환
  el.viewSchedule.classList.remove('team1', 'team2', 'team3');
  el.viewSchedule.classList.add(teamClassFor(teamId));
  state.member = null;
  state.selected = new Set();
  state.completedOpen = false;
  state.adminPick = null;
  el.memberExtra.hidden = true;
  // 이전 팀 데이터 비우고 즉시 렌더 (탭 전환 체감 지연 제거)
  state.votesByDate = {};
  state.confirmed = [];
  state.submissions = [];
  renderTabs();
  setSaveStatus('');
  renderMembers();
  updatePickerInfo();
  renderCalendar();
  updateConfirmBtn();
  renderConfirmBanner();
  updateAdminInfo();
  renderSubmissions();
  if (state.view === 'submit') loadSubmissions();
  // 투표/확정 데이터는 백그라운드로 로드 후 다시 렌더
  await loadVotes();
  if (state.currentTeam !== teamId) return; // 로딩 중 다른 팀 선택 시 무시
  renderMembers();
  renderCalendar();
  renderConfirmBanner();
  updateAdminInfo();
  if (isAdmin()) loadMemberInfoTable();
}

function currentTeam() {
  return state.teams.find((t) => t.id === state.currentTeam);
}

function memberButton(m, isDone) {
  const b = document.createElement('button');
  b.className =
    'member' + (m.name === state.member ? ' selected' : '') + (isDone ? ' done' : '');
  const badge = isDone ? ' <span class="badge">완료</span>' : '';
  b.innerHTML = `<div class="m-name">${m.name}${badge}</div><div class="m-dept">${m.dept}</div>`;
  b.onclick = () => selectMember(m.name);
  return b;
}

function renderMembers() {
  el.members.innerHTML = '';
  const done = completedMembers();
  const members = currentTeam().members;
  const active = members.filter((m) => !done.has(m.name));
  const finished = members.filter((m) => done.has(m.name));

  // 전원 투표 완료 시에만 캘린더 제목을 '세미나 일정'으로
  const allVoted = members.length > 0 && active.length === 0;
  el.calTitle.textContent = allVoted
    ? '2. 2026년 6월 — 세미나 일정'
    : '2. 2026년 6월 — 가능한 날짜 선택';

  // 1) 아직 투표하지 않은 인원 (본인 선택 대상)
  const grid = document.createElement('div');
  grid.className = 'members-grid';
  if (active.length === 0) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = '모든 인원이 투표를 완료했습니다 🎉';
    grid.appendChild(note);
  }
  for (const m of active) grid.appendChild(memberButton(m, false));
  el.members.appendChild(grid);

  // 2) 투표 완료 인원 — 기본 접힘, 클릭 시 펼쳐서 다시 선택 가능
  if (finished.length) {
    const wrap = document.createElement('div');
    wrap.className = 'completed' + (state.completedOpen ? ' open' : '');

    const head = document.createElement('button');
    head.className = 'completed-head';
    head.innerHTML = `<span class="chev">▶</span> 투표 완료 (${finished.length})`;
    head.onclick = () => {
      state.completedOpen = !state.completedOpen;
      renderMembers();
    };
    wrap.appendChild(head);

    const body = document.createElement('div');
    body.className = 'completed-body';
    for (const m of finished) body.appendChild(memberButton(m, true));
    wrap.appendChild(body);

    el.members.appendChild(wrap);
  }
}

function selectMember(name) {
  state.member = name;
  // 기존에 투표했던 날짜를 본인 선택으로 불러오기
  state.selected = new Set();
  for (const [date, voters] of Object.entries(state.votesByDate)) {
    if (voters.includes(name)) state.selected.add(date);
  }
  renderMembers();
  updatePickerInfo();
  renderCalendar();
  updateConfirmBtn();
  setSaveStatus('');
  // 추가정보 입력 폼 노출 + 기존 값 프리필
  el.memberExtra.hidden = false;
  el.memberExtraLabel.textContent = `${name} 님`;
  loadMemberExtra(name);
}

async function loadVotes() {
  setLoading(true);
  try {
    const res = await fetch(`/api/votes?team=${encodeURIComponent(state.currentTeam)}`);
    const data = await res.json();
    state.votesByDate = data.votes || {};
    state.confirmed = Array.isArray(data.confirmed) ? data.confirmed : [];
    if (data.seminarTime) state.seminarTime = data.seminarTime;
  } finally {
    setLoading(false);
  }
}

function renderCalendar() {
  el.calendar.innerHTML = '';
  DOW.forEach((d, i) => {
    const h = document.createElement('div');
    h.className = 'dow' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '');
    h.textContent = d;
    el.calendar.appendChild(h);
  });

  const firstDow = new Date(YEAR, MONTH - 1, 1).getDay();
  const daysInMonth = new Date(YEAR, MONTH, 0).getDate();

  // 표시되는 카운트(본인 선택 미리보기 포함) 기준 최다 투표 수 계산
  const dayCount = (ds) => {
    const v = state.votesByDate[ds] || [];
    return v.filter((x) => x !== state.member).length + (state.selected.has(ds) ? 1 : 0);
  };
  let maxCount = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    maxCount = Math.max(maxCount, dayCount(dateStr(day)));
  }

  for (let i = 0; i < firstDow; i++) {
    const e = document.createElement('div');
    e.className = 'day empty';
    el.calendar.appendChild(e);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const ds = dateStr(day);
    const dow = new Date(YEAR, MONTH - 1, day).getDay();
    const voters = state.votesByDate[ds] || [];
    const othersCount = voters.filter((v) => v !== state.member).length;
    const mine = state.selected.has(ds);

    const confEntry = confirmedEntry(ds);
    const isConfirmed = !!confEntry;
    const isAdminPick = isAdmin() && state.adminPick === ds;
    const isToday = TODAY === ds;

    const cell = document.createElement('div');
    cell.className = 'day' + (dow === 0 ? ' sun' : dow === 6 ? ' sat' : '');
    if (othersCount > 0) cell.classList.add('has-others');
    if (mine) cell.classList.add('mine');
    if (isAdminPick) cell.classList.add('admin-pick');
    if (isToday) cell.classList.add('today');
    if (isConfirmed) cell.classList.add('confirmed'); // 가장 강조되는 색상
    cell.innerHTML = `<span>${day}</span>`;

    if (isToday) {
      const t = document.createElement('span');
      t.className = 'today-tag';
      t.textContent = '오늘';
      cell.appendChild(t);
    }

    if (isConfirmed) {
      const tag = document.createElement('span');
      tag.className = 'confirm-label';
      const cnt = voters.length; // 확정 날짜 참여 인원
      const countLine = cnt > 0 ? ` · 👥${cnt}` : '';
      const memoLine = confEntry.memo ? `<br><span class="confirm-memo-tag">📝 ${confEntry.memo}</span>` : '';
      tag.innerHTML = `일정확정<br>${confEntry.time || state.seminarTime}${countLine}${memoLine}`;
      cell.appendChild(tag);
    }

    const totalCount = othersCount + (mine ? 1 : 0);
    if (totalCount > 0 && !isConfirmed) {
      const c = document.createElement('span');
      const isTop = totalCount === maxCount; // 최다 투표 날짜 강조
      c.className = 'count' + (isTop ? ' top' : '');
      c.textContent = totalCount;
      cell.appendChild(c);
    }

    cell.title = isConfirmed && confEntry.memo
      ? `확정 메모: ${confEntry.memo}`
      : voters.length ? `투표: ${voters.join(', ')}` : '';
    cell.onclick = () => (isAdmin() ? adminPickDate(ds) : toggleDate(ds));
    el.calendar.appendChild(cell);
  }
}

function toggleDate(ds) {
  if (!state.member) {
    updatePickerInfo(true);
    return;
  }
  if (state.selected.has(ds)) state.selected.delete(ds);
  else state.selected.add(ds);
  renderCalendar();
  updateConfirmBtn();
  setSaveStatus('');
}

function updatePickerInfo(warn) {
  if (!state.member) {
    el.pickerInfo.textContent = warn ? '⚠ 먼저 본인을 선택하세요.' : '본인을 먼저 선택하세요.';
    el.pickerInfo.style.color = warn ? '#e2574c' : '';
  } else {
    el.pickerInfo.textContent = `${state.member} 님 — 날짜를 눌러 선택/해제하세요.`;
    el.pickerInfo.style.color = '';
  }
}

function updateConfirmBtn() {
  el.confirmBtn.disabled = !state.member;
}

function setSaveStatus(text, ok) {
  el.saveStatus.textContent = text;
  el.saveStatus.className = 'save-status' + (ok ? ' ok' : '');
}

el.confirmBtn.onclick = async () => {
  if (!state.member) return;
  // 추가정보 필수 입력 검증
  const infoErr = infoValidationError();
  if (infoErr) {
    alert(infoErr);
    el.memberExtra.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const dates = [...state.selected];
  el.confirmBtn.disabled = true;
  setSaveStatus('저장 중...');
  setLoading(true);
  try {
    await saveMemberInfo(); // 추가정보 먼저 저장
    const res = await fetch('/api/votes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: state.currentTeam, member: state.member, dates })
    });
    if (!res.ok) throw new Error('save failed');
    await loadVotes();
    // 투표 완료 → 선택 해제 (이름을 다시 클릭하기 전까지 추가정보 숨김)
    const savedName = state.member;
    state.member = null;
    state.selected = new Set();
    el.memberExtra.hidden = true;
    renderMembers();
    updatePickerInfo();
    renderCalendar();
    updateConfirmBtn();
    setSaveStatus(`✓ ${savedName} 님 투표 저장 완료 (${dates.length}일)`, true);
  } catch (err) {
    console.error(err);
    setSaveStatus('✗ 저장 실패. 다시 시도하세요.');
  } finally {
    el.confirmBtn.disabled = false;
    setLoading(false);
  }
};

/* ---------------- 확정 일정 표시 ---------------- */

function renderConfirmBanner() {
  if (state.confirmed.length) {
    const items = state.confirmed
      .map((c) => {
        const cnt = (state.votesByDate[c.date] || []).length;
        const countTag = cnt > 0 ? ` 👥${cnt}명` : '';
        const memo = c.memo ? ` <span class="confirm-item-memo">— 📝 ${c.memo}</span>` : '';
        return `<div class="confirm-item">6월 ${dayOf(c.date)}일 (${dowKor(c.date)}) <strong>${c.time || state.seminarTime}</strong>${countTag}${memo}</div>`;
      })
      .join('');
    el.confirmBanner.hidden = false;
    el.confirmBanner.innerHTML = `<div class="confirm-head">✅ 확정 일정</div>${items}`;
  } else {
    el.confirmBanner.hidden = true;
    el.confirmBanner.textContent = '';
  }
}

/* ---------------- 큰 탭 (일정 확인 / 과제 제출) ---------------- */

function switchView(view) {
  if (view === state.view) return;
  state.view = view;
  el.viewSchedule.hidden = view !== 'schedule';
  el.viewAll.hidden = view !== 'all';
  el.viewSubmit.hidden = view !== 'submit';
  el.mtSchedule.classList.toggle('active', view === 'schedule');
  el.mtAll.classList.toggle('active', view === 'all');
  el.mtSubmit.classList.toggle('active', view === 'submit');
  // 팀 탭은 팀별 뷰(일정/과제)에서만 의미가 있음 → 전체 일정에서는 숨김
  el.tabs.hidden = view === 'all';
  if (view === 'submit') {
    renderSubmissions();
    loadSubmissions();
  }
  if (view === 'all') {
    loadAllSchedule();
  }
}

el.mtSchedule.onclick = () => switchView('schedule');
el.mtAll.onclick = () => switchView('all');
el.mtSubmit.onclick = () => switchView('submit');

/* ---------------- 전체 일정 (1·2·3팀 합산) ---------------- */

async function loadAllSchedule() {
  setLoading(true);
  try {
    const results = await Promise.all(
      state.teams.map((t) =>
        fetch(`/api/votes?team=${encodeURIComponent(t.id)}`).then((r) => r.json())
      )
    );
    state.allConfirmed = state.teams.map((t, i) => ({
      team: t,
      idx: i,
      confirmed: Array.isArray(results[i].confirmed) ? results[i].confirmed : [],
      votes: results[i].votes || {}
    }));
    renderAllCalendar();
  } catch (err) {
    console.error(err);
    el.calendarAll.innerHTML = '';
    el.allEmpty.hidden = false;
    el.allEmpty.textContent = '전체 일정을 불러오지 못했습니다.';
  } finally {
    setLoading(false);
  }
}

const shortTeam = (name) => name.replace(/^세미나\s*/, '');

function renderAllCalendar() {
  // 날짜별로 어느 팀이 확정했는지 모으기
  const byDate = {}; // ds -> [{ idx, name, time, memo, count }]
  let total = 0;
  for (const entry of state.allConfirmed) {
    for (const c of entry.confirmed) {
      total++;
      (byDate[c.date] ??= []).push({
        idx: entry.idx,
        name: entry.team.name,
        time: c.time || state.seminarTime,
        memo: c.memo || '',
        count: (entry.votes[c.date] || []).length
      });
    }
  }
  el.allEmpty.hidden = total > 0;

  // 범례 (팀별 색)
  el.allLegend.innerHTML = state.teams
    .map((t, i) => {
      const cls = 'team' + ((i % 3) + 1);
      return `<span class="lg-team"><span class="lg-dot ${cls}"></span>${t.name}</span>`;
    })
    .join('');

  // 달력 그리기 (읽기 전용)
  el.calendarAll.innerHTML = '';
  DOW.forEach((d, i) => {
    const h = document.createElement('div');
    h.className = 'dow' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '');
    h.textContent = d;
    el.calendarAll.appendChild(h);
  });

  const firstDow = new Date(YEAR, MONTH - 1, 1).getDay();
  const daysInMonth = new Date(YEAR, MONTH, 0).getDate();

  for (let i = 0; i < firstDow; i++) {
    const e = document.createElement('div');
    e.className = 'day empty';
    el.calendarAll.appendChild(e);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const ds = dateStr(day);
    const dow = new Date(YEAR, MONTH - 1, day).getDay();
    const teamsOnDay = byDate[ds] || [];

    const cell = document.createElement('div');
    cell.className = 'day' + (dow === 0 ? ' sun' : dow === 6 ? ' sat' : '');
    cell.style.cursor = 'default';
    if (teamsOnDay.length) cell.classList.add('all-confirmed');
    cell.innerHTML = `<span>${day}</span>`;

    if (TODAY === ds) {
      cell.classList.add('today');
      const t = document.createElement('span');
      t.className = 'today-tag';
      t.textContent = '오늘';
      cell.appendChild(t);
    }

    if (teamsOnDay.length) {
      const chips = document.createElement('div');
      chips.className = 'team-chips';
      for (const info of teamsOnDay) {
        const chip = document.createElement('span');
        chip.className = 'team-chip team' + ((info.idx % 3) + 1);
        const cnt = info.count > 0 ? ` 👥${info.count}` : '';
        chip.textContent = `${shortTeam(info.name)} ${info.time}${cnt}`;
        chip.title = info.memo
          ? `${info.name} · ${info.time}${info.memo ? ` · ${info.memo}` : ''}`
          : `${info.name} · ${info.time}`;
        chips.appendChild(chip);
      }
      cell.appendChild(chips);
    }

    el.calendarAll.appendChild(cell);
  }
}

/* ---------------- 과제 제출 ---------------- */

async function loadSubmissions() {
  setLoading(true);
  try {
    const teamId = state.currentTeam;
    const res = await fetch(`/api/submissions?team=${encodeURIComponent(teamId)}`);
    if (!res.ok) throw new Error('load failed');
    const data = await res.json();
    if (state.currentTeam !== teamId) return; // 로딩 중 팀 변경 시 무시
    state.submissions = data.members || [];
    renderSubmissions();
  } catch (err) {
    console.error(err);
    el.submissionList.innerHTML = '<p class="empty-note">제출 현황을 불러오지 못했습니다.</p>';
  } finally {
    setLoading(false);
  }
}

function renderSubmissions() {
  const team = currentTeam();
  el.submitTeamName.textContent = team ? team.name : '';
  const members = state.submissions;
  if (!members.length) {
    el.submissionSummary.textContent = '';
    el.submissionList.innerHTML = '<p class="empty-note">불러오는 중…</p>';
    return;
  }
  const done = members.filter((m) => m.url).length;
  el.submissionSummary.textContent = `제출 완료 ${done} / 전체 ${members.length}명`;
  el.submissionList.innerHTML = '';
  for (const m of members) el.submissionList.appendChild(submissionRow(m));
}

function submissionRow(m) {
  const row = document.createElement('div');
  row.className = 'sub-row' + (m.url ? ' done' : '');

  const head = document.createElement('div');
  head.className = 'sub-head';
  head.innerHTML =
    `<span class="sub-name">${escapeHtml(m.name)}</span>` +
    `<span class="sub-dept">${escapeHtml(m.dept)}</span>`;
  row.append(head);

  if (m.url) {
    // 제출 완료 → 사이트명 하이퍼링크(새 탭) + 제출 취소
    const a = document.createElement('a');
    a.className = 'sub-link';
    a.href = m.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = m.title || m.url; // 사이트명 없으면 주소로 대체
    a.title = m.url;                   // 호버 시 실제 주소 표시
    row.append(a);

    const del = document.createElement('button');
    del.className = 'btn-clear sub-del';
    del.textContent = '제출 취소';
    del.onclick = () => {
      if (confirm(`${m.name} 님의 제출을 취소할까요?\n(다시 제출하려면 새로 입력해야 합니다)`)) {
        saveSubmission(m.name, '', '');
      }
    };
    row.append(del);
  } else {
    // 미제출 → 사이트명 + URL 입력 + 제출
    const titleInput = document.createElement('input');
    titleInput.className = 'sub-input sub-title-input';
    titleInput.type = 'text';
    titleInput.maxLength = 100;
    titleInput.placeholder = '사이트명';

    const urlInput = document.createElement('input');
    urlInput.className = 'sub-input';
    urlInput.type = 'url';
    urlInput.placeholder = 'https://… 사이트 주소';

    const submit = () => {
      const title = titleInput.value.trim();
      const url = urlInput.value.trim();
      if (!url) { alert('사이트 주소(URL)를 입력해주세요.'); urlInput.focus(); return; }
      if (!title) { alert('사이트명을 입력해주세요.'); titleInput.focus(); return; }
      saveSubmission(m.name, url, title);
    };
    [titleInput, urlInput].forEach((inp) =>
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }));

    const save = document.createElement('button');
    save.className = 'btn-submit';
    save.textContent = '제출';
    save.onclick = submit;

    row.append(titleInput, urlInput, save);
  }
  return row;
}

async function saveSubmission(name, url, title) {
  setLoading(true);
  try {
    const res = await fetch('/api/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: state.currentTeam, member: name, url, title })
    });
    if (res.status === 400) {
      const data = await res.json().catch(() => ({}));
      alert(data.error === 'invalid url' ? '올바른 사이트 주소(URL)를 입력해주세요.' : '저장에 실패했습니다.');
      return;
    }
    if (!res.ok) throw new Error('save failed');
    await loadSubmissions();
  } catch (err) {
    console.error(err);
    alert('제출 저장에 실패했습니다. 다시 시도해주세요.');
  } finally {
    setLoading(false);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 관리자 모드 ---------------- */

function applyAdminUI() {
  const admin = isAdmin();
  el.adminBtn.textContent = admin ? '로그아웃' : '관리자 로그인';
  el.adminBtn.classList.toggle('on', admin);
  el.memberPanel.hidden = admin;     // 관리자는 본인 투표 불필요
  el.voteActions.hidden = admin;
  el.adminBar.hidden = !admin;
  el.adminInfoPanel.hidden = !admin;
  if (admin) loadMemberInfoTable();
}

/* ---------------- 추가정보 (구독 AI) ---------------- */

function syncInfoModalState() {
  const checks = [...document.querySelectorAll('.ai-chk')];
  const none = checks.find((c) => c.value === 'NONE');
  const others = checks.filter((c) => c.value !== 'NONE');
  const anyOther = others.some((c) => c.checked);
  // '없음'과 나머지는 상호 배타
  if (none.checked) {
    others.forEach((c) => { c.checked = false; c.disabled = true; });
  } else {
    others.forEach((c) => { c.disabled = false; });
  }
  none.disabled = anyOther;
  const other = others.find((c) => c.value === 'OTHER');
  el.infoEtc.disabled = !other.checked;
  if (!other.checked) el.infoEtc.value = '';
}

// 본인 선택 시 기존 추가정보를 인라인 폼에 프리필
async function loadMemberExtra(name) {
  // 우선 비우기
  document.querySelectorAll('.ai-chk').forEach((c) => { c.checked = false; });
  el.infoEtc.value = '';
  syncInfoModalState();
  setLoading(true);
  try {
    const res = await fetch(
      `/api/member-info?team=${encodeURIComponent(state.currentTeam)}&member=${encodeURIComponent(name)}`
    );
    if (!res.ok) return;
    const data = await res.json();
    if (state.member !== name) return; // 그 사이 다른 사람 선택 시 무시
    document.querySelectorAll('.ai-chk').forEach((c) => {
      c.checked = data.accounts.includes(c.value);
    });
    el.infoEtc.value = data.etc || '';
    syncInfoModalState();
  } catch (_) { /* 무시 */ } finally {
    setLoading(false);
  }
}

// 현재 인라인 폼의 선택값
function gatherInfo() {
  const accounts = [...document.querySelectorAll('.ai-chk')]
    .filter((c) => c.checked)
    .map((c) => c.value);
  return { accounts, etc: el.infoEtc.value.trim() };
}

// 추가정보 유효성: 최소 1개 선택, OTHER 면 텍스트 필수
function infoValidationError() {
  const { accounts, etc } = gatherInfo();
  if (!accounts.length) return '추가정보(구독 중인 AI 계정)를 먼저 선택해주세요.';
  if (accounts.includes('OTHER') && !etc) return '기타를 선택한 경우 내용을 입력해주세요.';
  return null;
}

async function saveMemberInfo() {
  const { accounts, etc } = gatherInfo();
  const res = await fetch('/api/member-info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ team: state.currentTeam, member: state.member, accounts, etc })
  });
  if (!res.ok) throw new Error('info save failed');
}

/* ---------------- 관리자: 구독 AI 현황 ---------------- */

async function loadMemberInfoTable() {
  if (!isAdmin()) return;
  el.adminInfoTeam.textContent = `(${currentTeam().name})`;
  setLoading(true);
  try {
    const res = await fetch(`/api/admin/member-info?team=${encodeURIComponent(state.currentTeam)}`, {
      headers: { Authorization: `Bearer ${state.adminToken}` }
    });
    if (res.status === 401) return handleAuthExpired();
    if (!res.ok) throw new Error('load failed');
    const data = await res.json();
    renderMemberInfoTable(data.members || []);
  } catch (err) {
    console.error(err);
    el.memberInfoTable.innerHTML = '<p class="empty-note">현황을 불러오지 못했습니다.</p>';
  } finally {
    setLoading(false);
  }
}

function renderMemberInfoTable(members) {
  const done = members.filter((m) => m.accounts.length);
  const rows = members
    .map((m) => {
      const filled = m.accounts.length;
      const val = filled ? aiText(m.accounts, m.etc) : '<span class="ti-none">미입력</span>';
      return `<tr class="${filled ? '' : 'ti-empty'}">
        <td>${m.name}</td><td class="ti-dept">${m.dept}</td><td>${val}</td>
      </tr>`;
    })
    .join('');
  el.memberInfoTable.innerHTML = `
    <p class="ti-summary">입력 완료 ${done.length} / 전체 ${members.length}명</p>
    <table class="ti-table">
      <thead><tr><th>이름</th><th>부서</th><th>구독 AI</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function adminPickDate(ds) {
  state.adminPick = state.adminPick === ds ? null : ds;
  // 확정된 날짜를 고르면 기존 메모/시간을 프리필, 아니면 기본값
  const entry = state.adminPick ? confirmedEntry(state.adminPick) : null;
  el.confirmMemo.value = entry ? entry.memo : '';
  el.confirmTime.value = entry ? entry.time || state.seminarTime : state.seminarTime;
  renderCalendar();
  updateAdminInfo();
}

function updateAdminInfo() {
  if (!isAdmin()) return;
  const n = state.confirmed.length;
  const list = n ? state.confirmed.map((c) => `6월 ${dayOf(c.date)}일`).join(', ') : '없음';
  el.adminInfo.textContent = `확정 ${n}/${MAX_CONFIRMED} · ${list}`;

  const pick = state.adminPick;
  const btn = el.setConfirmBtn;
  if (!pick) {
    btn.disabled = true;
    btn.textContent = '날짜를 선택하세요';
  } else if (isDateConfirmed(pick)) {
    btn.disabled = false;
    btn.textContent = `6월 ${dayOf(pick)}일 확정 해제`;
  } else if (n >= MAX_CONFIRMED) {
    btn.disabled = true;
    btn.textContent = `확정은 최대 ${MAX_CONFIRMED}개까지`;
  } else {
    btn.disabled = false;
    btn.textContent = `6월 ${dayOf(pick)}일 ${el.confirmTime.value} 확정`;
  }
}

function openLogin() {
  el.loginErr.textContent = '';
  el.loginId.value = '';
  el.loginPw.value = '';
  el.loginModal.hidden = false;
  el.loginId.focus();
}
function closeLogin() {
  el.loginModal.hidden = true;
}

async function doLogin() {
  const username = el.loginId.value.trim();
  const password = el.loginPw.value;
  el.loginErr.textContent = '';
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) {
      el.loginErr.textContent = '아이디 또는 비밀번호가 올바르지 않습니다.';
      return;
    }
    const data = await res.json();
    state.adminToken = data.token;
    localStorage.setItem('adminToken', data.token);
    closeLogin();
    applyAdminUI();
    state.adminPick = null;
    renderCalendar();
    updateAdminInfo();
  } catch (err) {
    console.error(err);
    el.loginErr.textContent = '로그인 중 오류가 발생했습니다.';
  }
}

function logout() {
  state.adminToken = null;
  state.adminPick = null;
  localStorage.removeItem('adminToken');
  applyAdminUI();
  renderCalendar();
}

function handleAuthExpired() {
  alert('세션이 만료되었습니다. 다시 로그인해 주세요.');
  logout();
  openLogin();
}

async function postConfirm(body) {
  const res = await fetch('/api/confirm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.adminToken}`
    },
    body: JSON.stringify({ team: state.currentTeam, ...body })
  });
  if (res.status === 401) {
    handleAuthExpired();
    return false;
  }
  if (res.status === 400) {
    const data = await res.json().catch(() => ({}));
    if (data.error === 'max confirmed') {
      alert(`일정 확정은 최대 ${data.max}개까지 가능합니다.`);
      return false;
    }
    throw new Error('confirm failed');
  }
  if (!res.ok) throw new Error('confirm failed');
  await loadVotes();
  renderCalendar();
  renderConfirmBanner();
  updateAdminInfo();
  return true;
}

el.adminBtn.onclick = () => (isAdmin() ? logout() : openLogin());
el.loginCancel.onclick = closeLogin;
el.loginSubmit.onclick = doLogin;
el.loginPw.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
el.loginModal.addEventListener('click', (e) => { if (e.target === el.loginModal) closeLogin(); });

el.setConfirmBtn.onclick = async () => {
  if (!state.adminPick) return;
  el.setConfirmBtn.disabled = true;
  try {
    // 추가 시 메모/시작시간 함께 저장 (해제 시 서버에서 무시)
    await postConfirm({
      date: state.adminPick,
      memo: el.confirmMemo.value.trim(),
      time: el.confirmTime.value
    });
    // 저장 후 현재 선택 날짜의 메모로 메모칸 동기화
    const entry = state.adminPick ? confirmedEntry(state.adminPick) : null;
    el.confirmMemo.value = entry ? entry.memo : '';
  } catch (err) {
    console.error(err);
    alert('일정 확정에 실패했습니다.');
  } finally {
    updateAdminInfo();
  }
};

el.clearConfirmBtn.onclick = async () => {
  if (!state.confirmed.length) {
    alert('확정된 일정이 없습니다.');
    return;
  }
  if (!confirm('이 팀의 확정 일정을 모두 취소할까요?')) return;
  try {
    await postConfirm({ clearAll: true });
  } catch (err) {
    console.error(err);
    alert('확정 취소에 실패했습니다.');
  }
};

el.clearDataBtn.onclick = async () => {
  const team = currentTeam();
  if (
    !confirm(
      `[${team.name}]의 모든 투표·확정 데이터를 삭제합니다.\n이 작업은 되돌릴 수 없습니다. 계속할까요?`
    )
  ) {
    return;
  }
  el.clearDataBtn.disabled = true;
  try {
    const res = await fetch('/api/admin/clear', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.adminToken}`
      },
      body: JSON.stringify({ team: state.currentTeam })
    });
    if (res.status === 401) return handleAuthExpired();
    if (!res.ok) throw new Error('clear failed');
    state.adminPick = null;
    await loadVotes();
    renderMembers();
    renderCalendar();
    renderConfirmBanner();
    updateAdminInfo();
    alert(`${team.name} 데이터가 초기화되었습니다.`);
  } catch (err) {
    console.error(err);
    alert('데이터 초기화에 실패했습니다.');
  } finally {
    el.clearDataBtn.disabled = false;
  }
};

// 추가정보 체크박스 상호작용 (인라인)
document.querySelectorAll('.ai-chk').forEach((c) => c.addEventListener('change', syncInfoModalState));

// 시작 시간 변경 시 확정 버튼 라벨 갱신
el.confirmTime.addEventListener('input', () => { if (isAdmin()) updateAdminInfo(); });

// 관리자 현황 새로고침
el.refreshInfoBtn.onclick = loadMemberInfoTable;

init().catch((err) => {
  console.error(err);
  document.body.innerHTML = '<p style="padding:40px;text-align:center">초기화 실패. 서버를 확인하세요.</p>';
});
