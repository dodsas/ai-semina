import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const pages = ctx.pages();
let page = pages.find((p) => p.url().includes('app.turso.tech')) || (await ctx.newPage());
await page.bringToFront();

function drawScript() {
  return ({ rects, pad }) => {
    document.querySelectorAll('.__redbox').forEach((e) => e.remove());
    rects.forEach((b) => {
      const d = document.createElement('div');
      d.className = '__redbox';
      Object.assign(d.style, {
        position: 'fixed',
        left: b.x - pad + 'px',
        top: b.y - pad + 'px',
        width: b.width + pad * 2 + 'px',
        height: b.height + pad * 2 + 'px',
        border: '4px solid #ff1f1f',
        borderRadius: '10px',
        boxShadow: '0 0 0 3px rgba(255,31,31,.35)',
        zIndex: '2147483647',
        pointerEvents: 'none',
      });
      document.body.appendChild(d);
    });
  };
}

// 조직명 / 다른 DB 이름 가리기
async function mask() {
  await page.evaluate(() => {
    // 사이드바 조직 스위처 (dodsas Free) 블러
    document.querySelectorAll('button').forEach((b) => {
      const t = (b.innerText || '').trim();
      if (/^dodsas\b/i.test(t) && t.length < 40) b.style.filter = 'blur(6px)';
    });
    // 다른 DB 행 블러 (agria, ydocter)
    document.querySelectorAll('tr').forEach((tr) => {
      if (/\b(agria|ydocter)\b/i.test(tr.innerText || '')) tr.style.filter = 'blur(6px)';
    });
    // div 기반 행 대비
    document.querySelectorAll('a[href*="/databases/agria"],a[href*="/databases/ydocter"]').forEach((a) => {
      let row = a;
      for (let i = 0; i < 6 && row && row.parentElement; i++) {
        row = row.parentElement;
        if (row.offsetWidth > 600) break;
      }
      if (row) row.style.filter = 'blur(6px)';
    });
    // URL 안의 조직명 치환
    document.querySelectorAll('input').forEach((i) => {
      if ((i.value || '').includes('dodsas')) i.value = i.value.replace(/dodsas/g, 'your-org');
    });
  });
}

async function boxShot(locators, path, pad = 6) {
  const arr = Array.isArray(locators) ? locators : [locators];
  const rects = [];
  for (const loc of arr) await loc.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(250);
  await mask();
  await page.waitForTimeout(150);
  for (const loc of arr) {
    const b = await loc.boundingBox().catch(() => null);
    if (b) rects.push(b);
  }
  if (!rects.length) {
    console.log('NO BOX for', path);
    return;
  }
  await page.evaluate(drawScript(), { rects, pad });
  await page.screenshot({ path });
  await page.evaluate(() => document.querySelectorAll('.__redbox').forEach((e) => e.remove()));
  console.log('SAVED', path);
}

async function boxShotRects(rects, path, pad = 6) {
  if (!rects.length) return console.log('NO RECT for', path);
  await page.evaluate(drawScript(), { rects, pad });
  await page.screenshot({ path });
  await page.evaluate(() => document.querySelectorAll('.__redbox').forEach((e) => e.remove()));
  console.log('SAVED', path);
}

// 1) 사이드바 Databases
await page.goto('https://app.turso.tech/dodsas', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
await boxShot(page.getByRole('button', { name: 'Databases', exact: true }).first(), 'public/images/turso-1-databases.png', 8);

// 2) Create Database 버튼
const createBtn = page.getByRole('button', { name: 'Create Database', exact: true }).first();
await boxShot(createBtn, 'public/images/turso-2-create.png', 6);

// 3) 모달: Name + Group(Tokyo)
await createBtn.click();
await page.waitForTimeout(2000);
const nameField = page.getByPlaceholder('Name').first();
const groupField = page.locator('button').filter({ hasText: 'NorthEast' }).first();
await boxShot([nameField, groupField], 'public/images/turso-3-form.png', 8);
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(800);

// 4) 상세: 접속 URL
await page.goto('https://app.turso.tech/dodsas/databases/ai-semina', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
await mask();
await page.waitForTimeout(150);
const urlRect = await page.evaluate(() => {
  const inp = [...document.querySelectorAll('input')].find((i) => (i.value || '').startsWith('libsql://'));
  if (!inp) return null;
  inp.scrollIntoView({ block: 'center' });
  const r = inp.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
});
await boxShotRects(urlRect ? [urlRect] : [], 'public/images/turso-4-url.png', 8);

// 5) 상세: Create Token
await boxShot(page.getByRole('button', { name: 'Create Token', exact: true }).first(), 'public/images/turso-5-token.png', 8);

await browser.close();
console.log('DONE');
