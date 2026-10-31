import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, id } from '../packages/host/src/store.mjs';
import { Vault } from '../packages/host/src/security.mjs';
import { Connections } from '../packages/host/src/connections.mjs';
import { OAuth } from '../packages/host/src/oauth.mjs';
import { Plugins } from '../packages/host/src/plugins.mjs';
import { startHost, stopHost } from './support.mjs';

test('saved app registration reuses setup, not grants; sign-in success, denial, expiry and cancellation retain identity', async (context) => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'orbit-plugin-signin-')));
  const vault = new Vault(store),
    connections = new Connections(store, vault);
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/identity')
      return response.end(
        JSON.stringify({ sub: 'fixture-subject', email: 'fixture@example.invalid' }),
      );
    let text = '';
    for await (const chunk of request) text += chunk;
    const params = new URLSearchParams(text);
    assert.equal(params.get('client_id'), 'fixture-client');
    assert.equal(params.get('client_secret'), 'fixture-private-secret');
    assert.ok(params.get('code_verifier'));
    response.end(
      JSON.stringify({
        access_token: 'fixture-access',
        refresh_token: 'fixture-refresh',
        expires_in: 3600,
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    store.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const oauth = new OAuth(store, vault, connections, base, {
    google: {
      authorize: base + '/authorize',
      token: base + '/token',
      identity: base + '/identity',
    },
  });
  const plugins = new Plugins(store, connections, oauth, vault),
    owner = id(),
    other = id(),
    bot = id();
  store.put('bot', { id: bot, ownerId: owner });
  await assert.rejects(
    () => plugins.connect(owner, 'gmail', { botIds: [bot] }),
    /Set up this provider once/,
  );
  const application = oauth.configureApplication(owner, 'google', {
    clientId: 'fixture-client',
    clientSecret: 'fixture-private-secret',
    revision: 0,
  });
  assert.equal(application.hasClientSecret, true);
  assert.ok(!JSON.stringify(application).includes('fixture-private-secret'));
  assert.equal(oauth.application(other, 'google').configured, false);
  assert.throws(
    () => oauth.configureApplication(owner, 'google', { clientId: 'stale', revision: 0 }),
    /changed/,
  );
  const mail = await plugins.connect(owner, 'gmail', { botIds: [bot] });
  assert.equal(mail.plugin.installed.connection.hasCredential, false);
  assert.deepEqual(mail.plugin.installed.connection.botIds, [bot]);
  const url = new URL(mail.authorization.authorizeUrl);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), base + '/');
  assert.ok(url.searchParams.get('scope').includes('gmail.modify'));
  assert.ok(!url.searchParams.get('scope').includes('calendar.events'));
  assert.throws(() => oauth.flow(mail.authorization.id, other), /owner required/);
  await oauth.callback(
    new URLSearchParams({ state: url.searchParams.get('state'), code: 'fixture-code' }),
  );
  assert.equal(oauth.flow(mail.authorization.id, owner).state, 'connected');
  const installed = plugins.list(owner).find((value) => value.id === 'gmail').installed;
  assert.equal(installed.connection.accountLabel, 'fixture@example.invalid');
  assert.ok(installed.connection.discoveredTools.every((tool) => tool.policy === 'ask'));
  assert.ok(!JSON.stringify(installed).includes('fixture-private-secret'));
  const calendar = await plugins.connect(owner, 'google-calendar', { botIds: [bot] });
  assert.equal(calendar.plugin.installed.connection.hasCredential, false);
  const calendarUrl = new URL(calendar.authorization.authorizeUrl);
  await assert.rejects(
    () =>
      oauth.callback(
        new URLSearchParams({
          state: calendarUrl.searchParams.get('state'),
          error: 'access_denied',
        }),
      ),
    /did not authorize/,
  );
  assert.equal(oauth.flow(calendar.authorization.id, owner).state, 'failed');
  const retry = await plugins.connect(owner, 'google-calendar', { botIds: [bot] });
  const newer = await plugins.connect(owner, 'google-calendar', { botIds: [bot] });
  assert.equal(oauth.flow(retry.authorization.id, owner).state, 'cancelled');
  const pending = store.get(newer.authorization.id, 'oauth_flow');
  store.put('oauth_flow', { ...pending, expiresAt: Date.now() - 1 });
  assert.equal(oauth.flow(newer.authorization.id, owner).state, 'expired');
  assert.equal(
    store.db.prepare('SELECT count(*) AS total FROM secrets WHERE id=?').get(pending.verifierRef)
      .total,
    0,
  );
  plugins.uninstall(owner, 'gmail', installed.revision);
  assert.equal(oauth.flow(mail.authorization.id, owner).state, 'superseded');
  assert.equal(oauth.application(owner, 'google').hasClientSecret, true);
  await assert.doesNotReject(() => plugins.connect(owner, 'gmail', { botIds: [bot] }));
});

test('public plugin connect needs owner registration, reuses the same install and exposes cancellable nonsecret status', async (context) => {
  const host = await startHost(mkdtempSync(join(tmpdir(), 'orbit-plugin-connect-api-')), 14357);
  context.after(() => stopHost(host));
  await host.call('/auth/setup', { name: 'plugin-owner', password: 'Synthetic-plugin-owner-2026' });
  const bot = (
    await host.call('/bots', {
      name: 'Plugin fixture',
      purpose: 'Synthetic setup',
      role: 'Synthetic account only',
    })
  ).body;
  assert.equal((await host.call('/plugins/gmail/connect', { botIds: [bot.id] })).status, 409);
  const configured = await host.call('/oauth/applications/google', {
    clientId: 'fixture-client',
    clientSecret: 'fixture-private',
    revision: 0,
  });
  assert.equal(configured.status, 200);
  assert.equal(configured.body.hasClientSecret, true);
  assert.ok(!JSON.stringify(configured.body).includes('fixture-private'));
  assert.equal(
    (await host.call('/oauth/applications/google', { clientId: 'stale', revision: 0 })).status,
    409,
  );
  const first = await host.call('/plugins/gmail/connect', { botIds: [bot.id] });
  assert.equal(first.status, 200);
  assert.equal(new URL(first.body.authorization.authorizeUrl).hostname, 'accounts.google.com');
  const second = (await host.call('/plugins/gmail/connect', { botIds: [bot.id] })).body;
  assert.equal(second.plugin.installed.connectionId, first.body.plugin.installed.connectionId);
  assert.equal(
    (await host.call('/oauth/flows/' + first.body.authorization.id)).body.state,
    'cancelled',
  );
  assert.equal((await host.call('/oauth/flows/' + second.authorization.id)).body.state, 'pending');
  assert.equal(
    (await host.call('/oauth/flows/' + second.authorization.id + '/cancel', {})).body.state,
    'cancelled',
  );
  assert.equal((await fetch(host.base + '/api/oauth/applications/google')).status, 401);
  assert.equal((await host.call('/oauth/applications/unknown')).status, 404);
  const denied = (await host.call('/plugins/gmail/connect', { botIds: [bot.id] })).body;
  const state = new URL(denied.authorization.authorizeUrl).searchParams.get('state');
  assert.equal(
    (await fetch(host.base + '/?state=' + encodeURIComponent(state) + '&error=access_denied'))
      .status,
    409,
  );
  assert.equal((await host.call('/oauth/flows/' + denied.authorization.id)).body.state, 'failed');
});
