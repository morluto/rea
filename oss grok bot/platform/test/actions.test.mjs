import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startHost, stopHost, waitFor } from './support.mjs';
test('direct and scheduled connector actions share approvals, nonce identity, revocation and receipts without a model', async (t) => {
  let calls = 0;
  const external = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    calls++;
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: true, ordinal: calls }));
  });
  await new Promise((r) => external.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => external.close(r)));
  const data = mkdtempSync(join(tmpdir(), 'bot-workshop-actions-'));
  let host = await startHost(data, 14325);
  t.after(() => stopHost(host));
  const password = 'Synthetic-action-workflow-2026';
  await host.call('/auth/setup', { name: 'action-tests', password });
  const bot = (
    await host.call('/bots', {
      name: 'Direct action Bot',
      purpose: 'Synthetic protocol checks',
      role: 'Use explicit tools only',
      modelId: null,
      capabilities: ['extensions'],
      color: '#adbbff',
      maxTurns: 5,
    })
  ).body;
  let c = (
    await host.call('/connections', {
      name: 'Synthetic HTTP action',
      kind: 'http',
      endpoint: `http://127.0.0.1:${external.address().port}`,
      botIds: [bot.id],
      tools: [
        {
          name: 'test.submit',
          description: 'Synthetic protocol endpoint; not delivery',
          method: 'POST',
          path: '/submit',
          policy: 'ask',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
        },
      ],
    })
  ).body;
  c = (await host.call(`/connections/${c.id}/discover`, {})).body;
  const input = {
    connectionId: c.id,
    operation: 'test.submit',
    args: { text: 'synthetic request' },
    nonce: randomUUID(),
  };
  const submit = await host.call(`/bots/${bot.id}/actions`, input);
  assert.equal(submit.status, 202, JSON.stringify(submit));
  const run = submit.body;
  assert.equal((await host.call(`/bots/${bot.id}/actions`, input)).body.id, run.id);
  assert.equal(
    (await host.call(`/bots/${bot.id}/actions`, { ...input, args: { text: 'changed' } })).status,
    409,
  );
  const overview = async () => (await host.call(`/bots/${bot.id}/overview`)).body;
  const approval = await waitFor(
    async () =>
      (await overview()).approvals.find((a) => a.runId === run.id && a.state === 'pending'),
    'direct action approval',
  );
  assert.equal(calls, 0);
  await host.call(`/bots/${bot.id}/approvals/${approval.id}`, {
    revision: approval.revision,
    decision: 'approved',
  });
  const completed = await waitFor(
    async () => (await overview()).runs.find((r) => r.id === run.id && r.state === 'settled'),
    'direct action completion',
  );
  assert.equal(calls, 1);
  assert.equal(completed.result.result.status, 202);
  assert.equal(completed.outcome, 'response_received');
  assert.equal(completed.config, undefined);
  // The HTTP response receipt reports acceptance, never invented delivery.
  assert.match(completed.result.limitation, /does not establish external delivery/);
  const denied = (await host.call(`/bots/${bot.id}/actions`, { ...input, nonce: randomUUID() }))
    .body;
  const pending = await waitFor(
    async () =>
      (await overview()).approvals.find((a) => a.runId === denied.id && a.state === 'pending'),
    'approval before revocation',
  );
  c = (
    await host.call(`/connections/${c.id}`, {
      revision: c.revision,
      enabled: false,
      botIds: [bot.id],
      policies: { 'test.submit': 'allow' },
    })
  ).body;
  await host.call(`/bots/${bot.id}/approvals/${pending.id}`, {
    revision: pending.revision,
    decision: 'approved',
  });
  await waitFor(
    async () => (await overview()).runs.find((r) => r.id === denied.id && r.state === 'failed'),
    'revocation failure',
  );
  assert.equal(calls, 1);
  c = (
    await host.call(`/connections/${c.id}`, {
      revision: c.revision,
      enabled: true,
      botIds: [bot.id],
      policies: { 'test.submit': 'allow' },
    })
  ).body;
  const cancelled = (
    await host.call(`/bots/${bot.id}/actions`, {
      ...input,
      nonce: randomUUID(),
      notBefore: Date.now() + 60000,
    })
  ).body;
  assert.equal(cancelled.state, 'scheduled');
  assert.equal(
    (await host.call(`/bots/${bot.id}/runs/${cancelled.id}/cancel`, {})).body.state,
    'cancelled',
  );
  const scheduled = (
    await host.call(`/bots/${bot.id}/actions`, {
      ...input,
      nonce: randomUUID(),
      notBefore: Date.now() + 1800,
    })
  ).body;
  assert.equal(scheduled.state, 'scheduled');
  await stopHost(host);
  host = await startHost(data, 14325);
  await host.call('/auth/login', { name: 'action-tests', password });
  await waitFor(
    async () => (await overview()).runs.find((r) => r.id === scheduled.id && r.state === 'settled'),
    'durable due action',
  );
  assert.equal(calls, 2);
});
