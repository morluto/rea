import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, id, fail } from '../packages/host/src/store.mjs';
import { Vault } from '../packages/host/src/security.mjs';
import { Computers } from '../packages/host/src/computers.mjs';
// Contract fixture only. These tests establish coordinator semantics, never Docker/display behavior.
class Fixture extends Computers {
  constructor(store, vault) {
    super(store, vault);
    this.calls = [];
    this.resources = new Map();
    this.volumes = new Map();
    this.removalFailure = null;
    this.gate = null;
  }
  async docker(args) {
    this.calls.push(args);
    const [op, name] = args;
    if (op === 'volume') {
      const target = args.at(-1);
      if (name === 'ls')
        return [...this.volumes.keys()].find((n) => args.includes(`name=^${n}$`)) ?? '';
      if (name === 'inspect') {
        const volume = this.volumes.get(target);
        if (!volume) fail('computer_unavailable', 'Fixture volume absent');
        return JSON.stringify([volume]);
      }
      if (name === 'rm') {
        if (target === this.removalFailure)
          fail('computer_unavailable', 'Fixture volume cleanup failed');
        this.volumes.delete(target);
        return target;
      }
    }
    if (op === 'image' && name === 'inspect')
      return JSON.stringify([{ Id: 'sha256:fixture-updated', Os: 'linux' }]);
    if (op === 'inspect') {
      const value = this.resources.get(name);
      if (!value) fail('computer_unavailable', 'Fixture resource missing');
      return JSON.stringify([value]);
    }
    if (op === 'ps')
      return [...this.resources.keys()].find((n) => args.includes(`name=^${n}$`)) ?? '';
    if (op === 'rm') {
      const target = args.at(-1);
      if (target === this.removalFailure) fail('computer_unavailable', 'Fixture cleanup failed');
      this.resources.delete(target);
      return target;
    }
    if (op === 'create') {
      await this.gate;
      const target = args[args.indexOf('--name') + 1],
        labels = Object.fromEntries(
          args.flatMap((s, i) => (s === '--label' ? [args[i + 1].split('=')] : [])),
        );
      this.resources.set(target, {
        Id: target,
        Config: { Labels: labels },
        State: { Running: false, Paused: false },
        Image: 'sha256:fixture',
        NetworkSettings: { Ports: { '6080/tcp': [{ HostPort: '19999' }] } },
      });
      return target;
    }
    const c = this.resources.get(op === 'stop' ? args.at(-1) : name);
    if (c && ['pause', 'unpause', 'start', 'stop'].includes(op)) {
      if (op === 'pause') c.State.Paused = true;
      if (op === 'unpause') c.State.Paused = false;
      if (op === 'start') c.State.Running = true;
      if (op === 'stop') c.State.Running = false;
      return name;
    }
    throw Error(`Unexpected fixture operation ${op}`);
  }
  async guest(c, path) {
    return path === '/health' ? { display: true, transport: true } : {};
  }
  ready(botId) {
    const c = this.record(botId),
      value = this.store.put('computer', {
        ...c,
        state: 'ready',
        containerId: c.resourceName,
        guestPort: 19999,
        secretRef: this.vault.save('fixture'),
        imageId: 'sha256:fixture',
        lastUsedAt: Date.now() - 100000,
      });
    for (const name of c.volumes)
      this.volumes.set(name, {
        Name: name,
        Labels: {
          'workshop.installation': this.installation(),
          'workshop.bot': botId,
          'workshop.generation': String(c.generation),
        },
      });
    this.resources.set(c.resourceName, {
      Id: c.resourceName,
      Image: 'sha256:fixture',
      Config: {
        Labels: {
          'workshop.installation': this.installation(),
          'workshop.bot': botId,
          'workshop.generation': String(c.generation),
        },
      },
      State: { Running: true, Paused: false },
      NetworkSettings: { Ports: { '6080/tcp': [{ HostPort: '19999' }] } },
    });
    return value;
  }
}
function fixture(t) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'bot-workshop-compute-contract-')));
  store.put('installation', { id: 'installation', value: id() });
  t.after(() => store.close());
  return new Fixture(store, new Vault(store));
}
test('computer coordinator preserves ownership and failed cleanup; takeover retries after mixed cleanup', async (t) => {
  const m = fixture(t),
    bot = id();
  const c = m.ready(bot);
  m.resources.get(c.resourceName).Config.Labels['workshop.bot'] = 'foreign';
  await assert.rejects(m.stop(bot), (e) => e.tag === 'ownership_unknown');
  assert.equal(
    m.calls.some((a) => a[0] === 'stop'),
    false,
  );
  m.resources.get(c.resourceName).Config.Labels['workshop.bot'] = bot;
  const a = await m.helper(c, 'job', ['--entrypoint', 'true', 'fixture']),
    b = await m.helper(c, 'job', ['--entrypoint', 'true', 'fixture']);
  m.removalFailure = b.resourceName;
  await assert.rejects(m.control(bot, 'human', true), (e) => e.tag === 'computer_unavailable');
  assert.equal(m.store.get(a.id, 'computer_job').state, 'removed');
  assert.equal(m.store.get(b.id, 'computer_job').state, 'cleanup_incomplete');
  assert.equal(m.record(bot).controller, 'agent');
  m.removalFailure = null;
  await m.control(bot, 'human', true);
  assert.equal(m.store.get(b.id, 'computer_job').state, 'removed');
  assert.equal(m.record(bot).controller, 'human');
  await assert.rejects(m.observe(bot), (e) => e.tag === 'human_control');
  await assert.rejects(m.stop(bot), (e) => e.tag === 'human_control');
  await m.control(bot, 'human', false);
  assert.equal(m.record(bot).reobserveRequired, true);
});

