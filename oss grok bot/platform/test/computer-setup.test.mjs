import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, id } from '../packages/host/src/store.mjs';
import { Computers } from '../packages/host/src/computers.mjs';
import { startHost, stopHost } from './support.mjs';

function fixture(t) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'bot-workshop-setup-')));
  store.put('installation', { id: 'installation', value: id() });
  t.after(() => store.close());
  return new Computers(store, null);
}
test('Docker failures preserve actionable identity and distinguish timeout, absent CLI and wrong engine', async (t) => {
  const m = fixture(t);
  m.binary = join(m.store.root, 'absent-docker');
  assert.equal((await m.inspectHealth()).state, 'cli_missing');
  m.binary = process.execPath;
  await assert.rejects(
    m.docker(['--version'], { signal: AbortSignal.abort() }),
    (e) => e.dockerFailure === 'cancelled',
  );
  await assert.rejects(m.docker(['-e', 'setTimeout(() => {}, 10000)'], { timeout: 100 }), (e) => {
    assert.equal(e.tag, 'computer_unavailable');
    assert.equal(e.dockerFailure, 'timeout');
    assert.match(e.message, /did not respond/);
    return true;
  });
  m.docker = async (args) => (args[0] === 'info' ? JSON.stringify({ OSType: 'windows' }) : '[]');
  const wrong = await m.inspectHealth();
  assert.equal(wrong.available, false);
  assert.equal(wrong.state, 'wrong_os');
  assert.match(wrong.reason, /not Linux/);
  m.docker = async (args) => (args[0] === 'info' ? '{}' : '[]');
  assert.equal((await m.inspectHealth()).state, 'unknown');
});
test('infrastructure polling shares a bounded observation and retries after expiry', async (t) => {
  const m = fixture(t);
  let calls = 0,
    release;
  m.inspectHealth = async () => {
    calls++;
    await new Promise((r) => (release = r));
    return { available: false, reason: 'Fixture engine absent' };
  };
  const observations = Array.from({ length: 20 }, () => m.health());
  assert.equal(calls, 1);
  release();
  const results = await Promise.all(observations);
  assert.ok(results.every((r) => r === results[0]));
  assert.ok(results[0].observedAt <= Date.now());
  assert.equal(results[0].refreshAfter - results[0].observedAt, 5000);
  await m.health();
  assert.equal(calls, 1);
  m.healthObservation.refreshAfter = 0;
  const retry = m.health();
  release();
  await retry;
  assert.equal(calls, 2);
});

