import { chromium } from 'playwright';

const SHELL = 'C:/Users/nisar/AppData/Local/Temp/pw-browsers/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe';
const BASE = 'http://127.0.0.1:14371';

const browser = await chromium.launch({ executablePath: SHELL });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('input[name="name"]', 'Taste');
await page.fill('input[name="password"]', 'taste-test-pass-1');
await page.click('.auth-submit');
await page.waitForSelector('.layout', { timeout: 15000 });
await page.waitForTimeout(600);
console.log('=== HOME workspace text ===');
console.log((await page.locator('#workspace').innerText()).slice(0, 600));
await page.locator('.botlist button').first().click();
await page.waitForTimeout(900);
console.log('=== BOT workspace text ===');
console.log((await page.locator('#workspace').innerText()).slice(0, 900));
await page.click('#settings');
await page.waitForSelector('#dialog[open]', { timeout: 8000 });
await page.waitForTimeout(600);
console.log('=== SETTINGS dialog text ===');
console.log((await page.locator('#dialog').innerText()).slice(0, 900).catch?.() ?? '');
await browser.close();
