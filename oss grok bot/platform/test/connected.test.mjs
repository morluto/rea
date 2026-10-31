import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { startHost, stopHost, syntheticProvider, waitFor } from './support.mjs';

test('connected questions, recovery, delegation, knowledge, MCP and notifications', async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'bot-workshop-connected-'));
  const provider = await syntheticProvider();
  let host = await startHost(data, 14320);
  let remoteCalls = 0;
  const remote = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    const mcp = new McpServer({ name: 'synthetic-mcp-fixture', version: '1.0.0' });
    mcp.registerTool(
      'echo',
      { description: 'Return synthetic text', inputSchema: { text: z.string() } },
      async ({ text }) => {
        remoteCalls++;
        return { content: [{ type: 'text', text: 'MCP received ' + text }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await transport.handleRequest(req, res);
  });
  await new Promise((r) => remote.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await stopHost(host);
    await provider.server.close();
    await new Promise((r) => remote.close(r));
  });
  await host.call('/auth/setup', {
    name: 'connected-test',
    password: 'Synthetic-connection-tests-2026',
  });
  const model = (
    await host.call('/models', {
      name: 'Synthetic connected model',
      endpoint: `http://127.0.0.1:${provider.port}/v1`,
      model: 'synthetic-workflow',
      api: 'openai-completions',
    })
  ).body;
  const make = async (name, caps) => {
    const r = await host.call('/bots', {
      name,
      purpose: 'Synthetic connection validation',
      role: 'Use the requested test tools only.',
      modelId: model.id,
      capabilities: caps,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const parent = await make('Parent test', ['library', 'delegation', 'extensions', 'knowledge']),
    worker = await make('Worker test', ['library']);
  const run = async (bot, text) => {
    const c = (await host.call(`/bots/${bot.id}/conversations`, { name: text.slice(0, 60) })).body;
    const r = await host.call(`/bots/${bot.id}/tasks`, {
      conversationId: c.id,
      text,
      nonce: randomUUID(),
    });
    assert.equal(r.status, 202);
    return r.body;
  };
  const overview = async () => ({
    ...(await host.call(`/bots/${parent.id}/overview`)).body,
    ...(await host.call(`/bots/${parent.id}/workflow`)).body,
  });
  const waitRun = await run(parent, 'WAIT_TEST');
  const question = await waitFor(async () => {
    const o = await overview();
    return o.waits?.find((w) => w.runId === waitRun.id && w.state === 'pending');
  }, 'input question');
  assert.equal(
    (
      await host.call(`/bots/${parent.id}/waits/${question.id}`, {
        answer: 'Brief',
        revision: question.revision,
      })
    ).status,
    200,
  );
  await waitFor(
    async () => (await overview()).runs.find((r) => r.id === waitRun.id && r.state === 'settled'),
    'same task resumed',
  );
  // A pending question survives a host crash; answering reconciles the canonical
  // tool result and continues the same run without replaying previous operations.
  const restartWait = await run(parent, 'WAIT_TEST recover');
  const pending = await waitFor(
    async () =>
      (await overview()).waits.find((w) => w.runId === restartWait.id && w.state === 'pending'),
    'question before restart',
  );
  host.child.kill('SIGKILL');
  await new Promise((r) => host.child.once('exit', r));
  host = await startHost(data, 14320);
  await host.call('/auth/login', {
    name: 'connected-test',
    password: 'Synthetic-connection-tests-2026',
  });
  assert.equal((await overview()).runs.find((r) => r.id === restartWait.id).state, 'waiting_input');
  const answered = await host.call(`/bots/${parent.id}/waits/${pending.id}`, {
    answer: 'Detailed',
    revision: pending.revision,
  });
  assert.equal(answered.status, 200, JSON.stringify(answered));
  await waitFor(
    async () =>
      (await overview()).runs.find((r) => r.id === restartWait.id && r.state === 'settled'),
    'question continuation after restart',
  );
  const parentRun = await run(parent, `DELEGATE_TEST TARGET=${worker.id}`);
  const approval = await waitFor(
    async () =>
      (await overview()).approvals.find((a) => a.runId === parentRun.id && a.state === 'pending'),
    'delegation approval',
  );
  await host.call(`/bots/${parent.id}/approvals/${approval.id}`, {
    decision: 'approved',
    revision: approval.revision,
  });
  const completed = await waitFor(
    async () =>
      (await overview()).runs.find(
        (r) => r.id === parentRun.id && ['settled', 'failed'].includes(r.state),
      ),
    'parent and worker completion',
  );
  assert.equal(completed.state, 'settled', JSON.stringify(completed));
  const children = (await overview()).children;
  assert.equal(children.length, 1);
  assert.equal(children[0].state, 'settled');
  const note = await host.call(`/bots/${parent.id}/knowledge`, {
    title: 'Synthetic source',
    content: 'The test fixture uses exact synthetic source values.',
    source: 'Connected workflow test',
  });
  assert.equal(note.status, 201);
  const search = await host.call(`/bots/${parent.id}/knowledge?query=exact`);
  assert.equal(search.body[0].id, note.body.id);
  const connection = await host.call('/connections', {
    name: 'Real MCP protocol test',
    kind: 'mcp',
    endpoint: `http://127.0.0.1:${remote.address().port}/mcp`,
    botIds: [parent.id],
  });
  assert.equal(connection.status, 201);
  const discovered = await host.call(`/connections/${connection.body.id}/discover`, {});
  assert.equal(discovered.status, 200, JSON.stringify(discovered));
  assert.equal(discovered.body.discoveredTools[0].name, 'echo');
  const external = await run(parent, 'EXTENSION_TEST');
  const externalApproval = await waitFor(
    async () =>
      (await overview()).approvals.find((a) => a.runId === external.id && a.state === 'pending'),
    'external tool approval',
  );
  await host.call(`/bots/${parent.id}/approvals/${externalApproval.id}`, {
    decision: 'approved',
    revision: externalApproval.revision,
  });
  const settled = await waitFor(
    async () =>
      (await overview()).runs.find(
        (r) => r.id === external.id && ['settled', 'failed'].includes(r.state),
      ),
    'MCP run settlement',
  );
  assert.equal(settled.state, 'settled', JSON.stringify(settled));
  assert.equal(remoteCalls, 1);
  const actions = (await overview()).externalActions;
  assert.equal(actions.length, 1);
  assert.equal(actions[0].outcome, 'response_received');
  assert.match(JSON.stringify(actions[0].response), /MCP received synthetic-echo/);
  const notifications = await host.call('/notifications');
  assert.ok(notifications.body.some((n) => n.runId === external.id));
  const analytics = await host.call('/analytics?days=7');
  assert.ok(analytics.body.completed >= 5);
  assert.equal(analytics.body.minutesSaved, null);
});
