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

async function maskDodsas() {
  await page.evaluate(() => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (w.nextNode()) nodes.push(w.currentNode);
    nodes.forEach((n) => {
      if (n.nodeValue && n.nodeValue.includes('dodsas')) n.nodeValue = n.nodeValue.replace(/dodsas/g, 'your-name');
    });
  });
}

async function boxShotRects(rects, path, pad = 6) {
  if (!rects.length) return console.log('NO RECT for', path);
  await page.evaluate(drawScript(), { rects, pad });
  await page.screenshot({ path });
  await page.evaluate(() => document.querySelectorAll('.__redbox').forEach((e) => e.remove()));
  console.log('SAVED', path);
}

// select-repo → ai-semina Connect → /blueprint/new
await page.goto('https://dashboard.render.com/select-repo?type=blueprint', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
await page.getByRole('button', { name: 'Connect', exact: true }).first().click();
await page.waitForTimeout(6000);
console.log('AT:', page.url());

await maskDodsas();
await page.waitForTimeout(200);

// 3) 환경변수 Value 입력칸 4개
const vals = page.getByPlaceholder('Enter value');
const n = await vals.count();
const rects = [];
for (let i = 0; i < n; i++) {
  const b = await vals.nth(i).boundingBox().catch(() => null);
  if (b) rects.push(b);
}
await boxShotRects(rects, 'public/images/render-3-env.png', 7);

// 4) Deploy Blueprint 버튼
const deploy = page.getByRole('button', { name: 'Deploy Blueprint', exact: true }).first();
const db = await deploy.boundingBox().catch(() => null);
await boxShotRects(db ? [db] : [], 'public/images/render-4-deploy.png', 8);

// 배포하지 않고 취소
await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
await page.waitForTimeout(1500);
console.log('CANCELLED -> ', page.url());

await browser.close();
console.log('DONE');
