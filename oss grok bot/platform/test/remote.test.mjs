import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import selfsigned from 'selfsigned';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHost, stopHost, syntheticProvider, waitFor } from './support.mjs';

test('paired HTTPS clients use the primary host sessions and receipts; origin, replay and revocation fail closed', async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'bot-workshop-remote-'));
  let host = await startHost(data, 14340);
  const provider = await syntheticProvider();
  t.after(async () => {
    await stopHost(host);
    await new Promise((r) => provider.server.close(r));
  });
  await host.call('/auth/setup', {
    name: 'synthetic-remote-owner',
    password: 'Synthetic-remote-only-2026',
  });
  const tls = await selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
    ],
  });
  const base = 'https://127.0.0.1:14342';
  let cookies = '';
  function remote(path, value, origin = base) {
    return new Promise((yes, no) => {
      const req = https.request(
        base + path,
        {
          method: value === undefined ? 'GET' : 'POST',
          ca: tls.cert,
          headers: {
            origin,
            cookie: cookies,
            ...(value === undefined ? {} : { 'content-type': 'application/json' }),
          },
        },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => {
            const set = res.headers['set-cookie'];
            if (set)
              for (const c of set) cookies = [cookies, c.split(';')[0]].filter(Boolean).join('; ');
            let body;
            try {
              body = JSON.parse(text);
            } catch {
              body = text;
            }
            yes({ status: res.statusCode, body });
          });
        },
      );
      req.on('error', no);
      req.end(value === undefined ? undefined : JSON.stringify(value));
    });
  }
  assert.equal(
    (
      await host.call('/remote', {
        enabled: true,
        url: base,
        bind: '127.0.0.1',
        port: 14342,
        certificate: tls.cert,
        privateKey: tls.private,
      })
    ).body.running,
    true,
  );
  assert.match((await remote('/')).body, /Pair this device/);
  assert.equal((await remote('/api/state')).status, 401);
  const pair = (await host.call('/remote/pair', { name: 'Synthetic Mac' })).body;
  assert.equal(
    (
      await remote(
        '/remote/pair',
        { code: pair.code, name: 'Synthetic remote client' },
        'https://foreign.invalid',
      )
    ).status,
    403,
  );
  assert.equal(
    (await remote('/remote/pair', { code: pair.code, name: 'Synthetic remote client' })).status,
    200,
  );
  assert.equal((await remote('/remote/pair', { code: pair.code, name: 'Replay' })).status, 403);
  assert.equal(
    (await remote('/api/state')).status,
    401,
    'transport pairing does not sign in an account',
  );
  assert.equal(
    (
      await remote('/api/auth/login', {
        name: 'synthetic-remote-owner',
        password: 'Synthetic-remote-only-2026',
      })
    ).status,
    200,
  );
  assert.equal((await remote('/api/state')).status, 200);
  assert.equal((await remote('/api/vault')).status, 403);
  assert.equal(
    (await remote('/api/vault', { kind: 'login', label: 'Remote disallowed' })).status,
    403,
  );
  assert.equal(
    (await remote('/api/remote')).status,
    403,
    'remote app cannot reconfigure primary transport',
  );
  const model = (
    await host.call('/models', {
      name: 'Synthetic remote provider',
      api: 'openai-completions',
      endpoint: `http://127.0.0.1:${provider.port}/v1`,
      model: 'synthetic-workflow',
      contextWindow: 32000,
      maxTokens: 1000,
    })
  ).body;
  assert.ok(model.id, JSON.stringify(model));
  // Use the same public product boundary as any desktop request.
  const bot = (
    await host.call('/bots', {
      name: 'Remote workflow',
      purpose: 'Synthetic verification',
      role: 'Use granted tools for the requested synthetic workflow.',
      modelId: model.id,
      color: '#a9bca6',
      capabilities: ['memory', 'library'],
      maxTurns: 6,
    })
  ).body;
  assert.ok(bot.id, JSON.stringify(bot));
  const conversation = (
    await remote(`/api/bots/${bot.id}/conversations`, { name: 'Remote session' })
  ).body;
  const run = (
    await remote(`/api/bots/${bot.id}/tasks`, {
      conversationId: conversation.id,
      text: 'WORKFLOW_TEST from a paired client',
      nonce: crypto.randomUUID(),
    })
  ).body;
  assert.ok(run.id, JSON.stringify(run));
  await waitFor(async () => {
    const o = (await host.call(`/bots/${bot.id}/overview`)).body;
    return (
      o.runs.find((r) => r.id === run.id)?.state === 'settled' &&
      o.memories.length &&
      o.revisions.length
    );
  }, 'remote task effects stored on the primary host');
  const history = (await remote(`/api/bots/${bot.id}/conversations/${conversation.id}/history`))
    .body;
  assert.ok(JSON.stringify(history).includes('Synthetic test completed'));
  assert.equal((await remote('/api/state', undefined, 'https://foreign.invalid')).status, 403);
  await stopHost(host);
  host = await startHost(data, 14340);
  await host.call('/auth/login', {
    name: 'synthetic-remote-owner',
    password: 'Synthetic-remote-only-2026',
  });
  await waitFor(async () => {
    try {
      return (await remote('/api/state')).status === 200;
    } catch {
      return false;
    }
  }, 'paired client reconnect after primary restart');
  const client = (await host.call('/remote')).body.clients[0];
  assert.equal((await host.call(`/remote/clients/${client.id}/revoke`, {})).status, 200);
  assert.equal((await remote('/api/state')).status, 401);
});
