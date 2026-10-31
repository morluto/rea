import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Coding } from '../packages/host/src/coding.mjs';
import { Store, id } from '../packages/host/src/store.mjs';
import { startHost, stopHost } from './support.mjs';

test('public coding handoff uses CLI receipts, fixed project/worktree, ownership and idempotency', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-coding-http-'));
  const projectRoot = join(root, 'orbit');
  mkdirSync(projectRoot);
  const host = await startHost(join(root, 'data'), 14356);
  try {
    assert.equal((await host.call('/coding/config')).status, 401);
    await host.call('/auth/setup', {
      name: 'Synthetic coding owner',
      password: 'Synthetic-coding-only-2026',
    });
    const configured = await host.call('/coding/config', {
      enabled: true,
      executable: process.execPath,
      entrypoint: resolve('test/fixtures/coding-cli.mjs'),
      projectRoot,
      baseRef: 'main',
    });
    assert.equal(configured.status, 200);
    const createBot = async () =>
      (
        await host.call('/bots', {
          name: 'Synthetic coder',
          purpose: 'Verify handoffs',
          role: 'Use synthetic fixtures only.',
          capabilities: ['coding'],
        })
      ).body;
    const bot = await createBot(),
      other = await createBot();
    const conversation = (
      await host.call('/bots/' + bot.id + '/conversations', { name: 'Coding return fixture' })
    ).body;
    const input = {
      title: 'Fixture task',
      task: 'Write a synthetic report.',
      nonce: id(),
      conversationId: conversation.id,
    };
    const started = await host.call('/bots/' + bot.id + '/coding', input);
    assert.equal(started.status, 202);
    assert.equal(started.body.threadId, 'synthetic-thread');
    assert.equal(started.body.state, 'completed');
    assert.equal(started.body.branch, 'orbit/' + bot.id + '/' + started.body.id);
    assert.equal((await host.call('/bots/' + bot.id + '/coding', input)).body.id, started.body.id);
    assert.equal((await host.call('/bots/' + bot.id + '/coding')).body.length, 1);
    for (let attempt = 0; attempt < 30; attempt++) {
      const tasks = (await host.call('/bots/' + bot.id + '/overview')).body.codingTasks;
      if (tasks[0]?.result) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      (await host.call('/bots/' + bot.id + '/overview')).body.codingTasks[0].result,
      'Synthetic coding result.',
    );
    assert.equal(
      (await host.call('/notifications')).body.filter((value) => value.kind === 'coding').length,
      1,
    );
    const path = '/bots/' + bot.id + '/coding/' + started.body.id;
    assert.equal(
      (await host.call(path + '/inspect', {})).body.messages[0].text,
      'Synthetic coding result.',
    );
    assert.equal(
      (await host.call('/bots/' + other.id + '/coding/' + started.body.id + '/inspect', {})).status,
      403,
    );
    const follow = { message: 'Explain your checks.', nonce: id() };
    const sent = await host.call(path + '/send', follow);
    assert.equal(sent.body.state, 'accepted');
    assert.equal((await host.call(path + '/send', follow)).body.id, sent.body.id);
    const invalid = await host.call('/coding/config', { ...configured.body, projectRoot: root });
    assert.equal(invalid.status, 400);
  } finally {
    await stopHost(host);
  }
});

test('uncertain coding dispatch retains receipt, reconciles without redispatch and rejects changed identity', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'orbit-coding-owner-')));
  store.put('installation', { id: 'installation', value: id() });
  const bot = store.put('bot', { id: id(), capabilities: ['coding'] });
  store.put('coding_config', {
    id: 'coding-config',
    enabled: true,
    projectRoot: 'fixture-orbit',
    baseRef: 'main',
  });
  let starts = 0,
    unavailable = true,
    branch;
  const coding = new Coding(store, async (_config, args) => {
    if (args[1] === 'start') {
      starts++;
      branch = args[args.indexOf('--branch') + 1];
      return { threadId: 'fixture', projectId: 'project' };
    }
    if (unavailable) throw Error('Synthetic unavailable response');
    return {
      thread: {
        threadId: 'fixture',
        projectId: 'project',
        title: 'Fixture',
        status: 'completed',
        branch,
      },
      messages: [],
    };
  });
  try {
    const input = { title: 'Fixture', task: 'Synthetic task.', nonce: id() };
    await assert.rejects(coding.start(bot.id, input));
    const pending = coding.list(bot.id)[0];
    assert.equal(pending.state, 'unknown');
    assert.equal(pending.threadId, 'fixture');
    await coding.start(bot.id, input);
    assert.equal(starts, 1);
    unavailable = false;
    assert.equal((await coding.inspect(bot.id, pending.id)).task.state, 'completed');
    assert.equal(starts, 1);
    store.put('installation', { id: 'installation', value: id() });
    await assert.rejects(
      coding.send(bot.id, pending.id, { message: 'No adoption after restore', nonce: id() }),
      (error) => error.tag === 'coding_identity',
    );
    store.put('bot', { ...bot, capabilities: [] });
    await assert.rejects(
      coding.start(bot.id, { ...input, nonce: id() }),
      (error) => error.tag === 'not_authorized',
    );
  } finally {
    store.db.close();
  }
});

