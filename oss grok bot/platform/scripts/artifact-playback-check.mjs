import { chromium } from 'playwright';
import { startHost, stopHost } from '../test/support.mjs';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

if (!process.env.WORKSHOP_GAME_ARTIFACT)
  throw Error('Set WORKSHOP_GAME_ARTIFACT to the standalone voxel game HTML to verify.');
const content = readFileSync(process.env.WORKSHOP_GAME_ARTIFACT, 'utf8');
const host = await startHost(mkdtempSync(join(tmpdir(), 'orbit-game-check-')), 14361);
const out = resolve('.local/verification');
mkdirSync(out, { recursive: true });
let browser;
const errors = [];
try {
  await host.call('/auth/setup', { name: 'synthetic-game', password: 'Synthetic-game-only-2026' });
  const bot = (
    await host.call('/bots', {
      name: 'Game verification',
      purpose: 'Isolated playback check',
      role: 'No model used.',
      capabilities: ['library'],
    })
  ).body;
  const revision = (
    await host.call('/bots/' + bot.id + '/artifacts', {
      name: 'voxel-sandbox.html',
      mediaType: 'text/html',
      content,
    })
  ).body.revision;
  browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    chromiumSandbox: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(host.base);
  await page.getByLabel('Account name').fill('synthetic-game');
  await page.getByLabel('Password (at least 12 characters)').fill('Synthetic-game-only-2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Open Game verification', exact: true }).click();
  const link = await page.evaluate(
    async ({ botId, revision }) => {
      const { markdown } = await import('/markdown.js');
      return markdown('[Open game](artifact://' + revision.id + ') [unsafe](javascript:alert(1))', {
        botId,
        revisions: [revision],
      });
    },
    { botId: bot.id, revision },
  );
  assert.ok(link.includes('data-artifact-revision="' + revision.id + '"'));
  assert.ok(!link.includes('javascript:'));
  await page.getByRole('button', { name: 'View conversation details', exact: true }).click();
  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  await page.getByRole('button', { name: 'voxel-sandbox.html', exact: true }).click();
  await page.getByRole('button', { name: 'Open interactive preview', exact: true }).click();
  const frame = page.frameLocator('iframe[title="Sandboxed artifact"]');
  await frame.getByRole('button', { name: 'Play', exact: true }).waitFor();
  assert.equal(await frame.locator('canvas').count(), 0);
  await page.getByRole('button', { name: 'Play with CDN & mouse', exact: true }).click();
  await frame.locator('canvas').waitFor({ timeout: 45000 });
  await frame.getByRole('button', { name: 'Play', exact: true }).click();
  await frame.locator('#start').waitFor({ state: 'hidden' });
  const capture = await frame
    .locator('canvas')
    .evaluate((canvas) => document.pointerLockElement === canvas);
  assert.equal(capture, true);
  const before = await frame.locator('#coords').innerText();
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(800);
  await page.keyboard.up('KeyD');
  const after = await frame.locator('#coords').innerText();
  assert.notEqual(after, before);
  await page.keyboard.press('Digit2');
  assert.equal(await frame.locator('#hotbar .slot.active small').innerText(), '2');
  const isolated = await frame.locator('body').evaluate(async () => {
    let parentBlocked = false;
    try {
      void parent.document.body;
    } catch {
      parentBlocked = true;
    }
    let apiBlocked = false;
    try {
      await fetch(location.origin + '/api/state');
    } catch {
      apiBlocked = true;
    }
    return { parentBlocked, apiBlocked, nativeBridge: typeof window.workshopDesktop };
  });
  assert.deepEqual(isolated, { parentBlocked: true, apiBlocked: true, nativeBridge: 'undefined' });
  await page.screenshot({ path: join(out, 'artifact-game-playback.png') });
  const result = {
    at: new Date().toISOString(),
    digest: createHash('sha256').update(content).digest('hex'),
    pointerLock: capture,
    before,
    after,
    isolated,
    errors,
    limitations: [
      'Browser playback, not native Electron playback.',
      'Mining and placement are not independently verified.',
    ],
  };
  writeFileSync(join(out, 'artifact-game-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await stopHost(host);
}
