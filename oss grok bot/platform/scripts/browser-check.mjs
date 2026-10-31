import { openSettings } from '../test/ui.mjs';
import { chromium } from 'playwright';
import { syntheticProvider, startHost, stopHost } from '../test/support.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const data = mkdtempSync(join(tmpdir(), 'bot-workshop-browser-'));
const out = resolve('.local/verification');
mkdirSync(out, { recursive: true });
const provider = await syntheticProvider();
const host = await startHost(data, 14319);
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
let browser, page;
const errors = [];
const started = Date.now();
try {
  browser = await chromium.launch({
    ...(existsSync(edge) ? { executablePath: edge } : {}),
    headless: true,
    chromiumSandbox: true,
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(host.base);
  await page.getByRole('heading', { name: 'Create your workspace' }).waitFor();
  await page.screenshot({ path: join(out, 'workflow-onboarding-account.png'), fullPage: true });
  await page.getByLabel('Account name').fill('synthetic-browser');
  await page.getByLabel('Password (at least 12 characters)').fill('Synthetic-browser-only-2026');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('heading', { name: 'Create a Bot.', exact: false }).waitFor();
  await page.screenshot({ path: join(out, 'workflow-onboarding-home.png'), fullPage: true });
  await openSettings(page);
  await page.getByRole('button', { name: 'Configure a model' }).click();
  await page.getByLabel('Configuration name').fill('Synthetic test provider');
  await page.getByLabel('Base URL').fill(`http://127.0.0.1:${provider.port}/v1`);
  await page.getByLabel('Exact model ID').fill('synthetic-workflow');
  await page.getByRole('button', { name: 'Save configuration' }).click();
  await page.getByRole('button', { name: 'Create your first Bot' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Workflow test');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'Choose a model', exact: true }).click();
  await page
    .getByLabel('Model configuration')
    .selectOption({ label: 'Synthetic test provider · synthetic-workflow (unverified)' });
  await page.getByRole('button', { name: 'Publish revision', exact: true }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await page
    .getByLabel('Message', { exact: true })
    .fill('WORKFLOW_TEST: save a preference and publish the test report.');
  await page.getByRole('button', { name: 'Send ↑' }).click();
  await page
    .getByText(
      'Synthetic test completed. The host tool receipts establish the memory and artifact writes.',
      { exact: false },
    )
    .waitFor({ timeout: 20000 });
  await page.screenshot({ path: join(out, 'workflow-chat.png'), fullPage: true });
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await page.getByRole('heading', { name: 'Test preference' }).waitFor();
  await page.screenshot({ path: join(out, 'workflow-memory.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  await page.getByRole('button', { name: 'synthetic-report.txt', exact: true }).click();
  await page.getByText('Verified bytes, not research data.', { exact: false }).waitFor();
  await page.screenshot({ path: join(out, 'workflow-library.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Add a library file', exact: true }).click();
  await page.locator('#file').setInputFiles({
    name: 'synthetic-interactive.html',
    mimeType: 'text/html',
    buffer: Buffer.from(
      '<!doctype html><html><body><button id="counter">Count 0</button><p id="isolation">Checking</p><script>let n=0;document.querySelector("#counter").onclick=()=>document.querySelector("#counter").textContent="Count "+(++n);try{parent.document.body.dataset.escape="unexpected"}catch{document.querySelector("#isolation").textContent="Parent isolated"}</script></body></html>',
    ),
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'synthetic-interactive.html', exact: true }).click();
  await page.getByRole('button', { name: 'Open interactive preview' }).click();
  const artifact = page.frameLocator('iframe[title="Sandboxed artifact"]');
  await artifact.getByText('Parent isolated', { exact: true }).waitFor();
  await artifact.getByRole('button', { name: 'Count 0' }).click();
  await artifact.getByRole('button', { name: 'Count 1' }).waitFor();
  assert.equal(await page.evaluate(() => document.body.dataset.escape), undefined);
  await page.screenshot({ path: join(out, 'workflow-interactive.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Routines', exact: true }).click();
  await page.getByRole('button', { name: 'New routine' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Synthetic morning check');
  await page.getByLabel('Task', { exact: true }).fill('Report synthetic status only.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('heading', { name: 'Synthetic morning check' }).waitFor();
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
  await page.screenshot({ path: join(out, 'workflow-routines.png'), fullPage: true });
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: 'Add knowledge' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Synthetic source');
  await page
    .getByLabel('Content', { exact: true })
    .fill('This knowledge was entered by the synthetic browser test.');
  await page.getByLabel('Source URL, document or user reference').fill('Synthetic browser fixture');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('heading', { name: 'Synthetic source', exact: true }).waitFor();
  await page.locator('.tools-disclosure > summary').evaluate((node) => node.click());
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Connect Google / Microsoft mail or calendar' }).click();
  await page.getByLabel('Your registered OAuth client ID').waitFor();
  await page.screenshot({ path: join(out, 'workflow-oauth.png'), fullPage: true });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'People & rooms', exact: true }).click();
  await page.getByRole('heading', { name: 'People, teams & rooms', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Computer', exact: true }).click();
  await page.getByText('Computer settings', { exact: true }).click();
  await page.getByRole('button', { name: 'Idle policy', exact: true }).click();
  await page.getByLabel('Pause after idle seconds').fill('60');
  await page.getByLabel('Stop after idle seconds').fill('120');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Pause after 60s idle; stop after 120s.', { exact: false }).waitFor();
  await page.screenshot({ path: join(out, 'workflow-computer-policy.png'), fullPage: true });
  await page.getByRole('button', { name: 'Reset / update', exact: true }).click();
  await page.getByLabel('Computer change').selectOption('remove');
  await page.getByRole('button', { name: 'Apply computer change', exact: true }).click();
  await page.getByText('Confirm permanent volume removal to continue', { exact: true }).waitFor();
  await page.getByLabel('Computer change').selectOption('reset');
  await page.getByRole('button', { name: 'Apply computer change', exact: true }).click();
  await page.getByText(/Generation 2\./).waitFor();
  await page.getByRole('button', { name: 'Retained computers', exact: true }).click();
  await page.getByRole('heading', { name: 'Generation 1', exact: true }).waitFor();
  await page.screenshot({ path: join(out, 'workflow-computer-generations.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await page.getByRole('button', { name: 'New conversation', exact: false }).click();
  await page
    .getByLabel('Message', { exact: true })
    .fill('CANCEL_TEST: validate the live working mascot.');
  await page.getByRole('button', { name: 'Send ↑' }).click();
  await page.locator('#header [data-mascot-state="working"]').waitFor();
  const workingNode = await page.locator('#header .mascot').elementHandle();
  await page.waitForTimeout(1100);
  assert.equal(
    await workingNode.evaluate((el) => el === document.querySelector('#header .mascot')),
    true,
    'Polling preserves the live mascot node and animation',
  );
  assert.equal(
    await page.locator('#header .orb-roll').evaluate((el) => getComputedStyle(el).animationName),
    'orb-roll',
  );
  await page.screenshot({ path: join(out, 'workflow-working.png'), fullPage: true });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.locator('#header [data-mascot-state="idle"]').waitFor();
  await page.getByRole('button', { name: 'New conversation', exact: false }).click();
  await page.getByLabel('Message', { exact: true }).fill('WAIT_TEST: ask a question.');
  await page.getByRole('button', { name: 'Send ↑' }).click();
  await page.locator('#header [data-mascot-state="waiting"]').waitFor();
  await page.getByRole('heading', { name: 'Which synthetic format?' }).waitFor();
  await page.getByLabel('Answer', { exact: true }).fill('Brief');
  await page.screenshot({ path: join(out, 'workflow-question.png'), fullPage: true });
  await page.getByRole('button', { name: 'Continue task', exact: true }).click();
  await page.locator('#header [data-mascot-state="idle"]').waitFor();
  await page.getByRole('button', { name: 'New conversation', exact: false }).click();
  await page
    .getByLabel('Message', { exact: true })
    .fill('MARKDOWN_TEST: render readable, sanitized output.');
  await page.getByRole('button', { name: 'Send ↑' }).click();
  await page.getByRole('heading', { name: 'Synthetic Markdown', exact: true }).waitFor();
  assert.equal(await page.locator('.markdown-body img').count(), 0);
  assert.equal(await page.locator('.markdown-body a[href^="javascript:"]').count(), 0);
  assert.equal(await page.evaluate(() => document.body.dataset.unsafe), undefined);
  await page.screenshot({ path: join(out, 'workflow-markdown.png'), fullPage: true });
  await page.keyboard.press('Control+k');
  await page.getByLabel('Search Bots and workspace tools').fill('Workflow');
  await page
    .getByRole('button', { name: 'Workflow test Synthetic workflow', exact: false })
    .waitFor();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator('#navigation')
    .evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {}))));
  await page.screenshot({ path: join(out, 'workflow-mobile.png'), fullPage: true });
  assert.ok(
    (await page.locator('#navigation').boundingBox()).x <= -270,
    'Mobile navigation folds outside the work area',
  );
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Your workspace', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('#navigation').inert &&
      document.querySelector('#navigation').getBoundingClientRect().right <= 0,
  );
  await page.screenshot({ path: join(out, 'workflow-mobile-home.png'), fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.ok(
    await page
      .locator('.mascot .orb-body')
      .first()
      .evaluate((el) => getComputedStyle(el).animationName === 'none'),
    'Reduced motion stops the mascot animation',
  );
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, 'No horizontal overflow at narrow width');
  assert.deepEqual(errors, [], 'No uncaught UI errors');
  const metrics = await page.evaluate(() => fetch('/api/metrics').then((r) => r.json()));
  const result = {
    at: new Date().toISOString(),
    mode: 'synthetic HTTP provider through real Pi SDK',
    dataDirectory: data,
    elapsedMs: Date.now() - started,
    providerRequests: provider.requests.length,
    metrics,
    errors,
    screenshots: [
      'workflow-onboarding-account.png',
      'workflow-onboarding-home.png',
      'workflow-chat.png',
      'workflow-working.png',
      'workflow-question.png',
      'workflow-markdown.png',
      'workflow-memory.png',
      'workflow-library.png',
      'workflow-interactive.png',
      'workflow-routines.png',
      'workflow-oauth.png',
      'workflow-computer-policy.png',
      'workflow-computer-generations.png',
      'workflow-mobile.png',
      'workflow-mobile-home.png',
    ],
    limitations: [
      'No real model response',
      'No Docker computer is provisioned by this UI test',
      'No real OAuth provider authenticated',
      'Host metrics exclude browser/container process families',
      'No before/after performance baseline',
    ],
  };
  writeFileSync(join(out, 'browser-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (page) {
    await page
      .screenshot({ path: join(out, 'workflow-failure.png'), fullPage: true })
      .catch(() => {});
    const state = await page
      .evaluate(() => fetch('/api/state').then((r) => r.json()))
      .catch(() => null);
    writeFileSync(
      join(out, 'browser-failure.json'),
      JSON.stringify({ message: error.message, errors, state, dataDirectory: data }, null, 2),
    );
  }
  console.error(JSON.stringify({ errors, host: host.logs(), dataDirectory: data }));
  throw error;
} finally {
  await browser?.close();
  await stopHost(host);
  await new Promise((r) => provider.server.close(r));
}
