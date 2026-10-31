import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { openSettings } from '../test/ui.mjs';

const root = mkdtempSync(join(tmpdir(), 'orbit-parity-account-'));
const profile = join(root, 'profile');
mkdirSync(profile);
writeFileSync(join(profile, 'host-choice.json'), JSON.stringify({ mode: 'primary', url: null }));
const out = resolve(`.local/parity/round-014-account-${Date.now()}`);
mkdirSync(out, { recursive: true });
const env = {
  ...process.env,
  WORKSHOP_DESKTOP_DATA: join(root, 'data'),
  WORKSHOP_DESKTOP_PROFILE: profile,
  WORKSHOP_DESKTOP_PORT: '14378',
  WORKSHOP_DOCKER_BIN: join(root, 'intentionally-absent-docker.exe'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const app = await electron.launch({ args: [resolve('apps/desktop/main.mjs')], env });
const page = await app.firstWindow(),
  errors = [],
  checks = [];
page.setDefaultTimeout(15000);
page.on('pageerror', (error) => errors.push(error.message));
const menu = () => page.getByRole('menu', { name: 'Account', exact: true });
const open = async () => {
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await menu().waitFor();
};
try {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ x: 1, y: 100, width: 1040, height: 760 }),
  );
  await page.waitForURL('http://127.0.0.1:14378/**');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByLabel('Account name').fill('Synthetic account owner');
  await page.getByLabel('Password (at least 12 characters)').fill('Synthetic-account-2026');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await open();
  assert.equal(
    await menu().getByRole('menuitem').filter({ hasText: 'Usage & Billing' }).count(),
    1,
  );
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator(':focus').textContent(), 'Support');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator(':focus').textContent(), 'Help Center');
  assert.equal(
    await page.getByRole('menuitem', { name: 'Send Feedback', exact: true }).isDisabled(),
    true,
  );
  await page.screenshot({ path: join(out, 'support.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator(':focus').textContent(), 'Support');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('End');
  assert.equal(await page.locator(':focus').textContent(), 'About');
  await page.keyboard.press('Enter');
  await page
    .getByRole('dialog')
    .getByText('Independent personal Bot workspace', { exact: true })
    .waitFor();
  const native = await page.evaluate(() => window.workshopDesktop.info());
  assert.equal(
    await page.getByRole('dialog').getByText(`Version ${native.version}`, { exact: true }).count(),
    1,
  );
  await page.screenshot({ path: join(out, 'about.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  await page.getByRole('button', { name: 'Copy version info', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('#toast').textContent === 'Version info copied',
  );
  assert.match(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    /^Orbit .+\nHost .+\nPlatform win32$/,
  );
  assert.equal(
    await page.evaluate(async () => {
      try {
        await window.workshopDesktop.copyText({ invalid: true });
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  checks.push(
    'account and nested Support menus support keyboard navigation; About uses actual native/host versions and copies actual version info',
  );
  for (const item of ['Help Center', 'Keyboard shortcuts']) {
    await open();
    await page.getByRole('menuitem', { name: 'Support', exact: true }).click();
    await page.getByRole('menuitem', { name: item, exact: true }).click();
    await page.getByRole('dialog').getByRole('heading', { name: item, exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
  }
  await open();
  await page.getByRole('menuitem', { name: 'Usage & Billing', exact: true }).click();
  assert.equal(
    await page
      .getByRole('tab', { name: 'Usage & Billing', exact: true })
      .getAttribute('aria-selected'),
    'true',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await openSettings(page);
  const saved = () =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/settings') && response.request().method() === 'POST',
    );
  await Promise.all([saved(), page.getByLabel('Show advanced controls', { exact: true }).check()]);
  await page
    .getByLabel('Feedback page (HTTPS)', { exact: true })
    .fill('https://example.invalid/orbit-feedback?source=test#draft');
  await Promise.all([saved(), page.getByLabel('Feedback page (HTTPS)', { exact: true }).blur()]);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await open();
  await page.getByRole('menuitem', { name: 'Support', exact: true }).click();
  assert.equal(
    await page.getByRole('menuitem', { name: 'Send Feedback', exact: true }).getAttribute('href'),
    'https://example.invalid/orbit-feedback?source=test#draft',
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: /Settings/ }).click();
  await page.getByRole('tab', { name: 'General', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  checks.push(
    'Help Center and shortcuts open; Usage selects its real settings pane; feedback is disabled until configured and preserves its exact HTTPS destination without navigation; quick switch Settings opens directly',
  );
  await open();
  await page.getByRole('menuitem', { name: 'Switch account', exact: true }).click();
  assert.equal(
    await page
      .getByRole('menuitemradio', { name: 'Synthetic account owner', exact: true })
      .getAttribute('aria-checked'),
    'true',
  );
  await page.screenshot({ path: join(out, 'switch.png') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // Delay one genuine state response across logout, rather than fabricating its contents.
  let release, capturedResolve;
  const captured = new Promise((resolve) => {
    capturedResolve = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    '**/api/state',
    async (route) => {
      const response = await route.fetch();
      capturedResolve();
      await gate;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await captured;
  await open();
  await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  release();
  await page.waitForTimeout(500);
  assert.equal(
    await page.getByRole('button', { name: 'Sign in', exact: true }).isVisible(),
    true,
    'a delayed authenticated state response must not replace sign-in with the old workspace',
  );
  assert.equal(await page.getByRole('button', { name: 'Account menu', exact: true }).count(), 0);
  checks.push(
    'sign-out remains signed out when a previously fetched authenticated state response arrives late',
  );
  await page.getByLabel('Account name').fill('Synthetic account owner');
  await page.getByLabel('Password (at least 12 characters)').fill('Synthetic-account-2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await open();
  await page.getByRole('menuitem', { name: 'Support', exact: true }).click();
  await page.getByRole('menuitem', { name: 'About', exact: true }).click();
  await page.getByRole('dialog').getByText(`Version ${native.version}`, { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  // Windows has an 800px minimum. This is a web viewport emulation, not a
  // claim that the shipped native window can be resized below that minimum.
  await page.setViewportSize({ width: 390, height: 760 });
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await open();
  await page.getByRole('menuitem', { name: 'Support', exact: true }).click();
  const mobileBounds = await page.getByRole('menu', { name: 'Support', exact: true }).boundingBox();
  assert.ok(
    mobileBounds.x >= 0 &&
      mobileBounds.x + mobileBounds.width <= 390 &&
      mobileBounds.y >= 0 &&
      mobileBounds.y + mobileBounds.height <= 760,
    JSON.stringify(mobileBounds),
  );
  await page.screenshot({ path: join(out, 'mobile-support.png') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  checks.push(
    'fresh sign-in works after late-response logout; Support submenu stays inside an emulated 390px web viewport (native minimum remains 800px)',
  );
  await page.setViewportSize({ width: 1040, height: 760 });
  await open();
  await page.getByRole('menuitem', { name: 'Support', exact: true }).click();
  assert.deepEqual(errors, []);
  writeFileSync(
    join(out, 'result.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        sourceCandidate: true,
        installed: false,
        synthetic: true,
        root,
        native,
        checks,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(out);
  if (process.argv.includes('--hold')) {
    console.log('Native account fixture retained. Quit normally with Ctrl+Q.');
    await app.waitForEvent('close', { timeout: 0 });
  }
} catch (error) {
  await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  writeFileSync(
    join(out, 'failure.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        checks,
        errors,
        toast: await page.locator('#toast').textContent(),
        error: error.message,
      },
      null,
      2,
    ),
  );
  console.log(out);
  throw error;
} finally {
  await app.close();
}