test('coding monitor deduplicates durable returns across restart and waits for a fresh follow-up turn', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'orbit-coding-return-')));
  const installation = id(),
    bot = store.put('bot', { id: id(), ownerId: id(), capabilities: ['coding'] });
  store.put('installation', { id: 'installation', value: installation });
  store.put('coding_config', { id: 'coding-config', enabled: true, projectRoot: 'fixture-orbit' });
  const task = store.put('coding_task', {
    id: id(),
    botId: bot.id,
    installation,
    projectRoot: 'fixture-orbit',
    branch: 'fixture-branch',
    threadId: 'fixture-thread',
    projectId: 'fixture-project',
    title: 'Synthetic monitor',
    state: 'running',
    cycle: 0,
  });
  let calls = 0,
    runId = 'fixture-run-1',
    unavailable = false;
  const invoke = async (_config, args) => {
    calls++;
    if (unavailable) throw Error('Synthetic transport unavailable');
    if (args[1] === 'send') return { accepted: true };
    return {
      thread: {
        threadId: task.threadId,
        projectId: task.projectId,
        branch: task.branch,
        status: 'completed',
        title: task.title,
      },
      messages: [{ role: 'assistant', runId, text: 'Synthetic result.' }],
    };
  };
  const first = new Coding(store, invoke);
  try {
    await first.monitor();
    assert.equal(store.get(task.id, 'coding_task').result, 'Synthetic result.');
    assert.equal(store.list('notification').length, 1);
    const readCount = calls;
    await first.monitor(Date.now() + 60000);
    assert.equal(calls, readCount, 'delivered terminal tasks do not poll forever');
    const restarted = new Coding(store, invoke);
    await restarted.monitor(Date.now() + 60000);
    assert.equal(store.list('notification').length, 1);
    await restarted.send(bot.id, task.id, { message: 'Follow up', nonce: id() });
    await restarted.monitor();
    assert.equal(
      store.list('notification').length,
      1,
      'old terminal turn is not replayed after send',
    );
    const now = Date.now() + 20000;
    unavailable = true;
    await restarted.monitor(now);
    assert.match(store.get(task.id, 'coding_task').monitorError, /unavailable/);
    unavailable = false;
    runId = 'fixture-run-2';
    await restarted.monitor(now + 60001);
    assert.equal(store.list('notification').length, 2);
    assert.equal(store.get(task.id, 'coding_task').deliveredCycle, 1);
    await restarted.stop();
  } finally {
    await first.stop();
    store.close();
  }
});

test('host shutdown drains an in-flight coding read without publishing a late completion', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'orbit-coding-stop-'))),
    installation = id();
  const bot = store.put('bot', { id: id(), ownerId: id(), capabilities: ['coding'] });
  store.put('installation', { id: 'installation', value: installation });
  store.put('coding_config', { id: 'coding-config', enabled: true, projectRoot: 'fixture-orbit' });
  const task = store.put('coding_task', {
    id: id(),
    botId: bot.id,
    installation,
    projectRoot: 'fixture-orbit',
    branch: 'stop-branch',
    threadId: 'stop-thread',
    projectId: 'stop-project',
    title: 'Stop fixture',
    state: 'running',
    cycle: 0,
  });
  let entered, release;
  const started = new Promise((resolve) => (entered = resolve));
  const coding = new Coding(store, async () => {
    entered();
    return new Promise((resolve) => (release = resolve));
  });
  try {
    coding.monitor();
    await started;
    const stopping = coding.stop();
    release({
      thread: {
        threadId: task.threadId,
        projectId: task.projectId,
        title: task.title,
        branch: task.branch,
        status: 'completed',
      },
      messages: [{ role: 'assistant', text: 'Late fixture result' }],
    });
    await stopping;
    assert.equal(store.list('notification').length, 0);
    assert.equal(store.get(task.id, 'coding_task').result, undefined);
    assert.equal(coding.monitor(Date.now() + 60000), null);
  } finally {
    await coding.stop();
    store.close();
  }
});
