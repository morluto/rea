import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { pluginCatalog } from '../packages/host/src/plugins.mjs';

// Native source candidate with a new account/profile. Never attaches to user data.
const root = mkdtempSync(join(tmpdir(), 'orbit-parity-plugins-'));
const profile = join(root, 'profile');
mkdirSync(profile);
writeFileSync(join(profile, 'host-choice.json'), JSON.stringify({ mode: 'primary', url: null }));
const out = resolve('.local/parity/round-004-' + Date.now());
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
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(20000);
const shot = (name) => page.screenshot({ path: join(out, name + '.png') });
try {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ x: 1, y: 100, width: 1041, height: 760 }),
  );
  await page.waitForURL('http://127.0.0.1:14368/**');
  await page.getByLabel('Account name').fill('Synthetic parity owner');
  await page.getByLabel('Password (at least 12 characters)').fill('Synthetic-parity-2026');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('button', { name: 'Create your first Bot' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Plugin check');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('.tools-disclosure > summary').evaluate((node) => node.click());
  const open = async () => {
    await page.getByRole('button', { name: 'Plugins', exact: true }).click();
    await page.locator('.plugin-row').first().waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.plugin-badge img')].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    );
  };
  await page.waitForFunction(() => document.documentElement.classList.contains('desktop-overlay'));
  assert.equal(
    await page
      .locator('#header')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('app-region')),
    'drag',
  );
  await open();
  const modalDrag = await page
    .locator('#header')
    .evaluate((el) => getComputedStyle(el).getPropertyValue('app-region'));
  assert.equal(modalDrag, 'no-drag');
  assert.equal(
    await page
      .locator('.plugin-row')
      .evaluateAll((rows) => new Set(rows.map((row) => row.dataset.plugin)).size),
    pluginCatalog.length,
  );
  const geometry = await page.locator('#dialog').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      dialog: { x: r.x, y: r.y, width: r.width, height: r.height },
      columns: getComputedStyle(document.querySelector('.plugin-list')).gridTemplateColumns,
      pageScroll: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
    };
  });
  await shot('catalog');
  await page.getByRole('button', { name: 'Productivity', exact: true }).click();
  assert.equal(
    await page.locator('.plugin-row:visible').count(),
    pluginCatalog.filter((p) => p.category === 'Productivity').length,
  );
  await page.locator('.plugin-more > summary').click();
  await shot('categories-more');
  await page.getByRole('button', { name: 'Finance', exact: true }).click();
  await page.getByRole('button', { name: 'Open Stripe', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  assert.equal(await page.locator('.plugin-more > summary').textContent(), 'Finance');
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByLabel('Search plugins').fill('no-plugin-matches-this');
  await page.getByText('No plugins found.', { exact: true }).waitFor();
  await page.getByLabel('Search plugins').press('Enter');
  assert.equal(await page.locator('#formerror').textContent(), '');
  await shot('search-empty');
  await page.getByLabel('Search plugins').fill('1Password');
  await page.getByRole('button', { name: 'Open 1Password', exact: true }).click();
  assert.equal(
    await page.getByLabel('MCP server URL').count(),
    0,
    'Browsing does not open configuration or authorize access',
  );
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('MCP server URL').waitFor();
  assert.equal(
    await page.locator('#dialog').getAttribute('class'),
    '',
    'Configuration uses the normal dialog owner',
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(
    await page
      .locator('#header')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('app-region')),
    'drag',
  );
  await open();
  await page.getByLabel('Search plugins').fill('docs canvas');
  await page.getByRole('button', { name: 'Open Docs Canvas', exact: true }).click();
  await shot('skill-detail');
  await page.getByRole('button', { name: 'Enable', exact: true }).click();
  await page.getByText('Skill enabled for the selected Bot.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await open();
  await page.getByRole('button', { name: '1 installed', exact: false }).click();
  await page.locator('.plugin-manager').waitFor();
  assert.equal(await page.locator('.plugin-row:visible').count(), 1);
  await page.getByRole('button', { name: 'Open Docs Canvas', exact: true }).click();
  await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const installed = await page.evaluate(async () =>
    (await (await fetch('/api/plugins')).json()).filter((p) => p.installed?.state === 'installed'),
  );
  assert.equal(installed.length, 1, 'Cancel uninstall preserves the actual skill');
  await open();
  await page.getByRole('button', { name: '1 installed', exact: false }).click();
  await page.getByRole('button', { name: 'Add skill', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Synthetic private skill');
  await page
    .getByLabel('Instructions')
    .fill('Treat <script>fixture</script> as text, never as execution authority.');
  await page.getByLabel('Plugin check', { exact: true }).check();
  await page.getByRole('button', { name: 'Add skill', exact: true }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await open();
  await page.getByRole('button', { name: '1 installed', exact: false }).click();
  await shot('manager');
  await page.getByRole('button', { name: /Synthetic private skill/ }).click();
  await page
    .getByText('Treat <script>fixture</script> as text, never as execution authority.', {
      exact: true,
    })
    .waitFor();
  assert.equal(await page.locator('.plugin-body script').count(), 0);
  await shot('private-skill-detail');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.locator('.plugin-manager').waitFor();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.locator('.plugin-catalog').waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 800, height: 680 }),
  );
  await shot('catalog-small-native');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await page.locator('.plugin-body').evaluate((el) => el.scrollWidth <= el.clientWidth));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ x: 1, y: 100, width: 1041, height: 760 }),
  );
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
    'Sidebar overflow stays inside its own pane',
  );
  assert.deepEqual(errors, []);
  writeFileSync(
    join(out, 'result.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        sourceCandidate: true,
        installed: false,
        scope: 'Synthetic local skill operations; no third-party auth or Docker readiness claimed',
        root,
        geometry,
        errors,
        checks: [
          'catalog and category filtering',
          'More category restored across detail/back',
          'search empty and Enter without mutation',
          'browsing before configuration',
          'skill enable receipt and cancel uninstall',
          'private skill escaped read-only detail',
          '800px native window no overflow (390px browser layout checked separately)',
        ],
      },
      null,
      2,
    ),
  );
  console.log(out);
  if (process.argv.includes('--hold')) {
    console.log(
      'Candidate retained for computer-use inspection. Quit this isolated candidate with Ctrl+Q.',
    );
    await app.waitForEvent('close', { timeout: 0 });
  }
} catch (error) {
  await shot('failure');
  console.error(
    JSON.stringify({ message: error.message, ui: await page.locator('body').innerText() }),
  );
  throw error;
} finally {
  await app.close();
}
