import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { startHost, stopHost, syntheticProvider, waitFor } from './support.mjs';
test('real local companion pairing, scoped files, routed HTTP and revocation', async (t) => {
  const host = await startHost(mkdtempSync(join(tmpdir(), 'workshop-device-host-')), 14322),
    provider = await syntheticProvider();
  let companion;
  const remote = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        received: JSON.parse(Buffer.concat(chunks).toString()),
        route: 'actual companion HTTP request',
      }),
    );
  });
  await new Promise((r) => remote.listen(0, '127.0.0.1', r));
  t.after(async () => {
    companion?.kill();
    await stopHost(host);
    await provider.server.close();
    await new Promise((r) => remote.close(r));
  });
  await host.call('/auth/setup', { name: 'device-owner', password: 'Synthetic-device-owner-2026' });
  const model = (
    await host.call('/models', {
      name: 'Device fixture model',
      endpoint: `http://127.0.0.1:${provider.port}/v1`,
      api: 'openai-completions',
      model: 'synthetic-workflow',
    })
  ).body;
  const bot = (
    await host.call('/bots', {
      name: 'Device test',
      purpose: 'Validate explicit device grants',
      role: 'Use granted test operations only',
      modelId: model.id,
      capabilities: ['extensions', 'devices'],
    })
  ).body;
  const pending = await host.call('/devices', {
    name: 'Actual test companion',
    botIds: [bot.id],
    files: true,
    routing: true,
  });
  assert.equal(pending.status, 201);
  const root = mkdtempSync(join(tmpdir(), 'workshop-device-root-'));
  writeFileSync(join(root, 'input.txt'), 'Selected-root source bytes');
  companion = spawn(
    'python',
    [
      'device/companion.py',
      '--host',
      host.base,
      '--root',
      root,
      '--allow-http-routing',
      '--pair-stdin',
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  companion.stdin.end(pending.body.pairCode + '\n');
  let output = '';
  companion.stdout.on('data', (c) => (output += c));
  let stderr = '';
  companion.stderr.on('data', (c) => (stderr += c));
  await waitFor(() => {
    if (companion.exitCode !== null) throw Error(stderr);
    return output.includes('"paired": true');
  }, 'real companion pairing');
  const device = (await host.call('/devices')).body[0];
  assert.equal(device.state, 'paired');
  assert.equal((await host.call(`/devices/${device.id}/check`, {})).status, 200);
  const read = await host.call(`/devices/${device.id}/operate`, {
    botId: bot.id,
    operation: 'read',
    path: 'input.txt',
  });
  assert.equal(read.body.content, 'Selected-root source bytes');
  assert.equal(
    (
      await host.call(`/devices/${device.id}/operate`, {
        botId: bot.id,
        operation: 'read',
        path: '../outside.txt',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await host.call(`/devices/${device.id}/operate`, {
        botId: bot.id,
        operation: 'write',
        path: 'output.txt',
        content: 'Real companion write',
      })
    ).status,
    200,
  );
  assert.equal(readFileSync(join(root, 'output.txt'), 'utf8'), 'Real companion write');
  const conn = (
    await host.call('/connections', {
      name: 'Routed test endpoint',
      kind: 'http',
      endpoint: `http://127.0.0.1:${remote.address().port}`,
      routeDeviceId: device.id,
      botIds: [bot.id],
      tools: [
        {
          name: 'echo',
          description: 'Send a synthetic echo',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
          method: 'POST',
          path: '/',
          policy: 'allow',
        },
      ],
    })
  ).body;
  const discovered = await host.call(`/connections/${conn.id}/discover`, {});
  assert.equal(discovered.body.state, 'configured');
  const conversation = (
    await host.call(`/bots/${bot.id}/conversations`, { name: 'Routed request' })
  ).body;
  const run = (
    await host.call(`/bots/${bot.id}/tasks`, {
      text: 'EXTENSION_TEST',
      nonce: randomUUID(),
      conversationId: conversation.id,
    })
  ).body;
  const complete = await waitFor(async () => {
    const o = (await host.call(`/bots/${bot.id}/overview`)).body;
    return o.runs.find((r) => r.id === run.id && ['settled', 'failed'].includes(r.state));
  }, 'routed operation');
  assert.equal(complete.state, 'settled', JSON.stringify(complete));
  const workflow = (await host.call(`/bots/${bot.id}/workflow`)).body;
  assert.equal(workflow.externalActions[0].response.body.route, 'actual companion HTTP request');
  const current = (await host.call('/devices')).body[0];
  assert.equal(
    (
      await host.call(`/devices/${current.id}`, {
        name: current.name,
        botIds: current.botIds,
        files: false,
        routing: false,
        state: 'revoked',
        revision: current.revision,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await host.call(`/devices/${current.id}/operate`, {
        botId: bot.id,
        operation: 'read',
        path: 'input.txt',
      })
    ).status,
    403,
  );
});
