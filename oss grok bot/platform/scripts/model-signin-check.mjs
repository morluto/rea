import { openSettings } from '../test/ui.mjs';
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startHost, stopHost } from '../test/support.mjs';
const out = resolve('.local/verification');
mkdirSync(out, { recursive: true });
const host = await startHost(mkdtempSync(join(tmpdir(), 'orbit-signin-ui-')), 14353);
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({
  ...(existsSync(edge) ? { executablePath: edge } : {}),
  headless: true,
  chromiumSandbox: true,
});
const errors = [];
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(host.base);
  await page.getByLabel('Account name').fill('Synthetic sign-in check');
  await page
    .getByLabel('Password (at least 12 characters)')
    .fill('Synthetic-only-signin-check-2026');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await openSettings(page);
  await page.getByLabel('Show advanced controls', { exact: true }).check();
  await page.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).click();
  await page.getByLabel('Model', { exact: true }).selectOption('gpt-6.1-sol');
  await page.screenshot({ path: join(out, 'orbit-chatgpt-model.png') });
  await page.route('**/api/state', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.continue();
  });
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  const link = page.getByRole('link', { name: 'Open OpenAI sign-in ↗' });
  await link.waitFor();
  const authorization = new URL(await link.getAttribute('href'));
  assert.equal(authorization.origin, 'https://auth.openai.com');
  assert.equal(authorization.searchParams.get('agent_name_hint'), 'Orbit');
  await page.getByText('Finish with a callback URL', { exact: true }).click();
  await page.locator('#modelauthvalue').fill('Synthetic field contents must survive polling');
  await page.waitForTimeout(1300);
  assert.equal(
    await page.locator('#modelauthvalue').inputValue(),
    'Synthetic field contents must survive polling',
  );
  await page.screenshot({ path: join(out, 'orbit-chatgpt-signin.png') });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await openSettings(page);
  await page.getByText('ChatGPT plan · disconnected', { exact: false }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Test actual response', exact: true }).count(),
    1,
  );
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  assert.deepEqual(errors, []);
  writeFileSync(
    join(out, 'model-signin-result.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        errors,
        checks: [
          'ChatGPT model selection',
          'sign-in dialog survives delayed authoritative state refresh',
          'actual Pi authorization link',
          'private callback entry survives polling',
          'cancel/disconnect controls',
        ],
        limitations: ['No account signed in', 'No real model response'],
      },
      null,
      2,
    ),
  );
  console.log(
    'ChatGPT UI selection/authorization/cancel/disconnect checks passed; no account was signed in.',
  );
} catch (error) {
  const dialog = await page
    ?.locator('#dialog')
    .innerText()
    .catch(() => '');
  console.error(JSON.stringify({ pageErrors: errors, dialog }));
  await page?.screenshot({ path: join(out, 'model-signin-failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await stopHost(host);
}