test('retained generation deletion validates all volumes and retries mixed cleanup without touching current computer', async (t) => {
  const m = fixture(t),
    bot = id(),
    old = m.ready(bot);
  await m.reset(bot, old.generation);
  const retained = m.store.list('computer_generation', bot)[0],
    current = m.ready(bot);
  m.volumes.get(old.volumes[1]).Labels['workshop.bot'] = 'foreign';
  await assert.rejects(m.removeGeneration(bot, retained.id), (e) => e.tag === 'ownership_unknown');
  assert.ok(m.resources.has(old.resourceName));
  assert.ok(m.volumes.has(old.volumes[0]));
  m.volumes.get(old.volumes[1]).Labels['workshop.bot'] = bot;
  m.removalFailure = old.volumes[1];
  await assert.rejects(
    m.removeGeneration(bot, retained.id),
    (e) => e.tag === 'computer_unavailable',
  );
  assert.equal(m.store.get(retained.id).state, 'cleanup_incomplete');
  assert.equal(m.resources.has(old.resourceName), false);
  assert.equal(m.volumes.has(old.volumes[0]), false);
  assert.equal(m.volumes.has(old.volumes[1]), true);
  assert.ok(m.resources.has(current.resourceName));
  assert.ok(m.volumes.has(current.volumes[0]));
  m.removalFailure = null;
  await m.removeGeneration(bot, retained.id);
  assert.equal(m.store.get(retained.id).state, 'removed');
  assert.equal(m.volumes.has(old.volumes[1]), false);
  const before = m.calls.length;
  await m.removeGeneration(bot, retained.id);
  assert.equal(m.calls.length, before);
  await assert.rejects(m.removeGeneration(id(), retained.id), (e) => e.tag === 'not_authorized');
});

test('explicit computer removal owns partial provisioning before cleanup and preserves failed volume identity', async (t) => {
  const m = fixture(t),
    bot = id(),
    old = m.ready(bot);
  // Simulate create's missing/late handshake: volumes exist, container does not.
  m.resources.delete(old.resourceName);
  m.store.put('computer', { ...old, containerId: 'pending-inspection', state: 'provisioning' });
  m.removalFailure = old.volumes[1];
  await assert.rejects(
    m.removeComputer(bot, old.generation),
    (e) => e.tag === 'computer_unavailable',
  );
  const next = m.record(bot),
    retained = m.store.get(next.previousGenerationId, 'computer_generation');
  assert.equal(next.generation, 2);
  assert.equal(next.containerId, null);
  assert.equal(retained.state, 'cleanup_incomplete');
  assert.equal(retained.resourceName, old.resourceName);
  assert.ok(m.volumes.has(old.volumes[1]));
  m.removalFailure = null;
  await m.removeGeneration(bot, retained.id);
  assert.equal(m.store.get(retained.id).state, 'removed');
  assert.equal(m.volumes.has(old.volumes[1]), false);
  m.store.put('computer_generation', { ...retained, state: 'unbound_after_restore' });
  const calls = m.calls.length;
  await assert.rejects(m.removeGeneration(bot, retained.id), (e) => e.tag === 'ownership_unknown');
  assert.equal(m.calls.length, calls);
});

