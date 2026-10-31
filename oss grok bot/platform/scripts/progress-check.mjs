import { chromium, _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startHost, stopHost, syntheticProvider, waitFor } from '../test/support.mjs';
import { providerPreset } from '../packages/host/src/provider-presets.mjs';
import { version } from '../packages/host/src/version.mjs';
const root = mkdtempSync(join(tmpdir(), 'orbit-progress-ui-')),
  projectRoot = join(root, 'orbit');
mkdirSync(projectRoot);
let desktop;
async function packagedHost() {
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
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  );
  Object.assign(env, {
    WORKSHOP_DESKTOP_PROFILE: join(root, 'profile'),
    WORKSHOP_DESKTOP_DATA: join(root, 'data'),
    WORKSHOP_DESKTOP_PORT: '14361',
  });
  desktop = await electron.launch({
    executablePath: process.env.WORKSHOP_PACKAGED_EXE,
    args: ['-r', resolve('node_modules/playwright-core/lib/server/electron/loader.js')],
    cwd: resolve('.'),
    env,
    timeout: 30000,
  });
  const window = await desktop.firstWindow();
  await window.getByRole('button', { name: 'Use this computer as the primary host' }).click();
  await window.getByRole('heading', { name: 'Create your workspace' }).waitFor({ timeout: 40000 });
  const base = new URL(window.url()).origin;
  const health = await fetch(base + '/api/health').then((response) => response.json());
  assert.equal(health.version, version);
  let cookie = '';
  return {
    base,
    cookie: () => cookie,
    async call(route, value) {
      const response = await fetch(base + '/api' + route, {
        method: value === undefined ? 'GET' : 'POST',
        headers: {
          origin: base,
          cookie,
          ...(value === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: value === undefined ? undefined : JSON.stringify(value),
      });
      if (response.headers.get('set-cookie'))
        cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, body: await response.json() };
    },
  };
}
const provider = await syntheticProvider(),
  host = process.env.WORKSHOP_PACKAGED_EXE
    ? await packagedHost()
    : await startHost(join(root, 'data'), 14361);
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = desktop
  ? null
  : await chromium.launch({
      ...(existsSync(edge) ? { executablePath: edge } : {}),
      headless: true,
    });
