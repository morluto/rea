import { chromium } from 'playwright';

const SHELL = 'C:/Users/nisar/AppData/Local/Temp/pw-browsers/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe';
const BASE = 'http://127.0.0.1:14371';
const OUT = '../after/';

const browser = await chromium.launch({ executablePath: SHELL });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('input[name="name"]', 'Taste');
await page.fill('input[name="password"]', 'taste-test-pass-1');
await page.click('.auth-submit');
await page.waitForSelector('.layout', { timeout: 15000 });
await page.waitForTimeout(800);
await page.screenshot({ path: OUT + 'home-1440.png' });

// create a bot via the page's own session (no model attached: exercises the needs-model state)
const created = await page.request.post(BASE + '/api/bots', {
  headers: { Origin: BASE },
  data: { name: 'TasteBot', purpose: 'A bot for taste review.', role: 'You are a taste review bot.' },
});
console.log('create bot:', created.status());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const botCard = page.locator('.botlist [data-bot], .botlist button').first();
if ((await botCard.count()) > 0) {
  await botCard.click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: OUT + 'bot-1440.png' });
} else {
  console.log('no bot card found');
}
await page.click('#settings');
await page.waitForTimeout(1000);
await page.screenshot({ path: OUT + 'settings-1440.png' });

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
await page.screenshot({ path: OUT + 'settings-390.png' });
await page.click('#workspacehome').catch(() => {});
await page.waitForTimeout(600);
await page.screenshot({ path: OUT + 'home-390.png' });
await browser.close();
console.log('done');
