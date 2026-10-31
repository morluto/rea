import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { Store, id } from '../packages/host/src/store.mjs';
import { Vault } from '../packages/host/src/security.mjs';
import { Connections } from '../packages/host/src/connections.mjs';
import { OAuth } from '../packages/host/src/oauth.mjs';
import { adaptOperation, providerPreset } from '../packages/host/src/provider-presets.mjs';
test('OAuth PKCE, selected identity, encrypted tokens, refresh and local disconnect', async (t) => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'workshop-oauth-'))),
    vault = new Vault(store),
    connections = new Connections(store, vault);
  let refreshes = 0,
    exchanges = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/identity') {
      assert.match(req.headers.authorization, /Bearer synthetic-/);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sub: 'synthetic-subject', email: 'synthetic@example.invalid' }));
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const params = new URLSearchParams(Buffer.concat(chunks).toString());
    assert.equal(params.get('client_id'), 'synthetic-client');
    if (params.get('grant_type') === 'refresh_token') {
      refreshes++;
      assert.equal(params.get('refresh_token'), 'synthetic-refresh');
    } else {
      exchanges++;
      assert.ok(params.get('code_verifier').length >= 43);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        access_token: 'synthetic-' + (refreshes ? 'fresh' : 'initial'),
        refresh_token: 'synthetic-refresh',
        expires_in: refreshes ? 3600 : 0,
      }),
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    store.close();
    await new Promise((r) => server.close(r));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const oauth = new OAuth(store, vault, connections, 'http://127.0.0.1:4317', {
    google: {
      authorize: base + '/authorize',
      token: base + '/token',
      identity: base + '/identity',
    },
  });
  connections.oauth = oauth;
  const owner = id(),
    botId = id();
  store.put('bot', { id: botId, ownerId: owner });
  const c = oauth.create(owner, {
    name: 'Synthetic mail account',
    provider: 'google',
    service: 'mail',
    clientId: 'synthetic-client',
    clientSecret: 'synthetic-private-client-secret',
    botIds: [botId],
  });
  assert.equal(c.state, 'auth_required');
  assert.ok(!JSON.stringify(c).includes('synthetic-private-client-secret'));
  assert.ok(!JSON.stringify(c).includes('clientSecretRef'));
  const flow = oauth.begin(c.id, owner),
    authorize = new URL(flow.authorizeUrl);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorize.searchParams.get('scope').includes('gmail.modify'));
  const connected = await oauth.callback(
    new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'synthetic-code' }),
  );
  assert.equal(connected.accountLabel, 'synthetic@example.invalid');
  assert.equal(connected.oauth.state, 'authenticated');
  assert.equal(exchanges, 1);
  const [one, two] = await Promise.all([
    oauth.bearer(store.get(c.id, 'connection')),
    oauth.bearer(store.get(c.id, 'connection')),
  ]);
  assert.equal(one, 'synthetic-fresh');
  assert.equal(two, one);
  assert.equal(refreshes, 1);
  await assert.rejects(
    () =>
      oauth.callback(
        new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'replay' }),
      ),
    /expired or was already consumed/,
  );
  assert.equal(oauth.disconnect(c.id, owner).state, 'disconnected');
  await assert.rejects(() => oauth.bearer(store.get(c.id, 'connection')), /Authenticate/);
});
test('mail/calendar producer adapters preserve selected inputs and encode path identities', () => {
  const gmail = providerPreset('google', 'mail').tools.find((t) => t.name === 'mail.send');
  const adapted = adaptOperation(gmail, {
    to: ['Example <synthetic@example.invalid>'],
    subject: 'Résumé',
    body: 'Exact text\nsecond line',
  });
  const mime = Buffer.from(adapted.body.raw, 'base64url').toString();
  assert.match(mime, /To: Example <synthetic@example.invalid>/);
  assert.match(mime, /Subject: =\?UTF-8\?B\?/);
  assert.ok(mime.includes(Buffer.from('Exact text\nsecond line').toString('base64')));
  assert.throws(
    () => adaptOperation(gmail, { to: ['a\r\nBcc: other'], subject: 'x', body: 'x' }),
    /single-line/,
  );
  const read = providerPreset('google', 'mail').tools.find((t) => t.name === 'mail.read');
  assert.equal(
    adaptOperation(read, { id: 'id/with?query', format: 'full' }).path,
    '/gmail/v1/users/me/messages/id%2Fwith%3Fquery',
  );
  const event = providerPreset('google', 'calendar').tools.find(
    (t) => t.name === 'calendar.create',
  );
  const args = {
    summary: 'Exact event',
    start: '2026-10-26T10:00:00-04:00',
    end: '2026-10-26T11:00:00-04:00',
    timezone: 'America/Toronto',
  };
  const parsed = adaptOperation(event, args);
  assert.equal(parsed.path, '/calendar/v3/calendars/primary/events');
  assert.equal(parsed.body.start.dateTime, args.start);
  assert.equal(parsed.body.start.timeZone, args.timezone);
});

