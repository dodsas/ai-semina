import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const pages = ctx.pages();
let page = pages.find((p) => p.url().includes('dashboard.render.com')) || (await ctx.newPage());
await page.bringToFront();

await page.goto('https://dashboard.render.com/select-repo?type=blueprint', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
await page.getByRole('button', { name: 'Connect', exact: true }).first().click();
await page.waitForTimeout(6000);

// dodsas → your-name
await page.evaluate(() => {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (w.nextNode()) nodes.push(w.currentNode);
  nodes.forEach((n) => {
    if (n.nodeValue && n.nodeValue.includes('dodsas')) n.nodeValue = n.nodeValue.replace(/dodsas/g, 'your-name');
  });
});

const deploy = page.getByRole('button', { name: 'Deploy Blueprint', exact: true }).first();
await deploy.scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
const b = await deploy.boundingBox();
await page.evaluate(
  ({ b, pad }) => {
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
  },
  { b, pad: 8 }
);
await page.screenshot({ path: 'public/images/render-4-deploy.png' });
await page.evaluate(() => document.querySelectorAll('.__redbox').forEach((e) => e.remove()));
console.log('SAVED render-4-deploy.png');

await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
await page.waitForTimeout(1500);
console.log('CANCELLED ->', page.url());
await browser.close();