const out = resolve('.local/verification');
mkdirSync(out, { recursive: true });
const errors = [];
let page;
try {
  await host.call('/auth/setup', {
    name: 'Progress UI fixture',
    password: 'Synthetic-progress-only-2026',
  });
  const model = (
    await host.call('/models', {
      name: 'Synthetic progress model',
      endpoint: 'http://127.0.0.1:' + provider.port + '/v1',
      model: 'synthetic-workflow',
      api: 'openai-completions',
    })
  ).body;
  const bot = (
    await host.call('/bots', {
      name: 'Progress fixture',
      purpose: 'Verify independent product workflows',
      role: 'Synthetic only',
      modelId: model.id,
      capabilities: ['memory', 'library', 'routines', 'extensions', 'coding'],
    })
  ).body;
  const conversation = (
    await host.call('/bots/' + bot.id + '/conversations', { name: 'Progress verification' })
  ).body;
  const config = await host.call('/coding/config', {
    enabled: true,
    executable: process.execPath,
    entrypoint: resolve('test/fixtures/coding-cli.mjs'),
    projectRoot,
    baseRef: 'main',
  });
  assert.equal(config.status, 200);
  const created = (
    await host.call('/connections', {
      name: 'Synthetic rules connection',
      kind: 'http',
      endpoint: host.base,
      botIds: [bot.id],
      tools: providerPreset('google', 'mail').tools,
    })
  ).body;
  await host.call('/connections/' + created.id + '/discover', {});
  const context = desktop
    ? desktop.context()
    : await browser.newContext({ viewport: { width: 1200, height: 1000 } });
  await context.addCookies([
    { name: 'workshop', value: host.cookie().slice('workshop='.length), url: host.base },
  ]);
  page = desktop ? await desktop.firstWindow() : await context.newPage();
  await page.setViewportSize({ width: 1200, height: 1000 });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(host.base);
  await page.getByRole('button', { name: 'Open Progress fixture', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).waitFor();
  const tool = async (name) => {
    if (!(await page.getByRole('button', { name, exact: true }).isVisible()))
      await page.locator('.tools-disclosure > summary').evaluate((node) => node.click());
    await page.getByRole('button', { name, exact: true }).click();
  };
  await tool('Taught tasks');
  await page.locator('#dialog').getByRole('button', { name: 'Teach a task', exact: true }).click();
  await page.getByLabel('Task name', { exact: true }).fill('Synthetic checklist');
  await page
    .getByLabel('When should this be used?', { exact: true })
    .fill('When preparing synthetic reports');
  await page
    .getByLabel('Steps, checks and expected output', { exact: true })
    .fill('State what was checked and what remains unknown.');
  await page.getByRole('button', { name: 'Save taught task', exact: true }).click();
  await page.getByRole('heading', { name: 'Synthetic checklist', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await page.getByLabel('Input for this run', { exact: true }).fill('Use only synthetic data.');
  await page.getByRole('button', { name: 'Run taught task', exact: true }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await waitFor(async () =>
    (await host.call('/bots/' + bot.id + '/overview')).body.runs.some(
      (run) => run.state === 'settled',
    ),
  );
  await host.call('/bots/' + bot.id + '/artifacts', {
    name: 'Search fixture.txt',
    mediaType: 'text/plain',
    content: 'The exact search phrase is lunar-checklist.',
  });
  await host.call('/bots/' + bot.id + '/artifacts', {
    name: 'Unsearched fixture.pdf',
    mediaType: 'application/pdf',
    content: 'Synthetic binary fixture; not a real PDF',
  });
  await tool('Search library');
  await page.getByLabel('Search phrase', { exact: true }).fill('lunar-checklist');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('heading', { name: 'Search fixture.txt', exact: true }).waitFor();
  await page.getByText('Not searched: Unsearched fixture.pdf', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await tool('Personal vault');
  await page.getByRole('button', { name: 'Add login', exact: true }).click();
  await page.getByLabel('Label', { exact: true }).fill('Synthetic login');
  await page.getByLabel('Website origin', { exact: true }).fill('https://example.invalid/account');
  await page.getByLabel('Username', { exact: true }).fill('synthetic-user');
  await page.getByLabel('Password (private)', { exact: true }).fill('Synthetic-vault-password');
  await page.getByRole('button', { name: 'Save privately', exact: true }).click();
  await page.getByRole('heading', { name: 'Synthetic login', exact: true }).waitFor();
  let reveals = 0;
  page.on('request', (request) => {
    if (request.url().includes('/vault/') && request.url().endsWith('/reveal')) reveals++;
  });
  await page.getByRole('button', { name: 'Edit metadata', exact: true }).click();
  await page.getByLabel('Label', { exact: true }).fill('Renamed synthetic login');
  await page.getByRole('button', { name: 'Save label', exact: true }).click();
  await page.getByRole('heading', { name: 'Renamed synthetic login', exact: true }).waitFor();
  assert.equal(reveals, 0, 'label editing must not retrieve secret payloads');
  assert.ok(!JSON.stringify((await host.call('/vault')).body).includes('Synthetic-vault-password'));
  await page.getByRole('button', { name: 'Reveal privately', exact: true }).click();
  await page.getByRole('button', { name: 'Reveal to me', exact: true }).click();
  assert.equal(
    await page.getByLabel('Password (private)', { exact: true }).inputValue(),
    'Synthetic-vault-password',
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.locator('input[type=password]').count(), 0);
  await tool('Custom action rules');
  await page.getByRole('button', { name: 'Add rule', exact: true }).click();
  await page
    .getByLabel('Rule description', { exact: true })
    .fill('Ask before archiving fixture mail');
  await page.getByLabel('Exact operation', { exact: true }).selectOption('mail.archive');
  await page.getByLabel('Behavior', { exact: true }).selectOption('ask');
  await page.getByLabel('Bot scope', { exact: true }).selectOption(bot.id);
  await page.getByRole('button', { name: 'Save rule', exact: true }).click();
  await page.getByText('Ask before archiving fixture mail', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await tool('T3 coding');
  await page.getByRole('button', { name: 'New coding task', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill('Synthetic coding return');
  await page
    .getByLabel('Coding objective and acceptance checks', { exact: true })
    .fill('Return the synthetic fixture result.');
  await page.getByRole('button', { name: 'Hand off to T3', exact: true }).click();
  await page.getByRole('heading', { name: 'T3 coding', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page
    .locator('#transcript')
    .getByText('Synthetic coding result.', { exact: true })
    .waitFor({ timeout: 25000 });
  assert.equal(
    (await host.call('/bots/' + bot.id + '/overview')).body.codingTasks[0].conversationId,
    conversation.id,
  );
  assert.equal(
    (await host.call('/notifications')).body.filter((notice) => notice.kind === 'coding').length,
    1,
  );
  await page.screenshot({ path: join(out, 'orbit-progress-chat.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  const result = {
    at: new Date().toISOString(),
    packaged: !!desktop,
    version: (await host.call('/health')).body.version,
    errors,
    checks: [
      'taught task create and synthetic-model execution',
      'encrypted login save and metadata rename without reveal',
      'explicit private reveal and DOM cleanup',
      'exact-operation scoped rule save',
      'automatic T3 fixture result returned to selected conversation',
      'durable coding notification',
      'source-bearing library phrase search with explicit binary coverage',
      '390px no horizontal overflow',
    ],
    realExternalProvider: false,
    actualT3Execution: false,
  };
  writeFileSync(
    join(out, desktop ? 'progress-packaged-result.json' : 'progress-result.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(
    JSON.stringify({
      errors,
      dialog: await page
        ?.locator('#dialog')
        .innerText()
        .catch(() => ''),
    }),
  );
  await page?.screenshot({ path: join(out, 'progress-failure.png') }).catch(() => {});
  throw error;
} finally {
  if (desktop) {
    const closed = desktop.waitForEvent('close');
    await desktop.evaluate(({ app }) => app.quit());
    await closed;
    await assert.rejects(fetch(host.base + '/api/health'));
  } else {
    await browser.close();
    await stopHost(host);
  }
  await new Promise((resolve) => provider.server.close(resolve));
}
