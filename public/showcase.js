'use strict';

const grid = document.getElementById('grid');
const countEl = document.getElementById('count');
const updatedEl = document.getElementById('updated');
const refreshBtn = document.getElementById('refresh');
const filtersEl = document.getElementById('filters');

// 카테고리 정의 (표시 순서 + 이모지). 요약 기준으로 분류.
const CATEGORIES = [
  { key: '업무·생산성', emoji: '💼' },
  { key: '음식·요리', emoji: '🍽️' },
  { key: '건강·운동', emoji: '💪' },
  { key: '육아·가족', emoji: '👶' },
  { key: '취미·문화', emoji: '🎨' },
  { key: '생활·기타', emoji: '🧩' }
];
const UNCATEGORIZED = '미분류';
const emojiFor = (cat) => (CATEGORIES.find((c) => c.key === cat) || {}).emoji || '🏷️';

let allSites = [];
let currentFilter = 'all';

// 요청 모달 상태
const reqModal = document.getElementById('req-modal');
const reqTitle = document.getElementById('req-title');
const reqList = document.getElementById('req-list');
const reqContent = document.getElementById('req-content');
const reqName = document.getElementById('req-name');
const reqSubmit = document.getElementById('req-submit');
const reqStatus = document.getElementById('req-status');
const reqClose = document.getElementById('req-close');
let reqSid = null;
let reqDirty = false; // 모달에서 변경이 있었으면 닫을 때 목록 새로고침

// 'YYYY-MM-DD HH:MM:SS'(UTC) → 한국시간 표기
function fmtKst(s) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return s;
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(d);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// URL 에서 보기 좋은 호스트명만 추출 (실패 시 원본)
function prettyHost(url) {
  try {
    const u = new URL(url);
    return u.host + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url;
  }
}

const catOf = (site) => (site.category && site.category.trim()) || UNCATEGORIZED;

// 파비콘 후보 URL 목록: 서버가 사이트 HTML 에서 찾은 아이콘 → DuckDuckGo → 사이트 /favicon.ico
function faviconCandidates(site) {
  const list = [];
  if (site.favicon) list.push(site.favicon);
  try {
    const host = new URL(site.url).hostname;
    list.push(`https://icons.duckduckgo.com/ip3/${host}.ico`);
    list.push(`${new URL(site.url).origin}/favicon.ico`);
  } catch { /* 무시 */ }
  return list;
}

// 링크 클릭수 +1 기록 + 화면 카운트 즉시 반영
function countClick(cardEl, site) {
  if (cardEl.classList.contains('editing')) return; // 편집 중에는 카운트하지 않음
  if (!site.id) return;
  site.clicks = Number(site.clicks || 0) + 1;
  const b = cardEl.querySelector('.clicks b');
  if (b) b.textContent = site.clicks;
  const payload = JSON.stringify({ id: site.id });
  try {
    // 새 탭 이동과 무관하게 안전하게 전송
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/submissions/click', new Blob([payload], { type: 'application/json' }));
    } else {
      fetch('/api/submissions/click', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true
      });
    }
  } catch (_) { /* 무시 */ }
}

