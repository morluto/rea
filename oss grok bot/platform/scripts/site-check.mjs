import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const out = resolve('.local/verification');
mkdirSync(out, { recursive: true });
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const errors = [];
const browser = await chromium.launch({
  ...(existsSync(edge) ? { executablePath: edge } : {}),
  headless: true,
  chromiumSandbox: true,
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('http://127.0.0.1:4318');
    await page.getByRole('heading', { name: 'Give your Bots a place to work.' }).waitFor();
    await page.getByRole('button', { name: 'Working', exact: true }).click();
    assert.equal(
      await page.locator('#orb [data-mascot-state]').getAttribute('data-mascot-state'),
      'working',
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({ path: join(out, `website-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  writeFileSync(
    join(out, 'website-result.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        widths: [1440, 768, 390],
        errors,
        checks: [
          'shared original mascot interaction',
          'no horizontal overflow',
          'real build availability',
        ],
      },
      null,
      2,
    ),
  );
  console.log('Website verified at 1440, 768 and 390 px; no uncaught UI errors.');
} finally {
  await browser.close();
}
