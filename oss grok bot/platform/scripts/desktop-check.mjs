import { openSettings } from '../test/ui.mjs';
import { _electron as electron } from 'playwright';
import { syntheticProvider, startHost, stopHost, waitFor } from '../test/support.mjs';
import selfsigned from 'selfsigned';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { version } from '../packages/host/src/version.mjs';
const profile = mkdtempSync(join(tmpdir(), 'bot-workshop-electron-'));
const data = join(profile, 'workspace');
const out = resolve('.local/verification');
mkdirSync(out, { recursive: true });
const provider = await syntheticProvider();
let app, base, primary;
const errors = [];
const started = Date.now();
const env = Object.fromEntries(
  [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'TEMP',
    'TMP',
  ]
    .filter((k) => process.env[k])
    .map((k) => [k, process.env[k]]),
);
Object.assign(env, {
  WORKSHOP_DESKTOP_PROFILE: profile,
  WORKSHOP_DESKTOP_DATA: data,
  WORKSHOP_DESKTOP_PORT: '0',
});
async function launch() {
  app = await electron.launch({
    ...(process.env.WORKSHOP_PACKAGED_EXE
      ? {
          executablePath: process.env.WORKSHOP_PACKAGED_EXE,
          args: ['-r', resolve('node_modules/playwright-core/lib/server/electron/loader.js')],
        }
      : { args: ['apps/desktop/main.mjs'] }),
    cwd: resolve('.'),
    env,
    timeout: 30000,
  });
  const page = await app.firstWindow({ timeout: 15000 });
  page.setDefaultTimeout(15000);
  return page;
}
async function quit() {
  const exited = app.waitForEvent('close');
  await app.evaluate(({ app }) => app.quit());
  await exited;
  app = null;
}
try {
  let page = await launch();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('button', { name: 'Use this computer as the primary host' }).click();
  await Promise.race([
    page.getByRole('heading', { name: 'Create your workspace' }).waitFor({ timeout: 40000 }),
    page
      .locator('#error')
      .filter({ hasText: 'Error' })
      .waitFor({ timeout: 40000 })
      .then(async () => {
        throw Error(await page.locator('#error').innerText());
      }),
  ]);
  base = new URL(page.url()).origin;
  const safety = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
    bridge: typeof window.workshopDesktop.info,
  }));
  assert.deepEqual(safety, { require: 'undefined', process: 'undefined', bridge: 'function' });
  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
    };
  });
  assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  await page.getByLabel('Account name').fill('synthetic-native');
  await page.getByLabel('Password (at least 12 characters)').fill('Synthetic-native-only-2026');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await openSettings(page);
  await page.getByLabel('Show advanced controls', { exact: true }).check();
  await page.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).click();
  await page.getByLabel('Model', { exact: true }).selectOption('gpt-6.1-sol');
  await page.screenshot({ path: join(out, 'native-chatgpt-model.png') });
  await page.route('**/api/state', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.continue();
  });
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  const signIn = page.getByRole('link', { name: /Open OpenAI sign-in/ });
  await signIn.waitFor();
  assert.equal(new URL(await signIn.getAttribute('href')).origin, 'https://auth.openai.com');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await page.unroute('**/api/state');
  await openSettings(page);
  await page.getByRole('button', { name: 'Configure a model' }).click();
  await page.getByLabel('Configuration name').fill('Synthetic native provider');
  await page.getByLabel('Base URL').fill(`http://127.0.0.1:${provider.port}/v1`);
  await page.getByLabel('Exact model ID').fill('synthetic-workflow');
  await page.getByRole('button', { name: 'Save configuration' }).click();
  await page.getByRole('button', { name: 'Create your first Bot' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Native workflow');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'Choose a model', exact: true }).click();
  await page
    .getByLabel('Model configuration')
    .selectOption({ label: 'Synthetic native provider · synthetic-workflow (unverified)' });
  await page.getByRole('button', { name: 'Publish revision', exact: true }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await page
    .getByLabel('Message', { exact: true })
    .fill('WORKFLOW_TEST: save the scoped preference and publish the test bytes.');
  await page.getByRole('button', { name: 'Send ↑' }).click();
  await page
    .getByText(
      'Synthetic test completed. The host tool receipts establish the memory and artifact writes.',
      { exact: false },
    )
    .waitFor({ timeout: 25000 });
  await page.screenshot({ path: join(out, 'native-workflow.png') });
  const notificationStatus = await page.evaluate(() => window.workshopDesktop.notificationStatus());
  assert.equal(notificationStatus.enabled, false);
  assert.equal(
    await page.evaluate(() =>
      window.workshopDesktop.notify('Disabled test', 'Must not submit', 'disabled-test'),
    ),
    false,
  );
  await page.locator('.tools-disclosure > summary').evaluate((node) => node.click());
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await page.getByRole('button', { name: 'Enable desktop alerts', exact: true }).click();
  assert.equal(
    (await page.evaluate(() => window.workshopDesktop.notificationStatus())).enabled,
    true,
  );
  await page.getByRole('button', { name: 'Remind me once', exact: true }).click();
  await page
    .getByLabel('Reminder message', { exact: true })
    .fill('Synthetic one-minute assignment reminder');
  await page.getByLabel('Remind me after (seconds)', { exact: true }).fill('60');
  const reminderCreated = page.waitForResponse(
    (response) => response.url().endsWith('/reminders') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Schedule once', exact: true }).click();
  const reminder = await (await reminderCreated).json();
  assert.equal(reminder.state, 'scheduled');
  assert.ok(reminder.conversationId);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await waitFor(
    async () => {
      const items = await page.request
        .get(base + '/api/notifications')
        .then((response) => response.json());
      return items.some((notice) => notice.id === reminder.notificationId);
    },
    'one-minute reminder while minimized',
    75000,
  );
  const delivered = await page.request
    .get(base + '/api/notifications')
    .then((response) => response.json());
  assert.equal(delivered.filter((notice) => notice.kind === 'reminder').length, 1);
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.restore();
    win.show();
  });
  await page.getByText('Synthetic one-minute assignment reminder', { exact: true }).waitFor();
  await page.screenshot({ path: join(out, 'native-one-minute-reminder.png') });
  if (notificationStatus.supported) {
    await page.waitForFunction(
      () =>
        Object.keys(localStorage).some(
          (key) =>
            key.startsWith('orbit-alerts-submitted-') &&
            JSON.parse(localStorage.getItem(key)).length > 0,
        ),
      null,
      { timeout: 12000 },
    );
  }
  if (process.env.WORKSHOP_GAME_ARTIFACT) {
    const state = await page.request.get(base + '/api/state').then((response) => response.json());
    const bot = state.bots.find((bot) => bot.name === 'Native workflow');
    const published = await page.request.post(base + '/api/bots/' + bot.id + '/artifacts', {
      headers: { origin: base },
      data: {
        name: 'native-voxel-check.html',
        mediaType: 'text/html',
        content: readFileSync(process.env.WORKSHOP_GAME_ARTIFACT, 'utf8'),
      },
    });
    assert.equal(published.status(), 201);
    if ((await page.locator('#botdetails').getAttribute('aria-expanded')) !== 'true')
      await page.getByRole('button', { name: 'View conversation details' }).click();
    await page.getByRole('tab', { name: 'Library', exact: true }).click();
    await page.getByRole('button', { name: 'native-voxel-check.html', exact: true }).click();
    await page.getByRole('button', { name: 'Play with CDN & mouse', exact: true }).click();
    const game = page.frameLocator('iframe[title="Sandboxed artifact"]');
    await game.locator('canvas').waitFor({ timeout: 45000 });
    await game.getByRole('button', { name: 'Play', exact: true }).click();
    await game.locator('#start').waitFor({ state: 'hidden' });
    assert.equal(
      await game.locator('canvas').evaluate((canvas) => document.pointerLockElement === canvas),
      true,
    );
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Fullscreen game', exact: true }).click();
    await page.waitForFunction(() => !!document.fullscreenElement);
    assert.equal(await page.evaluate(() => !!document.fullscreenElement), true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.fullscreenElement);
    await page.locator('#dialog').waitFor({ state: 'visible' });
    await page.screenshot({ path: join(out, 'native-artifact-game.png') });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  }
  const infrastructure = await page.request.get(base + '/api/docker').then((r) => r.json());
  if (!infrastructure.available) {
    // No engine work is submitted: exercise packaged ASAR recipe reads and
    // durable failure reporting against the observed unavailable engine.
    const setup = await page.request.post(base + '/api/docker/prepare', {
      headers: { origin: base },
      data: {},
    });
    assert.equal(setup.status(), 202);
    await page.waitForFunction(async () => {
      const s = await fetch('/api/docker').then((r) => r.json());
      return s.build?.state === 'failed';
    });
    await page.getByRole('button', { name: 'Computer', exact: true }).click();
    await page.getByRole('heading', { name: 'Linux engine unavailable' }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Prepare Linux image', exact: true }).isDisabled(),
      true,
    );
    await page.screenshot({ path: join(out, 'native-computer-setup.png') });
    await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  }
  if (!(await page.getByRole('button', { name: 'Backups & app', exact: true }).isVisible()))
    await page.locator('.tools-disclosure > summary').evaluate((node) => node.click());
  await page.getByRole('button', { name: 'Backups & app', exact: true }).click();
  await page.getByRole('heading', { name: 'Desktop app', exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Install web app', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByText('This computer is primary', { exact: true }).waitFor();
  const hostInfo = await page.evaluate(() => window.workshopDesktop.info());
  assert.equal(hostInfo.version, version);
  assert.equal(hostInfo.mode, 'primary');
  assert.equal(hostInfo.background, true);
  // Closing the window preserves the host; explicit Quit drains and releases it.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal((await fetch(base + '/api/health').then((r) => r.json())).status, 'running');
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    false,
  );
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await quit();
  await assert.rejects(fetch(base + '/api/health'));
  page = await launch();
  await page.waitForURL((url) => url.protocol === 'http:');
  base = new URL(page.url()).origin;
  const auth = await page.request.get(base + '/api/auth/status');
  const status = await auth.json();
  assert.equal(status.setup, false);
  if (!status.authenticated) {
    await page.getByLabel('Account name').fill('synthetic-native');
    await page.getByLabel('Password (at least 12 characters)').fill('Synthetic-native-only-2026');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  await page.getByText('Native workflow', { exact: true }).first().waitFor();
  await page.screenshot({ path: join(out, 'native-restarted.png') });
  await quit();
  // The other desktop mode owns no host. Its requests go back to the selected
  // primary's existing database, Pi history and scheduler over paired HTTPS.
  primary = await startHost(data, 14344);
  await primary.call('/auth/login', {
    name: 'synthetic-native',
    password: 'Synthetic-native-only-2026',
  });
  const tls = await selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], {
    algorithm: 'sha256',
    keySize: 2048,
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
    ],
  });
  const remoteURL = 'https://127.0.0.1:14345';
  await primary.call('/remote', {
    enabled: true,
    url: remoteURL,
    bind: '127.0.0.1',
    port: 14345,
    certificate: tls.cert,
    privateKey: tls.private,
  });
  const pair = (await primary.call('/remote/pair', { name: 'Synthetic remote desktop' })).body;
  env.WORKSHOP_DESKTOP_PROFILE = mkdtempSync(join(tmpdir(), 'bot-workshop-remote-desktop-'));
  page = await launch();
  // This test owns both the generated certificate and its expected fingerprint.
  // Only the app's synthetic fingerprint-confirmation dialog is answered.
  await app.evaluate(({ dialog }, fingerprint) => {
    dialog.showMessageBox = async (...args) => ({
      response: args.at(-1).detail?.includes(fingerprint) ? 1 : 0,
    });
  }, new X509Certificate(tls.cert).fingerprint256);
  await page.getByLabel('Primary host address').fill(remoteURL);
  await page.getByRole('button', { name: 'Connect to primary host' }).click();
  await page.getByLabel('This device’s name').fill('Synthetic remote desktop');
  await page.getByLabel('Pairing code').fill(pair.code);
  await page.getByRole('button', { name: 'Pair this device' }).click();
  await page.getByLabel('Account name').fill('synthetic-native');
  await page.getByLabel('Password (at least 12 characters)').fill('Synthetic-native-only-2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByText('Native workflow', { exact: true }).first().click();
  await page
    .getByLabel('Message', { exact: true })
    .fill('A synthetic prompt from the remote desktop client.');
  await page.getByRole('button', { name: 'Send ↑' }).click();
  await page
    .getByText(
      'Synthetic test completed. The host tool receipts establish the memory and artifact writes.',
      { exact: false },
    )
    .nth(1)
    .waitFor({ timeout: 20000 });
  const remoteInfo = await page.evaluate(() => window.workshopDesktop.info());
  assert.equal(remoteInfo.mode, 'remote');
  assert.equal(remoteInfo.background, false);
  assert.equal(remoteInfo.host, remoteURL);
  await page.screenshot({ path: join(out, 'native-remote-session.png') });
  await quit();
  assert.equal((await primary.call('/health')).body.status, 'running');
  page = await launch();
  await page.getByText('Native workflow', { exact: true }).first().waitFor({ timeout: 20000 });
  await quit();
  await stopHost(primary);
  primary = null;
  assert.equal(errors.length, 0, errors.join('\n'));
  const result = {
    at: new Date().toISOString(),
    packaged: !!process.env.WORKSHOP_PACKAGED_EXE,
    version: hostInfo.version,
    elapsedMs: Date.now() - started,
    requests: provider.requests.length,
    errors,
    nativeGamePlayback: !!process.env.WORKSHOP_GAME_ARTIFACT,
    profile,
    data,
    checks: [
      'isolated native renderer',
      'ChatGPT model-selection screen with real installed provider catalog',
      'actual authorization link and cancellation after delayed state refresh',
      'real Pi synthetic tool workflow',
      'one-minute reminder while minimized, original conversation and native alert submission',
      'window-close background host',
      'explicit Quit releases host',
      'durable workspace restart',
      'HTTPS fingerprint-confirmed remote pairing',
      'remote desktop requests execute on primary host',
      'saved remote connection reopens',
      'remote client Quit preserves primary host',
    ],
  };
  writeFileSync(
    join(
      out,
      process.env.WORKSHOP_PACKAGED_EXE ? 'desktop-packaged-result.json' : 'desktop-result.json',
    ),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ pageErrors: errors }));
  if (app) {
    const page = app.windows()[0];
    await page?.screenshot({ path: join(out, 'native-failure.png') }).catch(() => {});
    console.error(
      await page
        ?.locator('#error')
        .innerText()
        .catch(() => ''),
    );
  }
  throw error;
} finally {
  if (app) await quit().catch(() => app.close());
  if (primary) await stopHost(primary);
  await new Promise((r) => provider.server.close(r));
}