test('disconnect during OAuth callback or token refresh cannot restore grants or forgotten credentials', async (t) => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'orbit-oauth-revocation-'))),
    vault = new Vault(store),
    connections = new Connections(store, vault);
  let identityCalls = 0;
  const server = http.createServer((_req, res) => {
    identityCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sub: 'fixture-sub', email: 'fixture@example.invalid' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const local = `http://127.0.0.1:${server.address().port}`;
  const oauth = new OAuth(store, vault, connections, 'http://127.0.0.1:4317', {
    google: {
      authorize: local + '/authorize',
      token: local + '/token',
      identity: local + '/identity',
    },
  });
  t.after(async () => {
    store.close();
    await new Promise((r) => server.close(r));
  });
  const owner = id(),
    botId = id();
  store.put('bot', { id: botId, ownerId: owner });
  const c = oauth.create(owner, {
    name: 'Revocation fixture',
    provider: 'google',
    service: 'mail',
    clientId: 'fixture-client',
    botIds: [botId],
  });
  const flow = oauth.begin(c.id, owner),
    state = new URL(flow.authorizeUrl).searchParams.get('state');
  let release, started;
  const entered = new Promise((r) => (started = r));
  oauth.exchange = async () => {
    started();
    await new Promise((r) => (release = r));
    return { access_token: 'synthetic-late-token', expires_in: 3600 };
  };
  const pending = oauth.callback(new URLSearchParams({ state, code: 'fixture-code' }));
  await entered;
  oauth.disconnect(c.id, owner);
  release();
  await assert.rejects(pending, /disconnected|reauthorized/i);
  assert.equal(identityCalls, 0, 'Revoked credentials never reach the identity endpoint');
  assert.equal(store.get(c.id, 'connection').enabled, false);
  assert.equal(store.get(c.id, 'connection').oauth.tokenRef, null);
  const ref = vault.save(
    JSON.stringify({ access_token: 'synthetic-old', refresh_token: 'synthetic-refresh' }),
  );
  const active = store.put('connection', {
    ...store.get(c.id, 'connection'),
    enabled: true,
    oauth: {
      ...store.get(c.id, 'connection').oauth,
      tokenRef: ref,
      expiresAt: 0,
      state: 'authenticated',
    },
  });
  let refreshStarted, finish;
  const refreshing = new Promise((r) => (refreshStarted = r));
  oauth.exchange = async () => {
    refreshStarted();
    await new Promise((r) => (finish = r));
    return { access_token: 'synthetic-new', expires_in: 3600 };
  };
  const refresh = oauth.bearer(active);
  await refreshing;
  oauth.disconnect(c.id, owner);
  finish();
  await assert.rejects(refresh, /changed while refreshing/);
  const after = store.get(c.id, 'connection');
  assert.equal(after.enabled, false);
  assert.equal(after.state, 'disconnected');
  assert.equal(after.oauth.state, 'disconnected');
  assert.equal(store.db.prepare('SELECT count(*) n FROM secrets WHERE id=?').get(ref).n, 0);
});