function card(site) {
  const a = document.createElement('a');
  a.className = 'site-card';
  a.href = site.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';

  const title = site.title || prettyHost(site.url);
  const cat = catOf(site);

  const hasSummary = !!(site.summary && site.summary.trim());
  a.innerHTML =
    `<div class="card-top">` +
      `<span class="site-fav">` +
        `<img alt="" loading="lazy" />` +
        `<span class="fav-fallback">🌐</span>` +
      `</span>` +
      `<span class="cat-badge">${emojiFor(cat)} ${escapeHtml(cat)}</span>` +
      (site.updated ? `<span class="update-badge" title="최근 업데이트 감지됨">UPDATED</span>` : '') +
    `</div>` +
    `<h3 class="title">${escapeHtml(title)}</h3>` +
    `<div class="summary${hasSummary ? '' : ' empty'}" title="더블클릭하여 요약·카테고리 수정">` +
      `${hasSummary ? escapeHtml(site.summary) : '요약 없음 — 더블클릭하여 입력'}` +
    `</div>` +
    `<div class="meta">` +
      `<span class="who">` +
        `<span class="name">${escapeHtml(site.member || '익명')}</span>` +
        (site.dept ? `<span class="dept">${escapeHtml(site.dept)}</span>` : '') +
      `</span>` +
      `<button class="req-btn" type="button" title="요청 보기/보내기">💬${site.reqOpen ? ` <span class="rb-n">${site.reqOpen}</span>` : ''}</button>` +
      `<span class="go">열기 →</span>` +
    `</div>`;

  // 요청 버튼: 카드 이동 막고 요청 모달 열기
  const reqBtn = a.querySelector('.req-btn');
  reqBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!site.id) { alert('이 항목은 아직 요청을 받을 수 없습니다.'); return; }
    openRequests(site);
  });

  // 카드(링크) 클릭 시 클릭수 +1 기록 (새 탭이 열리므로 현재 페이지는 유지됨)
  a.addEventListener('click', () => countClick(a, site));

  // 요약: 더블클릭하여 인라인 편집 (카드 링크 이동은 막음)
  const summaryEl = a.querySelector('.summary');
  summaryEl.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
  summaryEl.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!site.id) { alert('이 항목은 아직 수정할 수 없습니다.'); return; }
    startSummaryEdit(a, summaryEl, site);
  });

  // 파비콘 후보를 순서대로 시도, 전부 실패하면 🌐 로 폴백
  const img = a.querySelector('.site-fav img');
  const fallback = a.querySelector('.fav-fallback');
  const candidates = faviconCandidates(site);
  let ci = 0;
  const tryNext = () => {
    if (ci >= candidates.length) { img.remove(); fallback.style.display = ''; return; }
    img.src = candidates[ci++];
  };
  img.addEventListener('error', tryNext);
  if (candidates.length) tryNext();
  else { img.remove(); fallback.style.display = ''; }

  return a;
}

// 요약·카테고리 인라인 편집 시작
function startSummaryEdit(cardEl, summaryEl, site) {
  if (cardEl.querySelector('.summary-edit-box')) return; // 이미 편집 중

  // 편집 중에는 카드(링크)의 사이트 이동을 비활성화 (href 임시 제거)
  cardEl.classList.add('editing');
  if (cardEl.hasAttribute('href')) {
    cardEl.dataset.href = cardEl.getAttribute('href');
    cardEl.removeAttribute('href');
  }

  const box = document.createElement('div');
  box.className = 'summary-edit-box';
  ['click', 'dblclick', 'mousedown'].forEach((ev) =>
    box.addEventListener(ev, (e) => e.stopPropagation()));

  const ta = document.createElement('textarea');
  ta.className = 'summary-edit';
  ta.maxLength = 300;
  ta.value = site.summary || '';
  ta.placeholder = '이 사이트가 무엇을 하는지 요약을 입력하세요 (최대 300자)';

  const sel = document.createElement('select');
  sel.className = 'cat-edit';
  const cur = catOf(site);
  const opts = [...CATEGORIES.map((c) => c.key)];
  if (!opts.includes(cur) && cur !== UNCATEGORIZED) opts.push(cur);
  sel.innerHTML =
    `<option value="">(미분류)</option>` +
    opts.map((k) => `<option value="${escapeHtml(k)}"${k === cur ? ' selected' : ''}>${emojiFor(k)} ${escapeHtml(k)}</option>`).join('');

  const actions = document.createElement('div');
  actions.className = 'edit-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'edit-save';
  saveBtn.textContent = '저장';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'edit-cancel';
  cancelBtn.textContent = '취소';
  actions.append(sel, cancelBtn, saveBtn);

  box.append(ta, actions);
  summaryEl.replaceWith(box);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;

    // 편집 종료 → 링크 이동 복원
    cardEl.classList.remove('editing');
    if (cardEl.dataset.href) {
      cardEl.setAttribute('href', cardEl.dataset.href);
      delete cardEl.dataset.href;
    }

    const nextSummary = ta.value.trim();
    const nextCat = sel.value;
    const summaryChanged = save && nextSummary !== (site.summary || '');
    const catChanged = save && nextCat !== (site.category || '');

    if (summaryChanged || catChanged) {
      const body = { id: site.id };
      if (summaryChanged) body.summary = nextSummary;
      if (catChanged) body.category = nextCat;
      try {
        const res = await fetch('/api/submissions/summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error('save failed');
        if (summaryChanged) site.summary = nextSummary;
        if (catChanged) site.category = nextCat;
      } catch (err) {
        console.error(err);
        alert('저장에 실패했습니다. 다시 시도해 주세요.');
      }
    }

    // 카테고리가 바뀌면 칩 카운트/필터 결과가 달라지므로 전체 다시 그림
    if (catChanged) { renderFilters(); renderGrid(); return; }

    // 요약만 바뀐 경우 인라인 복원
    const hasSummary = !!(site.summary && site.summary.trim());
    const newEl = document.createElement('div');
    newEl.className = 'summary' + (hasSummary ? '' : ' empty');
    newEl.title = '더블클릭하여 요약·카테고리 수정';
    newEl.textContent = hasSummary ? site.summary : '요약 없음 — 더블클릭하여 입력';
    newEl.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
    newEl.addEventListener('dblclick', (e) => {
      e.preventDefault(); e.stopPropagation();
      startSummaryEdit(cardEl, newEl, site);
    });
    box.replaceWith(newEl);
  };

  // preventDefault 로 카드(링크) 기본 이동 차단 (href 복원 시점과 무관하게)
  saveBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); finish(true); });
  cancelBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); finish(false); });
  // 단축키: Ctrl/⌘+Enter 저장, Esc 취소
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
}

