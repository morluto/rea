import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { startHost, stopHost } from '../test/support.mjs';
const host = await startHost(mkdtempSync(join(tmpdir(), 'orbit-plugin-signin-ui-')), 14358);
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({
  ...(existsSync(edge) ? { executablePath: edge } : {}),
  headless: true,
});
const out = resolve('.local/verification');
mkdirSync(out, { recursive: true });
const errors = [];
let connected = false,
  flowId;
let discoveries = 0;
const remote = http.createServer(async (request, response) => {
  if (request.url === '/token' && request.headers.authorization !== 'Bearer fixture-ui-token') {
    response.writeHead(401);
    return response.end();
  }
  if (request.method !== 'POST') {
    response.writeHead(405);
    return response.end();
  }
  const server = new McpServer({ name: 'synthetic-plugin-ui', version: '1.0.0' });
  server.registerTool(
    'fixture_read',
    { description: 'Synthetic read', inputSchema: {} },
    async () => ({
      content: [{ type: 'text', text: 'Synthetic fixture only' }],
    }),
  );
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  discoveries++;
  response.on('close', () => {
    void transport.close();
    void server.close();
  });
  await transport.handleRequest(request, response);
});
try {
  await new Promise((resolve) => remote.listen(0, '127.0.0.1', resolve));
  const context = await browser.newContext();
  await context.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<h1>Synthetic consent fixture: no Google request sent</h1>',
    }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(host.base);
  await page.getByLabel('Account name').fill('plugin-ui-fixture');
  await page.getByLabel('Password (at least 12 characters)').fill('Synthetic-plugin-ui-2026');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('button', { name: 'Create your first Bot' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Plugin fixture');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await page.locator('.tools-disclosure > summary').evaluate((node) => node.click());
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await page
    .locator('[data-plugin="gmail"]')
    .getByRole('button', { name: 'Connect Google' })
    .click();
  await page.getByRole('heading', { name: 'Set up Google sign-in once' }).waitFor();
  await page.getByLabel('Import OAuth client JSON (private)').setInputFiles({
    name: 'synthetic-client.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        installed: { client_id: 'fixture-ui-client', client_secret: 'fixture-ui-private' },
      }),
    ),
  });
  await page.waitForFunction(
    () => document.querySelector('#f-clientId').value === 'fixture-ui-client',
  );
  await page.getByRole('button', { name: 'Save & sign in with Google' }).click();
  await page.locator('#pluginoauthwatch').waitFor();
  await page.getByText('Finish sign-in in your browser.', { exact: false }).waitFor();
  const plugins = await page.request
    .get(host.base + '/api/plugins')
    .then((response) => response.json());
  const gmail = plugins.find((value) => value.id === 'gmail');
  assert.equal(gmail.signInReady, true);
  assert.equal(gmail.installed.connection.botIds.length, 1);
  assert.equal(gmail.installed.connection.oauth.state, 'auth_required');
  const before = await page.request
    .get(host.base + '/api/connections')
    .then((response) => response.json());
  assert.ok(!JSON.stringify(before).includes('fixture-ui-private'));
  await page.route('**/api/oauth/flows/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    flowId = new URL(route.request().url()).pathname.split('/').at(-1);
    const response = await route.fetch(),
      value = await response.json();
    await route.fulfill({
      response,
      json: { ...value, ...(connected ? { state: 'connected' } : {}) },
    });
  });
  await page.route('**/api/plugins', async (route) => {
    const response = await route.fetch(),
      values = await response.json();
    if (connected) {
      const fixture = values.find((value) => value.id === 'gmail').installed.connection;
      fixture.accountLabel = 'fixture@example.invalid';
      fixture.oauth.state = 'authenticated';
      fixture.discoveredTools = [{ name: 'fixture.read', policy: 'ask' }];
    }
    await route.fulfill({ response, json: values });
  });
  connected = true;
  await page.getByText('Connected as fixture@example.invalid.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Review Bots & tool access' }).waitFor();
  await page.screenshot({ path: join(out, 'plugin-signin-connected-fixture.png') });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  connected = false;
  await page.unroute('**/api/plugins');
  await page.unroute('**/api/oauth/flows/*');
  await page.evaluate(() => {
    window.open = () => null;
  });
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await page
    .locator('[data-plugin="google-calendar"]')
    .getByRole('button', { name: 'Connect Google' })
    .click();
  await page.locator('#pluginoauthwatch').waitFor();
  assert.equal(await page.getByLabel('OAuth app client ID').count(), 0);
  assert.ok(
    (await page.getByRole('link', { name: 'Open Google sign-in' }).getAttribute('href')).startsWith(
      'https://accounts.google.com/',
    ),
  );
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/oauth/flows/') && response.request().method() === 'GET',
  );
  const flow = await (await responsePromise).json();
  assert.equal(flow.state, 'pending');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(
    async (id) =>
      (await fetch('/api/oauth/flows/' + id).then((response) => response.json())).state ===
      'cancelled',
    flow.id,
  );
  for (const [pluginId, auth] of [
    ['slack', 'token'],
    ['google-drive', 'none'],
  ]) {
    await page.getByRole('button', { name: 'Plugins', exact: true }).click();
    await page
      .locator('[data-plugin="' + pluginId + '"]')
      .getByRole('button', { name: 'Connect', exact: true })
      .click();
    await page
      .getByLabel('MCP server URL')
      .fill('http://127.0.0.1:' + remote.address().port + '/' + auth);
    await page.getByLabel('Authentication', { exact: true }).selectOption(auth);
    if (auth === 'token')
      await page.getByLabel('API key / token (private)', { exact: true }).fill('fixture-ui-token');
    await page.getByRole('button', { name: 'Save & connect', exact: true }).click();
    await page.getByText('1 tools available with approval.', { exact: false }).waitFor();
    const installed = (
      await page.request.get(host.base + '/api/plugins').then((response) => response.json())
    ).find((value) => value.id === pluginId);
    assert.equal(installed.connectionReady, true);
    assert.equal(installed.installed.connection.botIds.length, 1);
    assert.ok(!JSON.stringify(installed).includes('fixture-ui-token'));
    await page.getByRole('button', { name: 'Done', exact: true }).click();
  }
  assert.ok(discoveries >= 2, 'Save & connect performs real local MCP discovery');
  const discoveriesBeforeWatch = discoveries;
  let watchConnectionId;
  await page.route('**/api/plugins/google-drive/connect', async (route) => {
    const response = await route.fetch(),
      value = await response.json();
    watchConnectionId = value.plugin.installed.connectionId;
    await route.fulfill({
      response,
      json: {
        ...value,
        authorization: {
          id: 'synthetic-mcp-watch',
          type: 'mcp',
          authorizeUrl: 'http://127.0.0.1:' + remote.address().port + '/authorize',
        },
      },
    });
  });
  await page.route('**/api/mcp/oauth/flows/synthetic-mcp-watch', (route) =>
    route.fulfill({
      json: { state: 'completed', connectionId: watchConnectionId },
    }),
  );
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await page
    .locator('[data-plugin="google-drive"]')
    .getByRole('button', { name: 'Options', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save & connect', exact: true }).click();
  await page.getByText('1 tools available with approval.', { exact: false }).waitFor();
  assert.ok(
    discoveries >= discoveriesBeforeWatch + 4,
    'MCP completion watcher automatically discovers tools after initial Connect discovery',
  );
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.unroute('**/api/plugins/google-drive/connect');
  await page.unroute('**/api/mcp/oauth/flows/synthetic-mcp-watch');
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await page
    .locator('[data-plugin="docs-canvas"]')
    .getByRole('button', { name: 'Enable', exact: true })
    .click();
  await page.getByText('Skill enabled for the selected Bot.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(errors.length, 0, errors.join('\n'));
  const result = {
    at: new Date().toISOString(),
    errors,
    checks: [
      'one-time client JSON import',
      'save automatically advances to sign-in without modal-close race',
      'current Bot scope only',
      'automatic connected UI from explicit synthetic status fixture',
      'Calendar reuses saved app without repeated credential form',
      'popup-blocker sign-in link fallback',
      'cancel expires host flow',
      'API-key and no-auth custom MCP save automatically discovers real local tools',
      'API key not returned by public plugin projection',
      'synthetic MCP completion watcher triggers real local tool discovery',
      'bundled skill enables in one click',
    ],
    realGoogleAuthorization: false,
  };
  writeFileSync(join(out, 'plugin-signin-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await new Promise((resolve) => remote.close(resolve));
  await stopHost(host);
}
