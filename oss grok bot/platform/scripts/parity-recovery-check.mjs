import { openSettings } from '../test/ui.mjs';
import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Isolated native source candidate: never attach to the user's workspace/profile.
const root = mkdtempSync(join(tmpdir(), 'orbit-parity-recovery-'));
const profile = join(root, 'profile');
mkdirSync(profile);
writeFileSync(join(profile, 'host-choice.json'), JSON.stringify({ mode: 'primary', url: null }));
const out = resolve('.local/parity/round-002-' + Date.now());
mkdirSync(out, { recursive: true });
const env = {
  ...process.env,
  WORKSHOP_DESKTOP_DATA: join(root, 'data'),
  WORKSHOP_DESKTOP_PROFILE: profile,
  WORKSHOP_DESKTOP_PORT: '14368',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const app = await electron.launch({ args: [resolve('apps/desktop/main.mjs')], env });
const page = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0].setBounds({ width: 1042, height: 761 });
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(25000);
try {
  await page.waitForURL('http://127.0.0.1:14368/**');
  await page.getByLabel('Account name').fill('Synthetic parity owner');
  await page.getByLabel('Password (at least 12 characters)').fill('Synthetic-parity-2026');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('button', { name: 'Create your first Bot' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Recovery check');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'Computer', exact: true }).click();
  await page.locator('#refreshinfrastructure').waitFor();
  const health = await page.evaluate(async () => (await fetch('/api/docker')).json());
  assert.equal(await page.locator('#infrastructure details').isVisible(), false);
  if (!health.available) await page.getByText(health.reason, { exact: true }).waitFor();
  await page.screenshot({ path: join(out, 'computer-default.png') });
  await page.locator('#viewer').evaluate((el) => {
    el.dataset.retainedIdentity = 'native-disclosure-check';
  });
  await openSettings(page);
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/settings') && response.request().method() === 'POST',
    ),
    page.getByLabel('Show advanced controls').check(),
  ]);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  assert.equal(
    await page.evaluate(
      async () => (await (await fetch('/api/state')).json()).settings.showAdvanced,
    ),
    true,
  );
  await page.locator('#infrastructure details').waitFor({ state: 'visible' });
  assert.equal(
    await page.locator('#viewer').getAttribute('data-retained-identity'),
    'native-disclosure-check',
  );
  await page.screenshot({ path: join(out, 'computer-advanced.png') });
  // Controlled transport delay establishes pending feedback separately from real engine health.
  let releaseCheck;
  const pendingCheck = new Promise((r) => {
    releaseCheck = r;
  });
  await page.route('**/api/docker', async (route) => {
    await pendingCheck;
    await route.continue();
  });
  await page.locator('#refreshinfrastructure').click();
  assert.match(await page.locator('#refreshinfrastructure').textContent(), /Checking/);
  releaseCheck();
  await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor();
  await page.unroute('**/api/docker');
  let cliStartHealth = null;
  if (health.canStart && !health.available && !process.argv.includes('--skip-engine-start')) {
    await page.getByRole('button', { name: 'Start Linux engine', exact: true }).click();
    await page.getByRole('button', { name: 'Starting engine...', exact: true }).waitFor();
    await page.screenshot({ path: join(out, 'engine-start-pending.png') });
    await page
      .getByRole('button', { name: 'Start Linux engine', exact: true })
      .waitFor({ timeout: 50000 });
    cliStartHealth = await page.evaluate(async () => (await fetch('/api/docker')).json());
    if (!cliStartHealth.available)
      await page.getByText(cliStartHealth.reason, { exact: true }).waitFor();
    await page.screenshot({ path: join(out, 'engine-start-result.png') });
  }
  assert.deepEqual(errors, []);
  writeFileSync(
    join(out, 'result.json'),
    JSON.stringify(
      {
        sourceCandidate: true,
        installed: false,
        root,
        health,
        cliStartHealth,
        errors,
        checks: [
          'native Settings save',
          'Advanced hidden by default',
          'Advanced persisted',
          'native retry pending and settlement',
        ],
        capturedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(out);
  if (process.argv.includes('--hold')) {
    console.log(
      'Candidate retained for computer-use inspection. Quit this isolated candidate with Ctrl+Q to finish.',
    );
    await app.waitForEvent('close', { timeout: 0 });
  }
} finally {
  await app.close();
}
