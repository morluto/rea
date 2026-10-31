import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Store } from '../packages/host/src/store.mjs';
import { startHost, stopHost, syntheticProvider } from '../test/support.mjs';

const root = mkdtempSync(join(tmpdir(), 'orbit-parity-history-'));
const data = join(root, 'data'),
  profile = join(root, 'profile');
mkdirSync(profile);
writeFileSync(join(profile, 'host-choice.json'), JSON.stringify({ mode: 'primary', url: null }));
const out = resolve(`.local/parity/${process.env.ORBIT_PARITY_ROUND ?? 'round-006'}-${Date.now()}`);
mkdirSync(out, { recursive: true });
const provider = await syntheticProvider();
let host = await startHost(data, 14369),
  app,
  page;
const errors = [],
  checks = [];
try {
  await host.call('/auth/setup', {
    name: 'Synthetic history owner',
    password: 'Synthetic-history-2026',
  });
  const model = (
    await host.call('/models', {
      name: 'Synthetic history model',
      endpoint: `http://127.0.0.1:${provider.port}/v1`,
      model: 'synthetic-workflow',
      api: 'openai-completions',
      contextWindow: 32000,
      maxTokens: 2048,
    })
  ).body;
  const makeBot = async (name) =>
    (
      await host.call('/bots', {
        name,
        purpose: 'Synthetic history and navigation verification',
        role: 'Synthetic fixture only',
        capabilities: [],
        modelId: model.id,
      })
    ).body;
  const a = await makeBot('History fixture A'),
    b = await makeBot('Navigation fixture B');
  const extra = [];
  for (const name of [
    'Research fixture',
    'Writing fixture',
    'Planning fixture',
    'Coding fixture',
    'Library fixture',
    'A long Bot name for checking truncation in the sidebar',
  ])
    extra.push(await makeBot(name));
  for (const bot of [a, b, ...extra.slice(0, 2)])
    assert.equal(
      (await host.call(`/bots/${bot.id}/navigation`, { pinned: true, hidden: false })).status,
      200,
    );
  const hidden = await makeBot('Hidden fixture');
  assert.equal(
    (await host.call(`/bots/${hidden.id}/navigation`, { pinned: false, hidden: true })).status,
    200,
  );
  for (const [name, enabled] of [
    ['Annual fixture', true],
    ['Paused fixture', false],
  ]) {
    assert.equal(
      (
        await host.call(`/bots/${a.id}/routines`, {
          name,
          task: 'Synthetic fixture only; perform no external action',
          cron: '0 9 1 1 *',
          timezone: 'UTC',
          enabled,
        })
      ).status,
      201,
    );
  }
  const conversation = (
    await host.call(`/bots/${a.id}/conversations`, { name: '450 canonical messages' })
  ).body;
  await stopHost(host);
  host = null;
  const dir = join(data, 'canonical-fixture');
  mkdirSync(dir);
  const manager = SessionManager.create(dir, dir),
    store = new Store(data);
  for (let turn = 0; turn < 225; turn++) {
    const runId = randomUUID(),
      text = `History message ${String(turn * 2).padStart(3, '0')}`;
    manager.appendCustomEntry('workshop.request', { runId });
    manager.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
    manager.appendMessage({
      role: 'assistant',
      api: 'openai-completions',
      provider: 'workshop-endpoint',
      model: 'synthetic-workflow',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      content: [{ type: 'text', text: `History message ${String(turn * 2 + 1).padStart(3, '0')}` }],
      timestamp: Date.now(),
      stopReason: 'stop',
    });
    store.put('run', {
      id: runId,
      botId: a.id,
      conversationId: conversation.id,
      state: 'settled',
      text,
      acceptedAt: Date.now(),
      milestones: [],
    });
  }
  store.put('conversation', {
    ...store.get(conversation.id, 'conversation'),
    sessionFile: manager.getSessionFile(),
  });
  store.close();
  const env = {
    ...process.env,
    WORKSHOP_DESKTOP_DATA: data,
    WORKSHOP_DESKTOP_PROFILE: profile,
    WORKSHOP_DESKTOP_PORT: '14369',
    WORKSHOP_DOCKER_BIN: join(root, 'intentionally-absent-docker.exe'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  app = await electron.launch({ args: [resolve('apps/desktop/main.mjs')], env });
  page = await app.firstWindow();
  await page.emulateMedia({ colorScheme: 'dark' });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ x: 1, y: 100, width: 1040, height: 760 }),
  );
  await page.waitForURL('http://127.0.0.1:14369/**');
  await page.getByLabel('Account name').fill('Synthetic history owner');
  await page.getByLabel('Password (at least 12 characters)').fill('Synthetic-history-2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const choose = async (bot) => {
    await page.locator(`#botlist [data-bot="${bot.id}"]`).click();
    await page.locator('#header h1').filter({ hasText: bot.name }).waitFor();
    await page.getByLabel('Message', { exact: true }).waitFor();
  };
  const messages = page.locator(
    '#transcript .message [class$="prose"], #transcript .message .markdown-body',
  );
  const assertRange = async (from, count) => {
    await page.waitForFunction(
      (count) => document.querySelectorAll('#transcript article.message').length === count,
      count,
    );
    assert.deepEqual(
      (await messages.allTextContents()).map((text) => text.trim()),
      Array.from(
        { length: count },
        (_, index) => `History message ${String(index + from).padStart(3, '0')}`,
      ),
    );
  };
  await choose(a);
  await assertRange(250, 200);
  checks.push('latest canonical page only; older host receipts do not fabricate prompts');
  await page.locator('#transcript').evaluate((el) => (el.scrollTop = 0));
  const anchor = page.getByText('History message 250', { exact: true });
  const before = await anchor.boundingBox();
  await page.getByRole('button', { name: 'Load earlier messages' }).click();
  await assertRange(50, 400);
  const after = await anchor.boundingBox();
  assert.ok(
    Math.abs(after.y - before.y) < 2,
    `Prepending preserves the visible anchor (${before.y} -> ${after.y})`,
  );
  await page.waitForResponse(
    (response) => response.url().includes('/history?') && response.request().method() === 'GET',
  );
  await assertRange(50, 400);
  checks.push('earlier page chronological order, scroll anchor, retained across periodic refresh');
  await page.locator('#transcript').evaluate((el) => (el.scrollTop = 0));
  let releasePage, pageRequested;
  const requested = new Promise((resolve) => (pageRequested = resolve));
  const blocked = new Promise((resolve) => (releasePage = resolve));
  await page.route('**/history?cursor=*', async (route) => {
    pageRequested();
    await blocked;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Load earlier messages' }).click();
  await requested;
  await choose(b);
  await page.getByLabel('Message', { exact: true }).fill('B submitted request');
  releasePage();
  await page.unrouteAll({ behavior: 'wait' });
  assert.equal(await page.locator('#transcript article.message').count(), 0);
  checks.push('late earlier-page response cannot cross Bot selection');
  let releaseCreate, createRequested;
  const creation = new Promise((resolve) => (createRequested = resolve));
  const blockedCreation = new Promise((resolve) => (releaseCreate = resolve));
  await page.route(`**/api/bots/${b.id}/conversations`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    createRequested();
    await blockedCreation;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Send ↑' }).click();
  await creation;
  await choose(a);
  await page.getByLabel('Message', { exact: true }).fill('A draft survives B admission');
  const bAdmission = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/bots/${b.id}/tasks`) && response.request().method() === 'POST',
  );
  releaseCreate();
  await bAdmission;
  await page.unrouteAll({ behavior: 'wait' });
  assert.equal(
    await page.getByLabel('Message', { exact: true }).inputValue(),
    'A draft survives B admission',
  );
  assert.equal(await page.locator('#conversation').inputValue(), conversation.id);
  checks.push(
    'new conversation admission keeps captured Bot identity and preserves another Bot draft',
  );
  let releaseTask, taskRequested;
  const taskResponse = new Promise((resolve) => (taskRequested = resolve));
  const blockedTask = new Promise((resolve) => (releaseTask = resolve));
  await page.route(`**/api/bots/${a.id}/tasks`, async (route) => {
    const response = await route.fetch();
    taskRequested();
    await blockedTask;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Send ↑' }).click();
  await taskResponse;
  await page.getByLabel('Message', { exact: true }).fill('A newer draft typed during admission');
  await choose(b);
  await page.getByLabel('Message', { exact: true }).fill('B newer draft remains private to B');
  releaseTask();
  await page.unrouteAll({ behavior: 'wait' });
  await page.waitForResponse((response) => response.url().endsWith('/api/state'));
  assert.equal(
    await page.getByLabel('Message', { exact: true }).inputValue(),
    'B newer draft remains private to B',
  );
  await choose(a);
  assert.equal(
    await page.getByLabel('Message', { exact: true }).inputValue(),
    'A newer draft typed during admission',
  );
  await page.getByText('OK — synthetic endpoint response.', { exact: true }).waitFor();
  assert.equal(
    provider.requests.length,
    2,
    'Both captured destinations receive their synthetic requests',
  );
  checks.push(
    'accepted submission clears only its captured draft; newer edits and other Bot drafts survive',
  );
  const composer = await page.locator('#composer').elementHandle(),
    transcript = await page.locator('#transcript').elementHandle();
  await page.getByRole('button', { name: 'View conversation details', exact: true }).click();
  await page.getByRole('switch', { name: 'Pause Annual fixture', exact: true }).waitFor();
  await page.getByRole('switch', { name: 'Pause Annual fixture', exact: true }).click();
  await page.getByRole('switch', { name: 'Resume Annual fixture', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  await page.getByRole('button', { name: 'Add file', exact: false }).waitFor();
  await page.getByRole('tab', { name: 'Computer', exact: true }).click();
  await page.getByRole('heading', { name: 'Linux engine unavailable', exact: true }).waitFor();
  const viewer = await page.locator('#viewer').elementHandle();
  const geometry = await page.evaluate(() => {
    const rect = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    return {
      sidebar: rect('#navigation'),
      panel: rect('#botpanels'),
      chat: rect('.chat-column'),
      composer: rect('#taskform'),
      transcript: rect('#transcript'),
      fonts: {
        root: getComputedStyle(document.documentElement).fontFamily,
        message: getComputedStyle(document.querySelector('.markdown-body')).fontFamily,
      },
    };
  });
  assert.equal(geometry.sidebar.width, 280);
  assert.equal(geometry.panel.width, 320);
  assert.ok(geometry.composer.right <= geometry.panel.x, 'Composer stays in the chat column');
  assert.ok(geometry.transcript.right <= geometry.panel.x, 'Transcript stays in the chat column');
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.getByRole('button', { name: 'View conversation details', exact: true }).click();
  assert.equal(
    await page.getByRole('tab', { name: 'Computer', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  await page.getByRole('tab', { name: 'Details', exact: true }).click();
  await page.getByRole('tab', { name: 'Details', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(
    await page.getByRole('tab', { name: 'Library', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  await page.keyboard.press('ArrowRight');
  assert.equal(
    await page.getByRole('tab', { name: 'Computer', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  assert.ok(
    await viewer.evaluate((node) => node === document.querySelector('#viewer')),
    'The empty viewer container survives panel changes; no live viewer claim',
  );
  assert.ok(await composer.evaluate((node) => node === document.querySelector('#composer')));
  assert.ok(await transcript.evaluate((node) => node === document.querySelector('#transcript')));
  assert.equal(
    await page.getByLabel('Message', { exact: true }).inputValue(),
    'A newer draft typed during admission',
  );
  checks.push(
    'native 280/320 sidebar and panel geometry; transcript/composer and empty viewer DOM retained across panel changes; actual routine toggle',
  );
  await choose(b);
  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  assert.equal(
    await viewer.evaluate((node) => node.isConnected),
    false,
    'Bot change detaches the previous viewer',
  );
  await choose(a);
  assert.equal(
    await page.getByRole('tab', { name: 'Computer', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  await choose(b);
  assert.equal(
    await page.getByRole('tab', { name: 'Library', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  checks.push('per-Bot panel tab memory; previous Bot viewer detached');
  assert.equal(await page.locator('#botlist .pinned-bot').count(), 4);
  await page.getByRole('button', { name: 'Hidden Bots', exact: false }).click();
  assert.ok(
    await page.getByRole('button', { name: 'Open Hidden fixture', exact: true }).isVisible(),
  );
  assert.ok(
    await page.getByRole('button', { name: 'Open History fixture A', exact: true }).isVisible(),
    'Expanding hidden Bots keeps visible Bots',
  );
  checks.push(
    'four pinned tiles, regular rows, hidden section expands without replacing visible Bots',
  );
  await page.keyboard.press('Escape');
  await page.locator('#botpanels').waitFor({ state: 'hidden' });
  assert.equal(
    await page
      .getByRole('button', { name: 'View conversation details', exact: true })
      .getAttribute('aria-expanded'),
    'false',
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ x: 1, y: 100, width: 800, height: 760 }),
  );
  await page.getByRole('button', { name: 'View conversation details', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ x: 1, y: 100, width: 1040, height: 760 }),
  );
  checks.push(
    'keyboard tab arrows, Escape and aria state; 800px native panel no horizontal overflow',
  );
  await choose(a);
  const selectedConversation = await page.locator('#conversation').inputValue();
  await page.locator(`#botlist [data-bot="${b.id}"]`).click({ button: 'right' });
  await page.getByLabel('Name', { exact: true }).fill('Navigation fixture B revised');
  await page.getByRole('button', { name: 'Publish revision', exact: true }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#header h1').textContent(), a.name);
  assert.equal(await page.locator('#conversation').inputValue(), selectedConversation);
  assert.equal(
    await page.getByLabel('Message', { exact: true }).inputValue(),
    'A newer draft typed during admission',
  );
  checks.push('editing another Bot preserves the current Bot, conversation and draft');
  const canonicalFile = manager.getSessionFile(),
    originalBytes = readFileSync(canonicalFile);
  const damagedBytes = Buffer.concat([originalBytes, Buffer.from('{"type":')]);
  try {
    writeFileSync(canonicalFile, damagedBytes);
    const warning = page.locator('#transcript .history-notice');
    await warning.waitFor();
    assert.match(await warning.textContent(), /unreadable/);
    const bounds = await warning.boundingBox(),
      transcriptBounds = await page.locator('#transcript').boundingBox();
    assert.ok(
      bounds.y >= transcriptBounds.y && bounds.y < transcriptBounds.y + transcriptBounds.height,
      'Integrity warning stays visible at the current scroll position',
    );
    assert.deepEqual(
      readFileSync(canonicalFile),
      damagedBytes,
      'The UI read does not repair its source',
    );
    await page.screenshot({ path: join(out, 'partial-history-warning.png') });
  } finally {
    writeFileSync(canonicalFile, originalBytes);
  }
  await page.locator('#transcript .history-notice').waitFor({ state: 'hidden' });
  checks.push(
    'real partial canonical file: readable messages, visible integrity warning, byte-preserving reads and recovery after fixture restoration',
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(out, 'history-native.png') });
  writeFileSync(
    join(out, 'result.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        root,
        sourceCandidate: true,
        installed: false,
        syntheticProvider: true,
        geometry,
        native: await page.evaluate(() => window.workshopDesktop.info()),
        checks,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(out);
  if (process.argv.includes('--hold')) {
    console.log(
      'Isolated history candidate retained for computer-use verification. Quit with Ctrl+Q.',
    );
    await app.waitForEvent('close', { timeout: 0 });
  }
} catch (error) {
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (host) await stopHost(host);
  if (app) await app.close();
  await new Promise((resolve) => provider.server.close(resolve));
}