// 카테고리 필터 칩 렌더
function renderFilters() {
  if (!filtersEl) return;
  const counts = {};
  for (const s of allSites) { const c = catOf(s); counts[c] = (counts[c] || 0) + 1; }

  const chips = [{ key: 'all', label: '전체', emoji: '📋', n: allSites.length }];
  for (const c of CATEGORIES) {
    if (counts[c.key]) chips.push({ key: c.key, label: c.key, emoji: c.emoji, n: counts[c.key] });
  }
  if (counts[UNCATEGORIZED]) {
    chips.push({ key: UNCATEGORIZED, label: UNCATEGORIZED, emoji: '🏷️', n: counts[UNCATEGORIZED] });
  }

  filtersEl.innerHTML = '';
  for (const ch of chips) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cat-chip' + (currentFilter === ch.key ? ' active' : '');
    b.innerHTML = `${ch.emoji} ${escapeHtml(ch.label)} <span class="chip-n">${ch.n}</span>`;
    b.onclick = () => { currentFilter = ch.key; renderFilters(); renderGrid(); };
    filtersEl.appendChild(b);
  }
}

// 현재 필터에 맞는 카드 렌더
function renderGrid() {
  const list = currentFilter === 'all'
    ? allSites
    : allSites.filter((s) => catOf(s) === currentFilter);

  grid.innerHTML = '';
  if (!list.length) {
    grid.innerHTML = `<div class="empty"><div class="big">🔎</div>이 카테고리에 해당하는 사이트가 없어요.</div>`;
    return;
  }
  for (const s of list) grid.appendChild(card(s));
}

/* ---------------- 요청(피드백) 모달 ---------------- */

function openRequests(site) {
  reqSid = site.id;
  reqDirty = false;
  reqTitle.textContent = `💬 요청 — ${site.title || site.url}`;
  reqContent.value = '';
  reqName.value = '';
  reqStatus.textContent = '';
  reqStatus.className = 'req-status';
  reqList.innerHTML = '<p class="req-empty">불러오는 중…</p>';
  reqModal.hidden = false;
  loadRequests();
}

function closeRequests() {
  reqModal.hidden = true;
  reqSid = null;
  if (reqDirty) load(); // 카드의 요청 카운트 갱신
}

async function loadRequests() {
  const sid = reqSid;
  try {
    const res = await fetch(`/api/requests?sid=${encodeURIComponent(sid)}`);
    if (!res.ok) throw new Error('load failed');
    const data = await res.json();
    if (reqSid !== sid) return;
    renderRequests(data.requests || []);
  } catch (err) {
    console.error(err);
    reqList.innerHTML = '<p class="req-empty">목록을 불러오지 못했습니다.</p>';
  }
}

function renderRequests(items) {
  if (!items.length) {
    reqList.innerHTML = '<p class="req-empty">아직 등록된 요청이 없어요. 첫 요청을 남겨보세요.</p>';
    return;
  }
  reqList.innerHTML = '';
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'req-item' + (it.done ? ' done' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = it.done;
    cb.title = '적용 완료 체크';
    cb.addEventListener('change', () => toggleRequestDone(it.id, cb.checked, row));
    const body = document.createElement('div');
    body.className = 'ri-body';
    const meta = [it.requester || '익명', fmtKst(it.createdAt)].filter(Boolean).join(' · ');
    body.innerHTML =
      `<div class="ri-text">${escapeHtml(it.content)}</div>` +
      `<div class="ri-meta">${escapeHtml(meta)}</div>`;
    row.append(cb, body);
    reqList.appendChild(row);
  }
}

