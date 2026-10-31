import { openSettings } from '../test/ui.mjs';
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { syntheticProvider, startHost, stopHost } from '../test/support.mjs';
import { pluginCatalog } from '../packages/host/src/plugins.mjs';
const data = mkdtempSync(join(tmpdir(), 'orbit-experience-')),
  out = resolve(process.env.WORKSHOP_VERIFICATION_OUT ?? '.local/verification');
mkdirSync(out, { recursive: true });
const provider = await syntheticProvider(),
  host = await startHost(data, 14349);
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({
  ...(existsSync(edge) ? { executablePath: edge } : {}),
  headless: true,
  chromiumSandbox: true,
});
const errors = [];
let report, page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.error(e.message);
  });
  await page.goto(host.base);
  await page.getByLabel('Account name').fill('synthetic-experience');
  await page.getByLabel('Password (at least 12 characters)').fill('Synthetic-experience-only-2026');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  const saved = () =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/settings') && response.request().method() === 'POST',
    );
  await openSettings(page);
  await Promise.all([saved(), page.getByLabel('Theme', { exact: true }).selectOption('light')]);
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await Promise.all([saved(), page.getByLabel('Theme', { exact: true }).selectOption('system')]);
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.reload();
  await page.getByRole('button', { name: 'Account menu', exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await openSettings(page);
  await page.getByRole('button', { name: 'Configure a model' }).click();
  await page.getByLabel('Configuration name').fill('Synthetic experience');
  await page.getByLabel('Base URL').fill(`http://127.0.0.1:${provider.port}/v1`);
  await page.getByLabel('Exact model ID').fill('synthetic-workflow');
  await page.getByRole('button', { name: 'Save configuration' }).click();
  await page.getByRole('button', { name: 'Create your first Bot' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Orbit test');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'Choose a model', exact: true }).click();
  await page.getByLabel('Model configuration').waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft while choosing a model.');
  await page.getByRole('button', { name: 'Send ↑' }).click();
  await page.getByLabel('Model configuration').selectOption({
    label: 'Synthetic experience · synthetic-workflow (unverified)',
  });
  await page.getByRole('button', { name: 'Publish revision', exact: true }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  assert.equal(
    await page.getByLabel('Message', { exact: true }).inputValue(),
    'Keep this draft while choosing a model.',
  );
  await page.evaluate(() => {
    window.fixtureProgress = [];
    window.fixtureSource = new EventSource('/api/events');
    window.fixtureSource.addEventListener('progress', (e) =>
      window.fixtureProgress.push({ at: Date.now(), value: JSON.parse(e.data) }),
    );
  });
  await page
    .getByLabel('Message', { exact: true })
    .fill('MILESTONE_TEST: check the fixture source and publish a report.');
  await page.getByRole('button', { name: 'Send ↑' }).click();
  await page.getByText('The synthetic report is ready.', { exact: true }).waitFor();
  await page.getByText('Synthetic source check complete.', { exact: true }).waitFor();
  const activity = page.locator('.run-activity');
  assert.equal(await activity.count(), 1);
  assert.equal(await activity.getAttribute('open'), null);
  assert.equal(
    await page
      .getByText('Routine fixture note that should stay inside activity.', { exact: true })
      .isVisible(),
    false,
  );
  await page.screenshot({ path: join(out, 'orbit-milestones.png') });
  await activity.locator(':scope > summary').click();
  await page
    .getByText('Routine fixture note that should stay inside activity.', { exact: true })
    .waitFor();
  await page.waitForTimeout(650);
  assert.ok(await activity.evaluate((el) => el.open), 'Activity remains expanded across refresh');
  assert.ok((await activity.locator('.action-result').count()) >= 3);
  await page.screenshot({ path: join(out, 'orbit-activity-expanded.png') });
  const progress = await page.evaluate(() => fixtureProgress.filter((p) => p.value.delta));
  assert.ok(progress.length >= 2);
  const first = progress.find((p) => p.value.firstTextAt);
  assert.ok(first);
  const deliveryMs = first.at - first.value.firstTextAt;
  assert.ok(deliveryMs >= 0 && deliveryMs < 900, `Live event latency ${deliveryMs}ms`);
  await page.locator('.conversation-picker > summary').click();
  await page.getByRole('button', { name: 'New conversation', exact: false }).click();
  await page
    .getByLabel('Message', { exact: true })
    .fill('CANCEL_TEST: check a full rolling cycle.');
  await page.getByRole('button', { name: 'Send ↑' }).click();
  await page.locator('#header [data-mascot-state="working"]').waitFor();
  const identity = await page.locator('#header .mascot').elementHandle();
  const motion = await page.locator('#header .mascot').evaluate((el) => {
    const travel = el.querySelector('.orb-travel'),
      roll = el.querySelector('.orb-roll'),
      shadow = el.querySelector('.orb-shadow');
    const animations = [travel, roll, shadow].map((n) => n.getAnimations()[0]);
    const durations = animations.map((a) => a.effect.getTiming().duration);
    animations.forEach((a) => a.pause());
    const frames = [0, 600, 1200, 2400, 3600, 4799, 4800, 9600].map((time) => {
      animations.forEach((a) => (a.currentTime = time));
      const t = new DOMMatrixReadOnly(getComputedStyle(travel).transform),
        r = new DOMMatrixReadOnly(getComputedStyle(roll).transform),
        s = new DOMMatrixReadOnly(getComputedStyle(shadow).transform);
      return {
        time,
        x: t.m41,
        angle: Math.atan2(r.m12, r.m11),
        shadowX: s.m41,
        radius: travel.getBoundingClientRect().width / 2,
      };
    });
    animations.forEach((a) => a.play());
    return { durations, frames };
  });
  assert.deepEqual(motion.durations, [4800, 4800, 4800]);
  for (const f of motion.frames) {
    assert.ok(
      Math.abs(f.x - f.radius * f.angle) < 0.03,
      'Rolling angular displacement matches travel',
    );
    assert.ok(Math.abs(f.x - f.shadowX) < 0.03, 'Ground shadow follows the ball');
  }
  assert.ok(Math.abs(motion.frames.at(-1).x - motion.frames[0].x) < 0.01, 'Loop endpoints match');
  assert.ok(Math.abs(motion.frames[5].x - motion.frames[6].x) < 0.01, 'No seam jump');
  await page.waitForTimeout(5000);
  assert.ok(
    await identity.evaluate((el) => el === document.querySelector('#header .mascot')),
    'Live updates preserve mascot identity',
  );
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.locator('#header [data-mascot-state="idle"]').waitFor();
  await openSettings(page);
  for (const diagnostic of await page.locator('[data-settings-advanced]').all())
    assert.equal(await diagnostic.isVisible(), false);
  assert.equal(await page.getByText(/Connection:/).isVisible(), true);
  await Promise.all([saved(), page.getByLabel('Show advanced controls').check()]);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await openSettings(page);
  for (const diagnostic of await page.locator('[data-settings-advanced]').all())
    assert.equal(await diagnostic.isVisible(), true);
  await Promise.all([saved(), page.getByLabel('Show advanced controls').uncheck()]);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await page.locator('.tools-disclosure > summary').evaluate((node) => node.click());
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.locator('.plugin-row').first().waitFor();
  assert.equal(
    await page
      .locator('.plugin-row')
      .evaluateAll((rows) => new Set(rows.map((row) => row.dataset.plugin)).size),
    pluginCatalog.length,
  );
  await page.getByLabel('Search plugins').fill('Docs Canvas');
  const row = page.locator('.plugin-row:visible');
  assert.equal(await row.count(), 1);
  await row.getByRole('button', { name: 'Open Docs Canvas', exact: true }).click();
  await page.getByRole('button', { name: 'Enable', exact: true }).click();
  await page.getByText('Skill enabled for the selected Bot.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.getByLabel('Search plugins').fill('Docs Canvas');
  await page
    .locator('.plugin-row:visible')
    .getByRole('button', { name: 'Open Docs Canvas' })
    .click();
  await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await page.getByRole('button', { name: 'Remove plugin', exact: true }).click();
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.screenshot({ path: join(out, 'orbit-plugins.png') });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'View conversation details', exact: true }).click();
  await page.getByRole('tab', { name: 'Computer', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: 'Idle policy', exact: true }).isVisible(),
    false,
  );
  await page.getByText('Computer settings', { exact: true }).click();
  await page.getByRole('button', { name: 'Idle policy', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector('#navigation').getBoundingClientRect().right <= 0.1,
  );
  await page.screenshot({ path: join(out, 'orbit-computer-mobile.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await openSettings(page);
  assert.equal(
    await page.locator('#dialog').evaluate((el) => el.scrollWidth <= el.clientWidth),
    true,
  );
  await page.getByRole('tab', { name: 'Updates', exact: true }).click();
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await page.screenshot({ path: join(out, 'orbit-settings-mobile.png') });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page
    .getByRole('button', { name: 'Close navigation', exact: true })
    .click({ position: { x: 374, y: 32 } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(
    await page
      .locator('.mascot .orb-roll')
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
    'none',
  );
  await page.evaluate(() => fixtureSource.close());
  assert.deepEqual(errors, []);
  report = {
    at: new Date().toISOString(),
    mode: 'synthetic HTTP/Pi and isolated UI',
    providerRequests: provider.requests.length,
    firstTextEventDeliveryMs: deliveryMs,
    motion,
    errors,
    checks: [
      'unassigned Bot model picker and draft preservation',
      'first reply and final output',
      'meaningful milestone visible',
      'routine activity collapsed and expandable',
      'expansion survives refresh',
      'actual streamed partial before final',
      '4.8 second coupled rolling/ground-shadow loop',
      'loop seam continuity',
      'mascot node preserved across live updates',
      `${pluginCatalog.length} plugin entries and real skill add/remove`,
      'computer controls progressively disclosed',
      'model diagnostics follow persistent Advanced preference while connection status stays visible',
      'theme save/cancel, Follow System changes and page reload',
      '390px layout and reduced motion',
    ],
  };
  writeFileSync(join(out, 'experience-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await page?.screenshot({ path: join(out, 'experience-failure.png') });
  console.error(
    JSON.stringify({
      message: error.message,
      data,
      requests: provider.requests.length,
      host: host.logs(),
      ui: await page?.locator('body').innerText(),
    }),
  );
  throw error;
} finally {
  await browser.close();
  await stopHost(host);
  await new Promise((r) => provider.server.close(r));
}
