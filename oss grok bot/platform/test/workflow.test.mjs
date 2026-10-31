import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../packages/host/src/store.mjs';
import { Product, nextOccurrence } from '../packages/host/src/product.mjs';

import { syntheticProvider, startHost, waitFor, stopHost } from './support.mjs';
const enabled = process.env.WORKSHOP_DEMO !== '1';
test(
  'real HTTP host + Pi SDK synthetic workflow, boundaries, cancellation and restart',
  { skip: !enabled },
  async (t) => {
    const data = mkdtempSync(join(tmpdir(), 'bot-workshop-workflow-'));
    const provider = await syntheticProvider();
    let host = await startHost(data, 14318);
    t.after(async () => {
      await stopHost(host);
      await new Promise((r) => provider.server.close(r));
    });
    assert.equal((await host.call('/state')).status, 401);
    assert.equal(
      (
        await host.call('/auth/setup', {
          name: 'synthetic-test',
          password: 'Synthetic-only-password-2026',
        })
      ).status,
      200,
    );
    const badOrigin = await fetch(host.base + '/api/bots', {
      method: 'POST',
      headers: {
        origin: 'https://untrusted.invalid',
        cookie: host.cookie(),
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(badOrigin.status, 403);
    const model = (
      await host.call('/models', {
        name: 'Synthetic test endpoint',
        endpoint: `http://127.0.0.1:${provider.port}/v1`,
        model: 'synthetic-workflow',
        api: 'openai-completions',
        contextWindow: 32000,
        maxTokens: 2048,
      })
    ).body;
    assert.equal(model.connection, 'unverified');
    assert.equal((await host.call(`/models/${model.id}/check`, {})).status, 200);
    const bot = (
      await host.call('/bots', {
        name: 'Synthetic workflow Bot',
        purpose: 'Backend validation using synthetic test data',
        role: 'Run only the synthetic workflow requested. Do not infer real provider connectivity.',
        modelId: model.id,
        capabilities: ['memory', 'library', 'routines'],
      })
    ).body;
    assert.ok(bot.id);
    const conversation = (
      await host.call(`/bots/${bot.id}/conversations`, { name: 'Synthetic workflow' })
    ).body;
    const task = {
      text: 'WORKFLOW_TEST: save the synthetic preference and report.',
      nonce: randomUUID(),
      conversationId: conversation.id,
    };
    const [accepted, duplicate] = await Promise.all([
      host.call(`/bots/${bot.id}/tasks`, task),
      host.call(`/bots/${bot.id}/tasks`, task),
    ]);
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.id, duplicate.body.id);
    assert.equal(
      (await host.call(`/bots/${bot.id}/tasks`, { ...task, text: 'Different input' })).status,
      409,
    );
    const run = await waitFor(async () => {
      const o = (await host.call(`/bots/${bot.id}/overview`)).body;
      const r = o.runs.find((r) => r.id === accepted.body.id);
      return ['settled', 'failed'].includes(r?.state) && r;
    }, 'Pi workflow settlement');
    assert.equal(run.state, 'settled', JSON.stringify(run));
    const o = (await host.call(`/bots/${bot.id}/overview`)).body;
    assert.equal(o.memories.length, 1);
    assert.equal(o.artifacts.length, 1);
    assert.equal(o.memories[0].sourceRun, run.id);
    const revision = o.revisions[0];
    const download = await fetch(
      `${host.base}/api/bots/${bot.id}/artifacts/${revision.id}/download`,
      { headers: { cookie: host.cookie() } },
    );
    assert.equal(
      await download.text(),
      'Synthetic workflow report\nVerified bytes, not research data.\n',
    );
    assert.equal(
      (
        await host.call(`/bots/${bot.id}/artifacts`, {
          name: 'changed.txt',
          mediaType: 'text/plain',
          content: 'changed',
          artifactId: o.artifacts[0].id,
          expectedRevision: 999,
        })
      ).status,
      409,
    );
    const other = (
      await host.call('/bots', {
        name: 'Scope test',
        purpose: 'Validate isolation',
        role: 'Synthetic isolated Bot',
      })
    ).body;
    assert.equal(
      (await host.call(`/bots/${other.id}/artifacts/${revision.id}/preview`)).status,
      403,
    );
    const h = (await host.call(`/bots/${bot.id}/conversations/${conversation.id}/history`)).body;
    assert.ok(h.some((e) => e.role === 'assistant'));
    assert.ok(h.some((e) => e.role === 'toolResult'));
    assert.ok(h.every((e) => e.entryId));
    assert.ok(h.every((e) => e.runId === run.id));
    const reuseConversation = (
      await host.call(`/bots/${bot.id}/conversations`, { name: 'Memory and artifact reuse' })
    ).body;
    const reuse = (
      await host.call(`/bots/${bot.id}/tasks`, {
        text: 'Review my test preference and attached report.',
        conversationId: reuseConversation.id,
        nonce: randomUUID(),
        artifactRevisionIds: [revision.id],
      })
    ).body;
    await waitFor(async () => {
      const v = (await host.call(`/bots/${bot.id}/overview`)).body;
      return v.runs.find((r) => r.id === reuse.id && r.state === 'settled');
    }, 'reused memory and exact artifact context');
    const reuseRequest = provider.requests.at(-1);
    assert.match(JSON.stringify(reuseRequest), /Use concise synthetic reports/);
    assert.match(JSON.stringify(reuseRequest), /Verified bytes, not research data/);
    assert.match(JSON.stringify(reuseRequest), new RegExp(revision.digest));
    // A concrete routine tool waits for a durable approval, then resumes the same run.
    const ac = (await host.call(`/bots/${bot.id}/conversations`, { name: 'Approval test' })).body;
    const ar = (
      await host.call(`/bots/${bot.id}/tasks`, {
        text: 'APPROVAL_TEST',
        conversationId: ac.id,
        nonce: randomUUID(),
      })
    ).body;
    const approval = await waitFor(async () => {
      const v = (await host.call(`/bots/${bot.id}/overview`)).body;
      return v.approvals.find((a) => a.runId === ar.id && a.state === 'pending');
    }, 'durable approval');
    assert.equal(
      (
        await host.call(`/bots/${bot.id}/approvals/${approval.id}`, {
          decision: 'approved',
          revision: approval.revision,
        })
      ).status,
      200,
    );
    await waitFor(async () => {
      const v = (await host.call(`/bots/${bot.id}/overview`)).body;
      return v.runs.find((r) => r.id === ar.id && r.state === 'settled');
    }, 'approved run');
    const cc = (await host.call(`/bots/${bot.id}/conversations`, { name: 'Cancellation test' }))
      .body;
    const cr = (
      await host.call(`/bots/${bot.id}/tasks`, {
        text: 'CANCEL_TEST',
        conversationId: cc.id,
        nonce: randomUUID(),
      })
    ).body;
    await waitFor(async () => {
      const v = (await host.call(`/bots/${bot.id}/overview`)).body;
      return v.runs.find((r) => r.id === cr.id && r.partialText);
    }, 'streaming partial');
    assert.equal((await host.call(`/bots/${bot.id}/runs/${cr.id}/cancel`, {})).status, 200);
    await waitFor(async () => {
      const v = (await host.call(`/bots/${bot.id}/overview`)).body;
      return v.runs.find((r) => r.id === cr.id && r.state === 'cancelled');
    }, 'cancellation settlement');
    const backup = await host.call('/backup', {});
    assert.equal(backup.status, 200);
    assert.ok(existsSync(join(backup.body.path, 'product.sqlite')));
    // Kill during active response; restart must preserve history and never resubmit.
    const interrupted = (
      await host.call(`/bots/${bot.id}/tasks`, {
        text: 'CANCEL_TEST interrupt',
        conversationId: cc.id,
        nonce: randomUUID(),
      })
    ).body;
    await waitFor(async () => {
      const v = (await host.call(`/bots/${bot.id}/overview`)).body;
      return v.runs.find((r) => r.id === interrupted.id && r.partialText);
    }, 'active run before crash');
    host.child.kill('SIGKILL');
    await new Promise((r) => host.child.once('exit', r));
    const count = provider.requests.length;
    host = await startHost(data, 14318);
    await host.call('/auth/login', {
      name: 'synthetic-test',
      password: 'Synthetic-only-password-2026',
    });
    const recovered = (await host.call(`/bots/${bot.id}/overview`)).body;
    assert.equal(recovered.runs.find((r) => r.id === interrupted.id).state, 'interrupted');
    assert.equal(provider.requests.length, count);
    assert.equal(
      (await host.call(`/bots/${bot.id}/conversations/${conversation.id}/history`)).body.length,
      h.length,
    );
    t.diagnostic(
      `Synthetic HTTP/Pi workflow data: ${data}; provider requests: ${provider.requests.length}. No real model/Docker behavior established.`,
    );
  },
);
test('durable scheduler deduplication, overlap and timezone semantics', { skip: !enabled }, () => {
  const data = mkdtempSync(join(tmpdir(), 'bot-workshop-scheduler-'));
  const store = new Store(data);
  const product = new Product(store);
  store.put('bot', { id: 'bot', role: 'synthetic', capabilities: [], retired: false });
  const r = product.routine('bot', {
    name: 'Synthetic routine',
    task: 'Synthetic task',
    cron: '0 9 * * 1-5',
    timezone: 'America/Toronto',
  });
  product.tick(r.nextAt);
  product.tick(r.nextAt);
  assert.equal(store.list('occurrence').length, 1);
  assert.equal(store.list('run').length, 1);
  const next = store.get(r.id).nextAt;
  product.tick(next);
  assert.equal(store.list('run').length, 1);
  assert.equal(store.list('occurrence').at(-1).state, 'skipped_overlap');
  assert.equal(
    new Date(
      nextOccurrence('0 9 * * *', 'America/Toronto', Date.parse('2026-11-01T00:00Z')),
    ).toISOString(),
    '2026-11-01T14:00:00.000Z',
  );
  store.close();
});