async function toggleRequestDone(id, done, row) {
  try {
    const res = await fetch('/api/requests/done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, done })
    });
    if (!res.ok) throw new Error('toggle failed');
    row.classList.toggle('done', done);
    reqDirty = true;
  } catch (err) {
    console.error(err);
    alert('상태 변경에 실패했습니다.');
    loadRequests();
  }
}

async function submitRequest() {
  const content = reqContent.value.trim();
  if (!content) { reqContent.focus(); return; }
  reqSubmit.disabled = true;
  reqStatus.textContent = '전송 중…';
  reqStatus.className = 'req-status';
  try {
    const res = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: reqSid, content, requester: reqName.value.trim() })
    });
    if (!res.ok) throw new Error('submit failed');
    const data = await res.json();
    reqContent.value = '';
    reqDirty = true;
    if (data.emailed) {
      reqStatus.textContent = '✅ 요청 등록 + 담당자 메일 발송 완료';
      reqStatus.className = 'req-status ok';
    } else if (!data.hasEmail) {
      reqStatus.textContent = '✅ 요청 등록됨 (담당자 이메일 미등록 — 메일은 발송되지 않음)';
      reqStatus.className = 'req-status warn';
    } else {
      reqStatus.textContent = '✅ 요청 등록됨 (메일 발송은 실패 — 목록에는 표시됩니다)';
      reqStatus.className = 'req-status warn';
    }
    loadRequests();
  } catch (err) {
    console.error(err);
    reqStatus.textContent = '요청 전송에 실패했습니다. 다시 시도해 주세요.';
    reqStatus.className = 'req-status warn';
  } finally {
    reqSubmit.disabled = false;
  }
}

reqClose.addEventListener('click', closeRequests);
reqModal.addEventListener('click', (e) => { if (e.target === reqModal) closeRequests(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !reqModal.hidden) closeRequests(); });
reqSubmit.addEventListener('click', submitRequest);

async function load() {
  try {
    const res = await fetch('/api/all-submissions');
    if (!res.ok) throw new Error('load failed');
    const data = await res.json();
    const sites = data.sites || [];

    countEl.innerHTML = `총 <b>${sites.length}</b>개 사이트`;
    updatedEl.textContent = data.batchUpdatedAt
      ? `업데이트: ${fmtKst(data.batchUpdatedAt)}`
      : '업데이트 준비 중…';

    allSites = sites;
    if (!sites.length) {
      if (filtersEl) filtersEl.innerHTML = '';
      grid.innerHTML =
        `<div class="empty"><div class="big">🌱</div>` +
        `아직 제출된 사이트가 없어요.<br>세미나 과제가 제출되면 여기에 모입니다.</div>`;
      return;
    }
    renderFilters();
    renderGrid();
  } catch (err) {
    console.error(err);
    countEl.textContent = '';
    if (filtersEl) filtersEl.innerHTML = '';
    grid.innerHTML =
      `<div class="empty"><div class="big">⚠️</div>` +
      `목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</div>`;
  }
}

// 새로고침 = 서버 공통 일일 배치 수동 실행 후 재조회 (배치와 동기화)
async function doRefresh() {
  if (refreshBtn.disabled) return;
  refreshBtn.disabled = true;
  refreshBtn.classList.add('spinning');
  const prev = updatedEl.textContent;
  updatedEl.textContent = '새로고침 중…';
  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    if (res.status === 202) {
      updatedEl.textContent = '다른 갱신이 진행 중…';
    } else if (!res.ok) {
      throw new Error('refresh failed');
    }
    await load();
  } catch (err) {
    console.error(err);
    updatedEl.textContent = prev;
    alert('새로고침에 실패했습니다. 잠시 후 다시 시도해 주세요.');
  } finally {
    refreshBtn.classList.remove('spinning');
    refreshBtn.disabled = false;
  }
}

if (refreshBtn) refreshBtn.addEventListener('click', doRefresh);

load();
