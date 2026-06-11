import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const pages = ctx.pages();
let page = pages.find((p) => p.url().includes('dashboard.render.com')) || (await ctx.newPage());
await page.bringToFront();

await page.goto('https://dashboard.render.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
console.log('URL:', page.url());
console.log('TITLE:', await page.title());
await page.screenshot({ path: 'public/images/_recon_render.png' });

const items = await page.$$eval('a,button,[role="button"]', (els) =>
  els
    .map((e) => ({
      tag: e.tagName,
      t: (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40),
      href: e.getAttribute('href') || '',
    }))
    .filter((x) => x.t)
    .slice(0, 80)
);
console.log('ELEMENTS:', JSON.stringify(items));

await browser.close();
