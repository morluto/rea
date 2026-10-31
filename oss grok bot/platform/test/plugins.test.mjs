import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { Store, id } from '../packages/host/src/store.mjs';
import { Vault } from '../packages/host/src/security.mjs';
import { McpOAuth } from '../packages/host/src/mcp-oauth.mjs';
import { startHost, stopHost, syntheticProvider, waitFor } from './support.mjs';

test('plugin lifecycle and SDK MCP OAuth use PKCE, isolate secrets, dispatch actual tools and revoke locally', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-plugins-'));
  const provider = await syntheticProvider();
  let host = await startHost(root, 14348);
  const codes = new Map(),
    tokens = new Set();
  let base,
    dispatches = 0,
    pkceChecks = 0;
  let holdToken = false,
    releaseToken;
  const remote = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const json = (value, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return json({
        resource: base + '/mcp',
        authorization_servers: [base],
        scopes_supported: ['tools:read'],
      });
    if (
      url.pathname === '/.well-known/oauth-authorization-server' ||
      url.pathname === '/.well-known/openid-configuration'
    )
      return json({
        issuer: base,
        authorization_endpoint: base + '/authorize',
        token_endpoint: base + '/token',
        registration_endpoint: base + '/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['tools:read'],
      });
    if (url.pathname === '/register') {
      let text = '';
      for await (const chunk of req) text += chunk;
      return json({ ...JSON.parse(text), client_id: 'fixture-client' }, 201);
    }
    if (url.pathname === '/authorize') {
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      const code = randomUUID();
      codes.set(code, url.searchParams.get('code_challenge'));
      const redirect = new URL(url.searchParams.get('redirect_uri'));
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: redirect.href });
      return res.end();
    }
    if (url.pathname === '/token') {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = new URLSearchParams(text);
      const challenge = createHash('sha256')
        .update(body.get('code_verifier') ?? '')
        .digest('base64url');
      if (codes.get(body.get('code')) !== challenge) return json({ error: 'invalid_grant' }, 400);
      codes.delete(body.get('code'));
      pkceChecks++;
      if (holdToken) await new Promise((resolve) => (releaseToken = resolve));
      const access = 'synthetic-mcp-token-' + randomUUID();
      tokens.add(access);
      return json({
        access_token: access,
        token_type: 'Bearer',
        refresh_token: 'synthetic-refresh',
        expires_in: 3600,
        scope: 'tools:read',
      });
    }
    if (url.pathname === '/mcp') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!tokens.has(token)) {
        res.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        });
        return res.end();
      }
      if (req.method !== 'POST') {
        res.writeHead(405);
        return res.end();
      }
      const mcp = new McpServer({ name: 'synthetic-oauth-plugin', version: '1.0.0' });
      mcp.registerTool(
        'echo',
        { description: 'Synthetic transport echo', inputSchema: { text: z.string() } },
        async ({ text }) => {
          dispatches++;
          return { content: [{ type: 'text', text: text + ' ' + token }] };
        },
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      return transport.handleRequest(req, res);
    }
    json({ error: 'not_found' }, 404);
  });
  await new Promise((r) => remote.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + remote.address().port;
  t.after(async () => {
    releaseToken?.();
    if (host) await stopHost(host);
    await new Promise((r) => provider.server.close(r));
    await new Promise((r) => remote.close(r));
  });
  await host.call('/auth/setup', { name: 'plugin-owner', password: 'Synthetic-plugin-owner-2026' });
  const model = (
    await host.call('/models', {
      name: 'Synthetic plugin model',
      endpoint: `http://127.0.0.1:${provider.port}/v1`,
      model: 'synthetic-workflow',
      api: 'openai-completions',
    })
  ).body;
  const bot = (
    await host.call('/bots', {
      name: 'Plugin test',
      purpose: 'Synthetic plugin lifecycle',
      role: 'Use only the synthetic tool.',
      modelId: model.id,
      capabilities: ['extensions', 'library'],
    })
  ).body;
  const catalog = (await host.call('/plugins')).body;
  assert.equal(catalog.length, 54);
  assert.ok(catalog.every((p) => p.installed === null));
  const skill = await host.call('/plugins/docs-canvas', { botIds: [bot.id] });
  assert.equal(skill.status, 200);
  assert.equal((await host.call('/state')).body.extensions[0].state, 'enabled');
  assert.equal(
    (
      await host.call('/plugins/docs-canvas/uninstall', {
        revision: skill.body.installed.revision + 1,
      })
    ).status,
    409,
  );
  await host.call('/plugins/docs-canvas/uninstall', { revision: skill.body.installed.revision });
  const configured = await host.call('/plugins/notion', {
    endpoint: base + '/mcp',
    auth: 'oauth',
    botIds: [bot.id],
  });
  assert.equal(configured.status, 200);
  const connectionId = configured.body.installed.connectionId;
  const cancelled = (await host.call('/plugins/notion/connect', { botIds: [bot.id] })).body
    .authorization;
  assert.equal((await host.call('/mcp/oauth/flows/' + cancelled.id)).body.state, 'pending');
  assert.equal(
    (await host.call('/mcp/oauth/flows/' + cancelled.id + '/cancel', {})).body.state,
    'cancelled',
  );
  const dispatch = await host.call('/plugins/notion/connect', { botIds: [bot.id] });
  assert.equal(dispatch.body.plugin.installed.connectionId, connectionId);
  const begin = { status: dispatch.status, body: dispatch.body.authorization };
  assert.equal(begin.status, 200, JSON.stringify(begin.body));
  const authorize = await fetch(begin.body.authorizationUrl, { redirect: 'manual' });
  const callback = authorize.headers.get('location');
  assert.ok(callback);
  assert.equal((await fetch(callback, { redirect: 'manual' })).status, 302);
  assert.equal(
    (await fetch(callback, { redirect: 'manual' })).status,
    409,
    'callback cannot be replayed',
  );
  assert.equal(pkceChecks, 1);
  assert.equal((await host.call('/mcp/oauth/flows/' + begin.body.id)).body.state, 'completed');
  assert.equal((await host.call(`/connections/${connectionId}/discover`, {})).status, 200);
  let connection = (await host.call('/connections')).body.find((c) => c.id === connectionId);
  assert.equal(connection.mcpOAuth.state, 'authorized');
  assert.equal(connection.hasCredential, true);
  assert.equal(connection.mcpOAuth.tokenRef, undefined);
  await host.call(`/connections/${connectionId}`, {
    revision: connection.revision,
    enabled: true,
    botIds: [bot.id],
    policies: { echo: 'allow' },
  });
  const conversation = (
    await host.call(`/bots/${bot.id}/conversations`, { name: 'Plugin fixture' })
  ).body;
  const run = (
    await host.call(`/bots/${bot.id}/tasks`, {
      conversationId: conversation.id,
      nonce: randomUUID(),
      text: 'EXTENSION_TEST: invoke the synthetic plugin.',
    })
  ).body;
  await waitFor(async () =>
    (await host.call(`/bots/${bot.id}/overview`)).body.runs.some(
      (r) => r.id === run.id && r.state === 'settled',
    ),
  );
  assert.equal(dispatches, 1);
  const workflow = (await host.call(`/bots/${bot.id}/workflow`)).body;
  assert.ok(JSON.stringify(workflow.externalActions).includes('[redacted transport credential]'));
  assert.ok(!JSON.stringify(workflow).includes([...tokens][0]));
  holdToken = true;
  const late = (await host.call('/plugins/notion/connect', { botIds: [bot.id] })).body
    .authorization;
  const lateAuthorize = await fetch(late.authorizeUrl, { redirect: 'manual' });
  const lateCallback = fetch(lateAuthorize.headers.get('location'), { redirect: 'manual' });
  await waitFor(
    async () =>
      releaseToken && (await host.call('/mcp/oauth/flows/' + late.id)).body.state === 'exchanging',
  );
  assert.equal(
    (await host.call('/mcp/oauth/flows/' + late.id + '/cancel', {})).body.state,
    'cancelled',
  );
  releaseToken();
  assert.equal((await lateCallback).status, 409);
  assert.equal((await host.call('/mcp/oauth/flows/' + late.id)).body.state, 'cancelled');
  assert.equal(
    (await host.call('/connections')).body.find((value) => value.id === connectionId).hasCredential,
    false,
    'late token exchange cannot restore cancelled credentials',
  );
  await host.call('/plugins/notion/uninstall', { revision: configured.body.installed.revision });
  connection = (await host.call('/connections')).body.find((c) => c.id === connectionId);
  assert.equal(connection.enabled, false);
  assert.equal(connection.hasCredential, false);
  assert.deepEqual(connection.botIds, []);
  assert.equal((await host.call(`/connections/${connectionId}/authorize`, {})).status, 403);
  await stopHost(host);
  host = null;
  const store = new Store(root);
  assert.equal(store.db.prepare('SELECT count(*) n FROM secrets').get().n, 0);
  store.close();
});

