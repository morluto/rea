import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, id } from '../packages/host/src/store.mjs';
import { Vault } from '../packages/host/src/security.mjs';
import { Computers } from '../packages/host/src/computers.mjs';
import { waitFor } from './support.mjs';
test(
  'REAL DOCKER: per-Bot desktop, lease, detached job cleanup, cancellation, pause and snapshot restore',
  { skip: process.env.WORKSHOP_DOCKER_TEST !== '1', timeout: 240000 },
  async (t) => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'bot-workshop-computer-')));
    const installation = id();
    store.put('installation', { id: 'installation', value: installation });
    const manager = new Computers(store, new Vault(store));
    const botId = id();
    store.put('bot', { id: botId, ownerId: id(), capabilities: ['computer'] });
    let admitted = false;
    t.after(async () => {
      try {
        if (admitted) {
          if (manager.record(botId).controller === 'human')
            await manager.control(botId, 'synthetic-human-session', false);
          await manager.removeComputer(botId, manager.record(botId).generation);
          for (const retained of store
            .list('computer_generation', botId)
            .filter((c) => c.state !== 'removed'))
            await manager.removeGeneration(botId, retained.id);
        }
      } finally {
        store.close();
      }
    });
    const health = await manager.health();
    assert.equal(health.available, true, JSON.stringify(health));
    assert.equal(
      health.imageReady,
      true,
      'Build the exact computer recipe before this explicitly enabled live test',
    );
    admitted = true;
    let c = await manager.start(botId);
    assert.equal(c.state, 'ready');
    assert.equal(c.health.transport, true);
    const inspect = await manager.owned(c);
    assert.equal(inspect.HostConfig.Privileged, false);
    assert.ok(inspect.Mounts.every((v) => v.Type === 'volume'));
    assert.equal(inspect.HostConfig.PortBindings['6080/tcp'][0].HostIp, '127.0.0.1');
    const capture = await manager.observe(botId);
    assert.equal(
      Buffer.from(capture.base64, 'base64').subarray(0, 8).toString('hex'),
      '89504e470d0a1a0a',
    );
    assert.equal(
      (await manager.command(botId, 'printf before-snapshot > persistent.txt')).exitCode,
      0,
    );
    await manager.command(
      botId,
      "setsid bash -c 'sleep 2; printf escaped > escaped.txt' >/dev/null 2>&1 &",
    );
    assert.equal((await manager.command(botId, 'sleep 3; test ! -e escaped.txt')).exitCode, 0);
    const cancel = new AbortController();
    const pending = manager.command(botId, 'sleep 30', cancel.signal);
    await waitFor(
      () => store.list('computer_job', botId).find((j) => j.state === 'running'),
      'owned command running',
    );
    cancel.abort();
    await assert.rejects(pending, (e) => e.tag === 'cancelled');
    assert.ok(store.list('computer_job', botId).every((j) => j.state === 'removed'));
    await manager.control(botId, 'synthetic-human-session', true);
    await assert.rejects(manager.observe(botId), (e) => e.tag === 'human_control');
    await assert.rejects(manager.command(botId, 'echo denied'), (e) => e.tag === 'human_control');
    await assert.rejects(manager.stop(botId), (e) => e.tag === 'human_control');
    await manager.control(botId, 'synthetic-human-session', false);
    assert.equal(manager.record(botId).reobserveRequired, true);
    await manager.observe(botId);
    assert.equal(manager.record(botId).reobserveRequired, false);
    await manager.pause(botId);
    assert.equal((await manager.owned(manager.record(botId))).State.Paused, true);
    await manager.start(botId);
    assert.equal((await manager.owned(manager.record(botId))).State.Paused, false);
    const snapshot = await manager.snapshot(botId);
    assert.equal(snapshot.state, 'ready');
    await manager.start(botId);
    await manager.command(botId, 'printf after-snapshot > persistent.txt');
    const oldGeneration = manager.record(botId).generation;
    await manager.restore(botId, snapshot.id, oldGeneration);
    c = await manager.start(botId);
    assert.equal(c.generation, oldGeneration + 1);
    assert.match((await manager.command(botId, 'cat persistent.txt')).output, /before-snapshot/);
    assert.equal(store.list('computer_generation').length, 1);
    await assert.rejects(
      manager.owned({ ...c, botId: id() }),
      (e) => e.tag === 'ownership_unknown',
    );
    const beforeUpdate = manager.record(botId).generation;
    await manager.updateImage(botId, beforeUpdate);
    c = await manager.start(botId);
    assert.equal(c.generation, beforeUpdate + 1);
    assert.match((await manager.command(botId, 'cat persistent.txt')).output, /before-snapshot/);
    await manager.reset(botId, c.generation);
    c = await manager.start(botId);
    assert.equal((await manager.command(botId, 'test ! -e persistent.txt')).exitCode, 0);
    await manager.removeComputer(botId, c.generation);
    assert.equal(manager.record(botId).containerId, null);
    assert.equal(
      store.get(manager.record(botId).previousGenerationId, 'computer_generation').state,
      'removed',
    );
  },
);