test('reset and image update share generation ownership, keep host records and retain retryable resources', async (t) => {
  const m = fixture(t),
    bot = id(),
    old = m.ready(bot);
  m.store.put('memory', { id: 'retained-memory', botId: bot, content: 'Host-owned bytes' });
  await assert.rejects(m.reset(bot, old.generation + 1), (e) => e.tag === 'stale_generation');
  let next = await m.reset(bot, old.generation);
  assert.equal(next.generation, 2);
  assert.equal(next.containerId, null);
  assert.equal(next.health, null);
  const retained = m.store.list('computer_generation', bot)[0];
  assert.equal(retained.resourceName, old.resourceName);
  assert.equal(retained.state, 'stopped');
  assert.equal(m.resources.get(old.resourceName).State.Running, false);
  assert.equal(m.store.get('retained-memory').content, 'Host-owned bytes');
  m.store.put('computer', { ...next, controller: 'human' });
  await assert.rejects(m.reset(bot, 2), (e) => e.tag === 'human_control');
  m.store.put('computer', { ...next, controller: 'agent' });
  next = m.ready(bot);
  const job = await m.helper(next, 'job', ['--entrypoint', 'true', 'fixture']);
  m.removalFailure = job.resourceName;
  await assert.rejects(m.reset(bot, 2), (e) => e.tag === 'computer_unavailable');
  assert.equal(m.record(bot).generation, 2);
  assert.equal(m.store.get(job.id).state, 'cleanup_incomplete');
  m.removalFailure = null;
  await m.reset(bot, 2);
  assert.equal(m.record(bot).generation, 3);
  assert.equal(m.store.get(job.id).state, 'removed');
  m.ready(bot);
  m.volume = async () => {};
  let release, restoreStarted;
  const started = new Promise((r) => (restoreStarted = r)),
    gate = new Promise((r) => (release = r));
  m.snapshots.transfer = async (_job, file, writing) => {
    assert.equal(m.busy.has(bot), true);
    if (writing) writeFileSync(file, 'Synthetic archive fixture, not a Docker snapshot');
    else {
      restoreStarted();
      await gate;
    }
  };
  const update = m.updateImage(bot, 3);
  await started;
  await assert.rejects(m.reset(bot, m.record(bot).generation), (e) => e.tag === 'busy');
  release();
  next = await update;
  assert.equal(next.generation, 4);
  assert.equal(next.restoreImageId, 'sha256:fixture-updated');
  assert.equal(next.state, 'stopped');
  assert.equal(m.store.list('computer_snapshot', bot)[0].state, 'ready');
  assert.equal(m.store.list('computer_generation', bot).length, 3);
  assert.ok(m.calls.some((a) => a[0] === 'create' && a.includes('sha256:fixture-updated')));
});
test('computer lifecycle serializes late helper acquisition and idle suspension respects active ownership', async (t) => {
  const m = fixture(t),
    bot = id(),
    c = m.ready(bot);
  let release;
  m.gate = new Promise((r) => (release = r));
  const admission = m.lock(bot, () => m.helper(c, 'job', ['--entrypoint', 'true', 'fixture']));
  await assert.rejects(m.control(bot, 'human', true), (e) => e.tag === 'busy');
  release();
  const job = await admission;
  m.gate = null;
  await m.control(bot, 'human', true);
  assert.equal(m.store.get(job.id, 'computer_job').state, 'removed');
  assert.equal(m.record(bot).controller, 'human');
  m.nextIdleCheck = 0;
  await m.tick();
  assert.equal(m.record(bot).state, 'ready');
  await m.control(bot, 'human', false);
  m.configure(bot, { idlePauseSeconds: 30, idleStopSeconds: 60 });
  m.store.put('computer', { ...m.record(bot), lastUsedAt: Date.now() - 45000 });
  m.nextIdleCheck = 0;
  await m.tick();
  assert.equal(m.record(bot).state, 'paused');
  await m.start(bot);
  assert.equal(m.record(bot).state, 'ready');
  m.store.put('computer', { ...m.record(bot), lastUsedAt: Date.now() - 65000 });
  m.nextIdleCheck = 0;
  await m.tick();
  assert.equal(m.record(bot).state, 'stopped');
});