test('MCP providers track refreshed credentials and reject writes after reauthorization or removal', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'orbit-mcp-revocation-')));
  try {
    const vault = new Vault(store),
      oauth = new McpOAuth(store, vault);
    const c = store.put('connection', {
      id: id(),
      ownerId: id(),
      kind: 'mcp',
      enabled: true,
      mcpOAuth: { generation: 1 },
    });
    const observed = new Set(),
      provider = oauth.provider(c.id, null, (value) => observed.add(value));
    provider.saveTokens({ access_token: 'synthetic-initial' });
    assert.equal(provider.tokens().access_token, 'synthetic-initial');
    provider.saveTokens({ access_token: 'synthetic-refreshed' });
    assert.deepEqual([...observed], ['synthetic-initial', 'synthetic-refreshed']);
    let current = store.get(c.id, 'connection');
    store.put('connection', { ...current, mcpOAuth: { ...current.mcpOAuth, generation: 2 } });
    assert.throws(
      () => provider.saveTokens({ access_token: 'synthetic-stale' }),
      /authorization changed/,
    );
    const latest = oauth.provider(c.id);
    oauth.clear(c.id);
    current = store.get(c.id, 'connection');
    store.put('connection', { ...current, enabled: false });
    assert.throws(() => latest.saveTokens({ access_token: 'synthetic-late' }), /disabled/);
    assert.equal(store.db.prepare('SELECT count(*) n FROM secrets').get().n, 0);
  } finally {
    store.close();
  }
});

