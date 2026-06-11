import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const pages = ctx.pages();

console.log('ALL_PAGES:');
for (const p of pages) console.log('  -', p.url());

let page = pages.find((p) => p.url().includes('app.turso.tech'));
if (!page) {
  page = await ctx.newPage();
  await page.goto('https://app.turso.tech', { waitUntil: 'domcontentloaded' });
}

await page.bringToFront();
await page.waitForTimeout(4500);

console.log('FINAL_URL:', page.url());
console.log('TITLE:', await page.title());

await page.screenshot({ path: 'public/images/_recon.png' });

const items = await page.$$eval('a,button,[role="button"]', (els) =>
  els
    .map((e) => ({
      t: (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50),
      tag: e.tagName,
      href: e.getAttribute('href') || '',
    }))
    .filter((x) => x.t)
    .slice(0, 120)
);
console.log('ELEMENTS:', JSON.stringify(items));

await browser.close();
