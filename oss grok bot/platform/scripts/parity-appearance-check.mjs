import { openSettings } from '../test/ui.mjs';
import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'orbit-parity-appearance-'));
const profile = join(root, 'profile');
mkdirSync(profile);
writeFileSync(join(profile, 'host-choice.json'), JSON.stringify({ mode: 'primary', url: null }));
const out = resolve(`.local/parity/${process.env.ORBIT_PARITY_ROUND ?? 'round-005'}-${Date.now()}`);
mkdirSync(out, { recursive: true });
const env = {
  ...process.env,
  WORKSHOP_DESKTOP_DATA: join(root, 'data'),
  WORKSHOP_DESKTOP_PROFILE: profile,
  WORKSHOP_DESKTOP_PORT: '14368',
  WORKSHOP_DOCKER_BIN: join(root, 'intentionally-absent-docker.exe'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const app = await electron.launch({ args: [resolve('apps/desktop/main.mjs')], env });
const page = await app.firstWindow(),
  errors = [];
page.setDefaultTimeout(20000);
page.on('pageerror', (error) => errors.push(error.message));
try {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ x: 1, y: 100, width: 1040, height: 760 }),
  );
  await page.waitForURL('http://127.0.0.1:14368/**');
  await page.getByLabel('Account name').fill('Synthetic appearance owner');
  await page.getByLabel('Password (at least 12 characters)').fill('Synthetic-appearance-2026');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  const settings = () => openSettings(page);
  const effective = () => page.locator('html').getAttribute('data-theme');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  const saved = () =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/settings') && response.request().method() === 'POST',
    );
  await settings();
  assert.equal(await page.getByLabel('Theme', { exact: true }).inputValue(), 'system');
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  await Promise.all([saved(), page.getByLabel('Theme', { exact: true }).selectOption('light')]);
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.screenshot({ path: join(out, 'light.png') });
  await settings();
  await Promise.all([saved(), page.getByLabel('Theme', { exact: true }).selectOption('system')]);
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.reload();
  await page.getByRole('button', { name: 'Account menu', exact: true }).waitFor();
  assert.equal(await effective(), 'light');
  await settings();
  await Promise.all([saved(), page.getByLabel('Theme', { exact: true }).selectOption('dark')]);
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.screenshot({ path: join(out, 'dark.png') });
  await settings();
  await Promise.all([saved(), page.getByLabel('Theme', { exact: true }).selectOption('light')]);
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await Promise.all([
    saved(),
    page.getByLabel('Check Spelling While Typing', { exact: true }).uncheck(),
  ]);
  await Promise.all([
    saved(),
    page.getByLabel('Timezone', { exact: true }).selectOption('America/Toronto'),
  ]);
  for (const section of ['Computer', 'Permissions', 'Vault', 'Usage & Billing', 'Updates']) {
    await page.getByRole('tab', { name: section, exact: true }).click();
    await page.getByRole('tabpanel', { name: section, exact: true }).waitFor();
    await page
      .getByRole('tabpanel', { name: section, exact: true })
      .getByText('Loading', { exact: false })
      .waitFor({ state: 'hidden' });
    assert.equal(
      await page
        .getByRole('tabpanel', { name: section, exact: true })
        .locator('[role="alert"]')
        .count(),
      0,
    );
  }
  await page
    .getByRole('tabpanel', { name: 'Updates', exact: true })
    .getByText('Version', { exact: false })
    .first()
    .waitFor();
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  assert.equal(
    await page.getByLabel('Check Spelling While Typing', { exact: true }).isChecked(),
    false,
  );
  assert.equal(await page.getByLabel('Timezone', { exact: true }).inputValue(), 'America/Toronto');
  let failEngineRead = true;
  await page.route('**/api/docker', async (route) => {
    if (failEngineRead) {
      failEngineRead = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Synthetic engine status read failed' } }),
      });
    } else await route.continue();
  });
  await page.getByRole('tab', { name: 'Computer', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'Synthetic engine status read failed' })
    .waitFor();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'Synthetic engine status read failed' })
    .waitFor({ state: 'hidden' });
  await page.getByText(/^Checked /).waitFor();
  await page.unroute('**/api/docker');
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await Promise.all([saved(), page.getByLabel('Show advanced controls', { exact: true }).check()]);
  await page.getByLabel('Feedback page (HTTPS)', { exact: true }).fill('not a url');
  await page.getByLabel('Feedback page (HTTPS)', { exact: true }).blur();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-settings-tab="general"]')?.getAttribute('aria-selected') ===
      'true',
  );
  assert.match(await page.locator('#formerror').innerText(), /https/);
  await page.getByLabel('Feedback page (HTTPS)', { exact: true }).fill('');
  await Promise.all([saved(), page.getByLabel('Feedback page (HTTPS)', { exact: true }).blur()]);
  assert.equal(await page.locator('#formerror').innerText(), '');
  assert.equal(
    await page.getByLabel('Check Spelling While Typing', { exact: true }).isChecked(),
    false,
  );
  await Promise.all([saved(), page.getByLabel('Accent', { exact: true }).selectOption('black')]);
  await Promise.all([saved(), page.getByLabel('Language', { exact: true }).selectOption('fr')]);
  await page.getByLabel('Microphone', { exact: true }).selectOption('system');
  await Promise.all([
    saved(),
    page.getByLabel('Use hardware acceleration', { exact: true }).uncheck(),
  ]);
  await page.getByLabel('Timezone', { exact: true }).selectOption('America/Toronto');
  assert.equal(
    await page
      .getByRole('switch', { name: 'Use hardware security keys', exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole('tab', { name: 'Computer', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(
    await page.getByRole('tab', { name: 'Permissions', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  await page.evaluate(() => {
    const input = document.querySelector('#settings-import-file');
    const file = new File(['{}'], 'memory.json', { type: 'application/json' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
  });
  assert.match(await page.locator('#settings-import-status').innerText(), /was not imported/);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  assert.equal(
    JSON.parse(readFileSync(join(profile, 'graphics.json'), 'utf8')).hardwareAcceleration,
    false,
  );
  const fixtureBot = await page.evaluate(async () =>
    (
      await fetch('/api/bots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Settings fixture',
          purpose: 'Synthetic spelling and navigation check',
          role: 'No model execution',
          capabilities: [],
        }),
      })
    ).json(),
  );
  await page.reload();
  assert.equal(await page.locator('html').getAttribute('data-accent'), 'black');
  assert.equal(await page.locator('html').getAttribute('lang'), 'fr');
  await page.getByRole('button', { name: 'Open Settings fixture', exact: true }).click();
  assert.equal(
    await page.getByLabel('Message', { exact: true }).getAttribute('spellcheck'),
    'false',
  );
  await settings();
  await Promise.all([saved(), page.getByLabel('Theme', { exact: true }).selectOption('dark')]);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await settings();
  const settingsGeometry = await page.locator('#dialog').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      navWidth: el.querySelector('.settings-navigation').getBoundingClientRect().width,
    };
  });
  assert.equal(settingsGeometry.width, 900);
  assert.equal(settingsGeometry.navWidth, 198);
  await page.screenshot({ path: join(out, 'settings-general-final.png') });
  for (const section of ['Computer', 'Permissions', 'Vault', 'Usage & Billing', 'Updates']) {
    await page.getByRole('tab', { name: section, exact: true }).click();
    await page.screenshot({
      path: join(
        out,
        `settings-${section.toLowerCase().replaceAll(' ', '-').replace('&', 'and')}.png`,
      ),
    });
  }
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await Promise.all([
    saved(),
    page.getByLabel('Check Spelling While Typing', { exact: true }).check(),
  ]);
  await Promise.all([saved(), page.getByLabel('Theme', { exact: true }).selectOption('system')]);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: join(out, 'settings-general-comparison.png') });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 800, height: 760 }),
  );
  await page.waitForFunction(() => innerWidth === 800);
  assert.equal(
    await page.locator('#dialog').evaluate((el) => el.scrollWidth <= el.clientWidth),
    true,
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1040, height: 760 }),
  );
  await page.waitForFunction(() => innerWidth === 1040);
  const state = await page.evaluate(async () => ({
    settings: (await (await fetch('/api/state')).json()).settings,
    native: await window.workshopDesktop.info(),
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
  }));
  assert.deepEqual(errors, []);
  writeFileSync(
    join(out, 'result.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        sourceCandidate: true,
        installed: false,
        root,
        scope:
          'Native source with controlled system-theme media; real local save, no provider or Docker claim',
        state,
        settingsGeometry,
        fixtureBotId: fixtureBot.id,
        errors,
        checks: [
          'stored preference distinct from effective theme',
          'theme, spelling, accent and language apply when changed',
          'Light/Dark apply immediately',
          'Follow System responds to media changes',
          'page reload preserves preference',
          'explicit Dark survives light system media',
          'six settings sections keep their values; an invalid feedback page stays on General',
          'settings keyboard navigation and 900px dialog / 198px section navigation',
          'stored spellcheck false applies to the actual composer after reload',
          'settings engine status exposes transport failure and real retry with observation time',
          'required field validation reveals its section; 800px native settings has no horizontal overflow',
        ],
      },
      null,
      2,
    ),
  );
  console.log(out);
  if (process.argv.includes('--hold')) {
    console.log(
      'Source settings candidate retained for computer-use verification. Quit this isolated candidate with Ctrl+Q.',
    );
    await app.waitForEvent('close', { timeout: 0 });
  }
} catch (error) {
  await page.screenshot({ path: join(out, 'failure.png') });
  throw error;
} finally {
  await app.close();
}