test('formatted Docker info can exit zero while reporting a daemon startup error', async (t) => {
  const m = fixture(t),
    calls = [];
  m.docker = async (args) => {
    calls.push(args);
    return JSON.stringify({
      OSType: '',
      ServerVersion: '',
      ServerErrors: ['Error response from daemon: Docker Desktop is unable to start'],
    });
  };
  const observed = await m.inspectHealth();
  assert.equal(observed.available, false);
  assert.equal(observed.state, 'engine_error');
  assert.match(observed.reason, /Docker Desktop is unable to start/);
  assert.equal(calls.length, 1, 'Unavailable engines must not trigger a second image inspection');
  for (const value of [null, [], { ServerErrors: [{}] }]) {
    m.docker = async () => JSON.stringify(value);
    const unknown = await m.inspectHealth();
    assert.equal(unknown.available, false);
    assert.equal(unknown.state, 'unknown');
    assert.match(unknown.reason, /unrecognized/);
  }
});
test(
  'CLI start shares submission and reports actual engine readiness rather than startup text',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const m = fixture(t);
    let starts = 0,
      release;
    m.docker = async (args) => {
      assert.deepEqual(args, ['desktop', 'start', '--timeout', '20']);
      starts++;
      await new Promise((r) => {
        release = r;
      });
      return 'Docker Desktop is already running';
    };
    m.healthObservation = { available: true, refreshAfter: Date.now() + 5000 };
    m.inspectHealth = async () => ({
      available: false,
      state: 'timeout',
      reason: 'Fixture engine still unresponsive',
    });
    const first = m.startEngine(),
      second = m.startEngine();
    release();
    const results = await Promise.all([first, second]);
    assert.equal(starts, 1);
    assert.equal(results[0].available, false);
    assert.equal(results[1].state, 'timeout');
    assert.equal(m.engineStartPending, null);
    m.docker = async (_args, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Error('Fixture start aborted')), {
          once: true,
        });
      });
    const active = m.startEngine();
    const rejected = assert.rejects(active, /Fixture start aborted/);
    await m.drain();
    await rejected;
    assert.equal(m.engineStartPending, null);
    await assert.rejects(m.startEngine(), /host is stopping/);
  },
);
test(
  'a recorded WSL distro starts the Docker CLI service and does not call Docker Desktop',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const m = fixture(t);
    m.distro = 'Ubuntu-24.04';
    const calls = [];
    m.wsl = async (args, options) => {
      calls.push(args);
      assert.equal(options.signal.aborted, false);
      return 'docker start/running';
    };
    m.docker = async () => {
      throw new Error('Docker Desktop CLI must not be used');
    };
    let checks = 0;
    m.inspectHealth = async () => {
      checks += 1;
      const ready = checks > 1;
      return { available: ready, state: ready ? 'ready' : 'engine_error' };
    };
    const started = await m.startEngine();
    assert.deepEqual(calls, [['service', 'docker', 'start']]);
    assert.equal(started.available, true);
    assert.equal(started.commandResult, 'docker start/running');
    const again = await m.startEngine();
    assert.deepEqual(calls, [['service', 'docker', 'start']]);
    assert.equal(again.commandResult, 'already running');
    delete m.inspectHealth;
    delete m.docker;
    m.run = async (file, args) => {
      assert.equal(file, 'wsl.exe');
      assert.equal(args[0], '-d');
      assert.equal(args[1], 'Ubuntu-24.04');
      assert.equal(args[5], 'docker');
      if (args[6] === 'image') throw new Error('missing image');
      assert.equal(args[6], 'info');
      return JSON.stringify({ OSType: 'linux', ServerVersion: '29.1.3' });
    };
    const observed = await m.inspectHealth();
    assert.equal(observed.available, true);
    assert.equal(observed.imageReady, false);
  },
);
test('image preparation durably accepts once, supports cancellation before submission and records unavailable engine', async (t) => {
  const m = fixture(t);
  let release;
  m.health = () => new Promise((r) => (release = r));
  const accepted = m.image.start('fixture-owner');
  assert.equal(accepted.state, 'building');
  assert.throws(() => m.image.start('fixture-owner'), /already active/);
  m.image.cancel();
  release({ available: true });
  await m.image.pending;
  assert.equal(m.image.status().state, 'cancelled');
  m.health = async () => ({ available: false, reason: 'Fixture engine unavailable' });
  m.image.start('fixture-owner');
  await m.image.pending;
  assert.equal(m.image.status().state, 'failed');
  assert.match(m.image.status().message, /Fixture engine unavailable/);
  m.health = async () => ({ available: true });
  let contextStarted;
  const contextPending = new Promise((r) => (contextStarted = r));
  m.docker = async () => {
    contextStarted();
    return new Promise((r) => (release = r));
  };
  m.image.start('fixture-owner');
  await contextPending;
  m.image.cancel();
  release(JSON.stringify('npipe:////./pipe/fixture-engine'));
  await m.image.pending;
  assert.equal(m.image.status().state, 'cancelled');
  assert.equal(readdirSync(m.store.root).includes('computer-recipes'), false);
});
test('image build submits only bundled bytes with isolated config; process failure and restart stay explicit', async (t) => {
  const m = fixture(t);
  m.health = async () => ({ available: true });
  // A real child process fails on Docker arguments; this is not a Docker-success fixture.
  m.binary = process.execPath;
  m.docker = async () => JSON.stringify('npipe:////./pipe/fixture-engine');
  const accepted = m.image.start('fixture-owner');
  await m.image.pending;
  assert.equal(m.image.status().state, 'failed');
  assert.match(m.image.status().message, /did not complete/);
  const folder = join(m.store.root, 'computer-recipes', accepted.recipeDigest);
  assert.deepEqual(readdirSync(folder).sort(), ['Dockerfile', 'supervisor.py', 'transport.py']);
  assert.match(readFileSync(join(folder, 'Dockerfile'), 'utf8'), /COPY transport.py/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(m.store.root, 'computer-build-config/config.json'), 'utf8')).auths,
    {},
  );
  m.store.put('computer_image_build', { id: id(), state: 'building', startedAt: Date.now() });
  const restarted = new Computers(m.store, null);
  assert.equal(restarted.image.status().state, 'interrupted_unknown');
});

test('image setup HTTP routes require the workspace owner and expose the actual failure receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-workshop-setup-http-'));
  const previous = process.env.WORKSHOP_DOCKER_BIN;
  process.env.WORKSHOP_DOCKER_BIN = join(root, 'intentionally-absent-docker');
  let host;
  try {
    host = await startHost(root, 14346);
  } finally {
    if (previous === undefined) delete process.env.WORKSHOP_DOCKER_BIN;
    else process.env.WORKSHOP_DOCKER_BIN = previous;
  }
  try {
    assert.equal((await host.call('/docker/prepare', {})).status, 401);
    assert.equal((await host.call('/docker/start', {})).status, 401);
    await host.call('/auth/setup', { name: 'setup-owner', password: 'Synthetic-setup-owner-2026' });
    const invite = (await host.call('/invites', {})).body;
    const joinResult = await host.call('/auth/join', {
      token: invite.token,
      name: 'setup-member',
      password: 'Synthetic-setup-member-2026',
    });
    assert.ok(joinResult.status < 300, JSON.stringify(joinResult.body));
    await host.call('/auth/login', {
      name: 'setup-member',
      password: 'Synthetic-setup-member-2026',
    });
    assert.equal((await host.call('/docker/prepare', {})).status, 403);
    assert.equal((await host.call('/docker/start', {})).status, 403);
    await host.call('/auth/login', { name: 'setup-owner', password: 'Synthetic-setup-owner-2026' });
    const accepted = await host.call('/docker/prepare', {});
    assert.equal(accepted.status, 202);
    let state;
    for (let n = 0; n < 20; n++) {
      state = (await host.call('/docker')).body;
      if (state.build?.state === 'failed') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(state.build.id, accepted.body.id);
    assert.equal(state.build.state, 'failed');
    assert.equal(state.available, false);
    assert.equal(state.canPrepare, true);
  } finally {
    await stopHost(host);
  }
});
