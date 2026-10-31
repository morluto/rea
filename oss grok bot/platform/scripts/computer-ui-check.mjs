import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startHost, stopHost } from '../test/support.mjs';
import { version } from '../packages/host/src/version.mjs';

if (process.env.WORKSHOP_DOCKER_TEST !== '1')
  throw Error(
    'Set WORKSHOP_DOCKER_TEST=1 to create and remove isolated test-owned Linux resources.',
  );
const data = mkdtempSync(join(tmpdir(), 'orbit-computer-ui-'));
const out = resolve('.local/verification');
mkdirSync(out, { recursive: true });
const host = await startHost(data, 14362);
let browser, page, botId;
const errors = [];
const started = Date.now();
async function call(path, value) {
  const response = await host.call(path, value);
  assert.ok(response.status < 300, `${path}: ${JSON.stringify(response.body)}`);
  return response.body;
}
try {
  await call('/auth/setup', {
    name: 'Computer UI verification',
    password: 'Isolated-computer-only-2026',
  });
  const health = await call('/docker');
  assert.equal(health.available, true);
  assert.equal(health.imageReady, true);
  const bot = await call('/bots', {
    name: 'Linux UI verification',
    purpose: 'Verify an actual isolated Linux desktop and viewer',
    role: 'No model configured for this infrastructure check.',
    capabilities: ['computer'],
  });
  botId = bot.id;
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({
    ...(existsSync(edge) ? { executablePath: edge } : {}),
    headless: true,
    chromiumSandbox: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addCookies([
    { name: 'workshop', value: host.cookie().slice('workshop='.length), url: host.base },
  ]);
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  await page.goto(host.base);
  await page.getByRole('button', { name: 'Open Linux UI verification', exact: true }).click();
  await page.getByRole('button', { name: 'Computer', exact: true }).click();
  await page.getByRole('button', { name: 'Start / resume', exact: true }).click();
  await page.getByRole('button', { name: 'Open live viewer', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('#watchcomputer').disabled);
  await page.getByRole('button', { name: 'Open live viewer', exact: true }).click();
  const viewer = page.frameLocator('iframe[title="Live Linux desktop"]');
  await viewer.locator('#status').getByText('Live · watching only', { exact: true }).waitFor();
  await page.locator('iframe[title="Live Linux desktop"]').evaluate((frame) => {
    window.verificationViewer = frame;
    window.verificationRefreshes = 0;
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (String(args[0]).includes('/overview')) window.verificationRefreshes++;
      return response;
    };
  });
  await page.waitForFunction(() => window.verificationRefreshes >= 2);
  assert.equal(
    await page.evaluate(
      () => window.verificationViewer === document.querySelector('#viewer iframe'),
    ),
    true,
    'Background refresh must preserve the connected viewer node',
  );
  await viewer.locator('#status').getByText('Live · watching only', { exact: true }).waitFor();
  await page.screenshot({ path: join(out, 'readiness-linux-watch.png'), fullPage: true });
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await page
    .getByText('You have control. Hand back to let the Bot continue.', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Open live viewer', exact: true }).click();
  await viewer.locator('#status').getByText('Live · human control', { exact: true }).waitFor();
  await viewer.locator('#screen canvas').click({ position: { x: 100, y: 100 } });
  await page.screenshot({ path: join(out, 'readiness-linux-control.png'), fullPage: true });
  await page.getByRole('button', { name: 'Hand back to Bot', exact: true }).click();
  await page
    .getByText('You have control. Hand back to let the Bot continue.', { exact: true })
    .waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Open live viewer', exact: true }).click();
  await viewer.locator('#status').getByText('Live · watching only', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  const report = {
    at: new Date().toISOString(),
    version,
    realDocker: true,
    productionDataUsed: false,
    elapsedMs: Date.now() - started,
    checks: [
      'desktop start',
      'authenticated viewer',
      'viewer survives refresh',
      'human input',
      'handback',
    ],
    errors,
  };
  writeFileSync(join(out, 'readiness-computer-ui.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await page?.screenshot({ path: join(out, 'readiness-computer-ui-failure.png'), fullPage: true });
  console.error(
    JSON.stringify({
      message: error.message,
      viewerStatus: await page
        ?.frameLocator('#viewer iframe')
        .locator('#status')
        .textContent({ timeout: 1000 })
        .catch(() => null),
      errors,
    }),
  );
  throw error;
} finally {
  await browser?.close();
  try {
    if (botId) {
      const overview = await call(`/bots/${botId}/overview`);
      if (overview.computer.controller === 'human')
        await call(`/bots/${botId}/computer/handback`, {});
      await call(`/bots/${botId}/computer/remove`, {
        expectedGeneration: overview.computer.generation,
        confirmRemove: true,
      });
    }
  } finally {
    await stopHost(host);
  }
}