test('an added MCP server grants the selected Bot the ability to call plugins', async (context) => {
  const host = await startHost(mkdtempSync(join(tmpdir(), 'orbit-plugin-server-')), 14386);
  context.after(() => stopHost(host));
  await host.call('/auth/setup', { name: 'plugin-owner', password: 'Synthetic-plugin-owner-2026' });
  const bot = (
    await host.call('/bots', {
      name: 'Plugin caller',
      purpose: 'Use an added MCP server',
      role: 'Synthetic only',
      capabilities: ['memory'],
    })
  ).body;
  const added = await host.call('/plugins/servers', {
    name: 'Notes server',
    endpoint: 'http://127.0.0.1:9/mcp',
    auth: 'none',
    botIds: [bot.id],
  });
  assert.equal(added.status, 201);
  assert.equal(added.body.kind, 'mcp');
  assert.equal(added.body.enabled, true);
  assert.deepEqual(added.body.botIds, [bot.id]);
  const updated = (await host.call('/state')).body.bots.find((item) => item.id === bot.id);
  assert.ok(updated.capabilities.includes('memory'));
  assert.ok(updated.capabilities.includes('extensions'));
  assert.equal(
    (
      await host.call('/plugins/servers', {
        name: 'Missing token',
        endpoint: 'http://127.0.0.1:9/mcp',
        auth: 'token',
        botIds: [bot.id],
      })
    ).status,
    400,
  );
});
