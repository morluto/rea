import { chromium } from 'playwright';
const SHELL = 'C:/Users/nisar/AppData/Local/Temp/pw-browsers/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe';
const browser = await chromium.launch({ executablePath: SHELL });
for (const w of [390, 1440]) {
  const page = await (await browser.newContext({ viewport: { width: w, height: 844 } })).newPage();
  await page.goto('http://127.0.0.1:14372/', { waitUntil: 'networkidle' });
  const r = await page.evaluate(() => {
    const m = document.querySelector('.onboard-emblem .mascot');
    const b = m.getBoundingClientRect();
    return { size: getComputedStyle(m).getPropertyValue('--size').trim(), top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), vh: innerHeight, vw: innerWidth };
  });
  console.log(w + 'px:', JSON.stringify(r), r.bottom <= r.vh && r.top >= 0 && r.left >= 0 && r.right <= r.vw ? 'INSIDE-VIEWPORT' : 'CLIPPED');
  await page.close();
}
await browser.close();
