import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const pages = ctx.pages();
let page = pages.find((p) => p.url().includes('dashboard.render.com')) || (await ctx.newPage());
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

// 다른 저장소명 / GitHub 사용자명(dodsas) 가리기
async function maskRender() {
  await page.evaluate(() => {
    ['yf', 'ydcoter', 'aragria'].forEach((name) => {
      document.querySelectorAll(`a[href*="/dodsas/${name}"]`).forEach((a) => {
        a.style.filter = 'blur(7px)';
      });
    });
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (w.nextNode()) nodes.push(w.currentNode);
    nodes.forEach((n) => {
      if (n.nodeValue && n.nodeValue.includes('dodsas')) n.nodeValue = n.nodeValue.replace(/dodsas/g, 'your-name');
    });
  });
}

async function boxShot(locators, path, pad = 6, doMask = false) {
  const arr = Array.isArray(locators) ? locators : [locators];
  await page.waitForTimeout(250);
  if (doMask) await maskRender();
  await page.waitForTimeout(150);
  const rects = [];
  for (const loc of arr) {
    const b = await loc.boundingBox().catch(() => null);
    if (b) rects.push(b);
  }
  if (!rects.length) return console.log('NO BOX for', path);
  await page.evaluate(drawScript(), { rects, pad });
  await page.screenshot({ path });
  await page.evaluate(() => document.querySelectorAll('.__redbox').forEach((e) => e.remove()));
  console.log('SAVED', path);
}

// ── 2) 저장소 선택: ai-semina Connect ──
await page.goto('https://dashboard.render.com/select-repo?type=blueprint', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
const connectBtn = page.getByRole('button', { name: 'Connect', exact: true }).first();
await boxShot(connectBtn, 'public/images/render-2-connect.png', 8, true);

// ── ai-semina Connect 클릭 → 설정 화면 recon (배포는 하지 않음) ──
await connectBtn.click();
await page.waitForTimeout(6000);
console.log('CONFIG_URL:', page.url());
await page.screenshot({ path: 'public/images/_recon_blueprint.png', fullPage: true });
const els = await page.$$eval('a,button,input,textarea,label,h1,h2', (e) =>
  e
    .map((x) => ({
      tag: x.tagName,
      t: (x.innerText || x.placeholder || x.value || '').trim().replace(/\s+/g, ' ').slice(0, 50),
    }))
    .filter((x) => x.t)
    .slice(0, 90)
);
console.log('CONFIG_ELS:', JSON.stringify(els));

await browser.close();
