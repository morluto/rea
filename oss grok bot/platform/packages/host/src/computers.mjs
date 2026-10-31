import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, id, Failure } from './store.mjs';
import { ComputerSnapshots } from './computer-snapshots.mjs';
import { ComputerImage, IMAGE } from './computer-image.mjs';
const exec = promisify(execFile);
export { IMAGE };
const limits = [
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges',
  '--pids-limit=256',
  '--log-opt=max-size=10m',
  '--log-opt=max-file=2',
];
export class Computers {
  constructor(store, vault) {
    this.store = store;
    this.vault = vault;
    this.busy = new Set();
    this.viewers = new Map();
    this.cleanups = new Map();
    this.ticking = false;
    this.nextIdleCheck = 0;
    this.snapshots = new ComputerSnapshots(this);
    this.image = new ComputerImage(this);
    this.healthObservation = null;
    this.healthPending = null;
    this.engineStartPending = null;
    const installed =
      process.env.LOCALAPPDATA &&
      join(process.env.LOCALAPPDATA, 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe');
    this.binary =
      process.env.WORKSHOP_DOCKER_BIN ||
      (installed && existsSync(installed) ? installed : 'docker');
    this.distro = this.cliDistro();
  }
  cliDistro() {
    const fromEnv = process.env.WORKSHOP_DOCKER_DISTRO;
    if (fromEnv) return this.validDistro(fromEnv);
    try {
      const parsed = JSON.parse(readFileSync(join(this.store.root, 'docker-cli.json'), 'utf8'));
      return this.validDistro(parsed?.distro);
    } catch {
      return null;
    }
  }
  validDistro(value) {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
      ? value
      : null;
  }
  async run(file, args, options = {}) {
    try {
      return (
        await exec(file, args, {
          windowsHide: true,
          timeout: 120000,
          maxBuffer: 2 * 1024 * 1024,
          ...options,
        })
      ).stdout.trim();
    } catch (e) {
      const kind =
        e.code === 'ABORT_ERR'
          ? 'cancelled'
          : e.code === 'ENOENT'
            ? 'cli_missing'
            : e.killed
              ? 'timeout'
              : 'engine_error';
      const error = new Failure(
        'computer_unavailable',
        {
          cli_missing:
            'Docker CLI was not found on the primary computer. Configure its installed Docker executable, then retry.',
          timeout:
            'Docker did not respond before the check timed out. Start the Linux engine on the primary computer, then retry. Registry login does not establish engine readiness.',
          engine_error:
            'Docker could not complete the operation. Check the selected Linux engine on the primary computer, then retry. Existing computer resources are retained.',
          cancelled:
            'The host stopped this Docker CLI request. Docker may already be starting; check readiness before retrying.',
        }[kind],
        409,
      );
      error.dockerFailure = kind;
      throw error;
    }
  }
  docker(args, options = {}) {
    if (!this.distro) return this.run(this.binary, args, options);
    return this.run(
      'wsl.exe',
      ['-d', this.distro, '-u', 'root', '--', 'docker', ...args],
      options,
    );
  }
  wsl(args, options = {}) {
    return this.run('wsl.exe', ['-d', this.distro, '-u', 'root', '--', ...args], options);
  }
  async health() {
    if (this.healthPending) return this.healthPending;
    if (this.healthObservation?.refreshAfter > Date.now()) return this.healthObservation;
    this.healthPending = this.inspectHealth()
      .then((value) => {
        const observedAt = Date.now();
        this.healthObservation = { ...value, observedAt, refreshAfter: observedAt + 5000 };
        return this.healthObservation;
      })
      .finally(() => {
        this.healthPending = null;
      });
    return this.healthPending;
  }
  async startEngine() {
    if (this.stopping)
      fail('busy', 'The primary host is stopping. No start request was submitted.', 409);
    if (process.platform !== 'win32')
      fail(
        'unsupported',
        this.distro
          ? 'The Docker CLI engine is started from the Windows primary host.'
          : 'This start action uses the installed Docker Desktop CLI on Windows.',
        409,
      );
    if (this.engineStartPending) return this.engineStartPending;
    const controller = new AbortController();
    this.engineStartAbort = controller;
    this.engineStartPending = (async () => {
      // A running CLI engine is left alone. `service docker start` restarts dockerd.
      if (this.distro && (await this.inspectHealth()).available) {
        this.healthObservation = null;
        return { commandResult: 'already running', ...(await this.health()) };
      }
      const commandResult = this.distro
        ? await this.wsl(['service', 'docker', 'start'], {
            timeout: 25000,
            signal: controller.signal,
          })
        : await this.docker(['desktop', 'start', '--timeout', '20'], {
            timeout: 25000,
            signal: controller.signal,
          });
      // Successful startup submission is separate from a usable Linux daemon.
      if (this.healthPending) await this.healthPending;
      if (this.stopping)
        fail(
          'busy',
          'Host stopped after requesting startup. Docker may still be starting; check readiness when the host returns.',
          409,
        );
      this.healthObservation = null;
      return { commandResult, ...(await this.health()) };
    })().finally(() => {
      this.engineStartPending = null;
      this.engineStartAbort = null;
    });
    return this.engineStartPending;
  }
  async inspectHealth() {
    try {
      const info = JSON.parse(
        await this.docker(['info', '--format', '{{json .}}'], { timeout: 10000 }),
      );
      const unavailable = { available: false, image: null, imageReady: false, recipe: IMAGE };
      if (
        !info ||
        typeof info !== 'object' ||
        Array.isArray(info) ||
        (info.OSType !== undefined && typeof info.OSType !== 'string') ||
        (info.ServerVersion !== undefined && typeof info.ServerVersion !== 'string') ||
        (info.ServerErrors != null &&
          (!Array.isArray(info.ServerErrors) ||
            !info.ServerErrors.every((value) => typeof value === 'string')))
      )
        return {
          ...unavailable,
          state: 'unknown',
          reason:
            'Docker returned an unrecognized engine status. Check the primary computer, then retry.',
        };
      const reported = { os: info.OSType, serverVersion: info.ServerVersion };
      // Docker's formatted-info command can exit zero with an empty server DTO
      // and ServerErrors. Exit status alone does not prove a healthy daemon.
      if (info.ServerErrors?.length)
        return {
          ...unavailable,
          ...reported,
          state: 'engine_error',
          reason: info.ServerErrors.join(' '),
          errors: info.ServerErrors,
        };
      if (info.OSType !== 'linux')
        return {
          ...unavailable,
          ...reported,
          state: info.OSType === 'windows' ? 'wrong_os' : 'unknown',
          reason:
            info.OSType === 'windows'
              ? 'The selected Docker engine is not Linux. Select a Linux engine on the primary computer, then retry.'
              : 'Docker did not identify its operating system. Check the engine on the primary computer, then retry.',
        };
      let image = null;
      try {
        image = JSON.parse(await this.docker(['image', 'inspect', IMAGE], { timeout: 10000 }))[0]
          .Id;
      } catch {}
      return {
        available: true,
        state: 'ready',
        ...reported,
        image,
        imageReady: !!image,
        recipe: IMAGE,
      };
    } catch (e) {
      return { available: false, state: e.dockerFailure ?? 'unknown', reason: e.message };
    }
  }
  record(botId) {
    let c = this.store.list('computer', botId)[0];
    if (!c)
      c = this.store.put('computer', {
        id: id(),
        botId,
        generation: 1,
        state: 'unprovisioned',
        desired: 'stopped',
        controller: 'agent',
        leaseSession: null,
        resourceName: `bot-workshop-${botId}-g1`,
        volumes: [`bot-workshop-${botId}-g1-home`, `bot-workshop-${botId}-g1-workspace`],
        containerId: null,
        secretRef: null,
        idlePauseSeconds: 300,
        idleStopSeconds: 1800,
        lastUsedAt: Date.now(),
      });
    return c;
  }
  public(c) {
    return { ...c, secretRef: undefined, guestPort: undefined };
  }
  installation() {
    return this.store.get('installation', 'installation').value;
  }
  labels(c, role = 'desktop') {
    return [
      '--label',
      `workshop.installation=${this.installation()}`,
      '--label',
      `workshop.bot=${c.botId}`,
      '--label',
      `workshop.generation=${c.generation}`,
      '--label',
      `workshop.role=${role}`,
    ];
  }
  async owned(c, name = c.resourceName) {
    const data = JSON.parse(await this.docker(['inspect', name]))[0],
      labels = data.Config?.Labels ?? {};
    if (
      labels['workshop.installation'] !== this.installation() ||
      labels['workshop.bot'] !== c.botId ||
      labels['workshop.generation'] !== String(c.generation)
    )
      fail(
        'ownership_unknown',
        'Container ownership or generation does not match. No action taken.',
        409,
      );
    return data;
  }
  async volume(c, name) {
    const present = await this.docker([
      'volume',
      'ls',
      '--filter',
      `name=^${name}$`,
      '--format',
      '{{.Name}}',
    ]);
    if (present) {
      const v = JSON.parse(await this.docker(['volume', 'inspect', name]))[0];
      if (
        v.Labels?.['workshop.installation'] !== this.installation() ||
        v.Labels?.['workshop.bot'] !== c.botId ||
        v.Labels?.['workshop.generation'] !== String(c.generation)
      )
        fail('ownership_unknown', 'Persistent volume ownership is unresolved.', 409);
    } else await this.docker(['volume', 'create', ...this.labels(c, 'volume'), name]);
  }
  mounts(c, ro = false) {
    return c.volumes.flatMap((name, i) => [
      '-v',
      `${name}:/home/bot${i ? '/workspace' : ''}${ro ? ':ro' : ''}`,
    ]);
  }
  async lock(botId, fn) {
    if (this.busy.has(botId)) fail('busy', 'Computer operation already in progress', 409);
    this.busy.add(botId);
    try {
      return await fn();
    } finally {
      this.busy.delete(botId);
    }
  }
  changed(c, patch) {
    const next = this.store.put('computer', { ...this.record(c.botId), ...patch });
    this.store.event(c.botId, null, 'computer.state_changed', {
      id: next.id,
      state: next.state,
      generation: next.generation,
    });
    return next;
  }
  touch(botId) {
    const c = this.record(botId);
    return this.store.put('computer', { ...c, lastUsedAt: Date.now() });
  }
  async start(botId) {
    return this.lock(botId, () => this.startLocked(botId));
  }
  async startLocked(botId) {
    let c = this.record(botId);
    if (c.controller === 'human' && c.state !== 'ready')
      fail('human_control', 'Release the human lease before restarting this computer', 409);
    try {
      c = this.changed(c, {
        state: 'starting',
        desired: 'running',
        error: null,
        lastUsedAt: Date.now(),
      });
      if (c.containerId) {
        const info = await this.owned(c);
        if (info.State.Paused) await this.docker(['unpause', c.resourceName]);
        else if (!info.State.Running) await this.docker(['start', c.resourceName]);
      } else {
        const secret = randomBytes(24).toString('hex');
        c = this.store.put('computer', { ...c, secretRef: this.vault.save(secret) });
        for (const v of c.volumes) await this.volume(c, v);
        c = this.store.put('computer', {
          ...c,
          state: 'provisioning',
          containerId: 'pending-inspection',
        });
        const cid = await this.docker([
          'create',
          '--name',
          c.resourceName,
          ...this.labels(c),
          ...limits,
          '--cap-add=SETUID',
          '--cap-add=SETGID',
          '--cap-add=KILL',
          '--memory=1536m',
          '--cpus=1.5',
          '--shm-size=256m',
          '-p',
          '127.0.0.1::6080',
          ...this.mounts(c),
          '-e',
          `GUEST_TOKEN=${secret}`,
          c.restoreImageId ?? IMAGE,
        ]);
        c = this.store.put('computer', { ...c, containerId: cid });
        await this.docker(['start', c.resourceName]);
      }
      const info = await this.owned(c),
        port = info.NetworkSettings.Ports?.['6080/tcp']?.[0]?.HostPort;
      if (!port) fail('computer_unavailable', 'Guest port is not available', 409);
      c = this.store.put('computer', {
        ...c,
        containerId: info.Id,
        guestPort: Number(port),
        imageId: info.Image,
      });
      let health;
      for (let n = 0; n < 40; n++) {
        try {
          health = await this.guest(c, '/health');
          if (health.display && health.transport) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!health?.display || !health?.transport)
        fail(
          'computer_unavailable',
          'The container started but its Linux display or private viewer transport is not ready. Inspect its logs.',
          409,
        );
      if (c.controller === 'agent') await this.guest(c, '/resume', {});
      return this.changed(c, {
        state: 'ready',
        observedAt: Date.now(),
        health,
        lastUsedAt: Date.now(),
      });
    } catch (e) {
      this.changed(c, { state: 'failed', error: e.message });
      throw e;
    }
  }
  async ensure(botId) {
    let c = this.record(botId);
    if (c.controller !== 'agent')
      fail('human_control', 'Human control pauses agent capture and input', 409);
    if (c.state !== 'ready') c = await this.start(botId);
    if (this.busy.has(botId)) fail('busy', 'Computer lifecycle operation in progress', 409);
    this.touch(botId);
    return c;
  }
  async guest(c, path, body, signal) {
    if (!c.guestPort) fail('computer_unavailable', 'Start this Bot’s computer first', 409);
    const response = await fetch(`http://127.0.0.1:${c.guestPort}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${this.vault.read(c.secretRef)}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
    }).catch(() => fail('computer_unavailable', 'Guest supervisor is unreachable', 409));
    const value = await response.json();
    if (!response.ok)
      fail(value.tag ?? 'computer_unavailable', value.message ?? 'Guest operation failed', 409);
    return value;
  }
  closeViewers(botId) {
    for (const ws of this.viewers.get(botId) ?? []) ws.close(1000, 'Control changed');
    this.viewers.delete(botId);
  }
  async helper(c, role, args) {
    const job = this.store.put('computer_job', {
      id: id(),
      botId: c.botId,
      generation: c.generation,
      resourceName: `bot-workshop-${role}-${id()}`,
      role,
      state: 'creating',
    });
    try {
      await this.docker([
        'create',
        '--name',
        job.resourceName,
        ...this.labels(c, role),
        ...limits,
        '--user',
        '1000:1000',
        '--memory=512m',
        '--cpus=1',
        '--network=none',
        ...args,
      ]);
      return this.store.put('computer_job', { ...job, state: 'created' });
    } catch (e) {
      this.store.put('computer_job', { ...job, state: 'cleanup_incomplete' });
      throw e;
    }
  }
  async cleanup(job) {
    if (this.cleanups.has(job.id)) return this.cleanups.get(job.id);
    const work = (async () => {
      try {
        const names = await this.docker([
          'ps',
          '-a',
          '--filter',
          `name=^${job.resourceName}$`,
          '--format',
          '{{.Names}}',
        ]);
        if (names) {
          await this.owned(job, job.resourceName);
          await this.docker(['rm', '--force', job.resourceName]);
        }
        this.store.put('computer_job', {
          ...this.store.get(job.id, 'computer_job'),
          state: 'removed',
        });
      } catch (e) {
        this.store.put('computer_job', {
          ...this.store.get(job.id, 'computer_job'),
          state: 'cleanup_incomplete',
        });
        throw e;
      }
    })();
    this.cleanups.set(job.id, work);
    try {
      return await work;
    } finally {
      this.cleanups.delete(job.id);
    }
  }
  async quiesce(c) {
    for (const job of this.store.list('computer_job', c.botId).filter((j) => j.state !== 'removed'))
      await this.cleanup(job);
  }
  async control(botId, session, human) {
    return this.lock(botId, async () => {
      let c = this.record(botId);
      await this.owned(c);
      if (c.controller === 'human' && c.leaseSession !== session)
        fail('lease_conflict', 'Another session holds control', 409);
      await this.quiesce(c);
      await this.guest(c, human ? '/quiesce' : '/resume', {});
      this.closeViewers(botId);
      c = this.changed(c, {
        controller: human ? 'human' : 'agent',
        leaseSession: human ? session : null,
        reobserveRequired: !human,
        lastUsedAt: Date.now(),
      });
      this.store.event(botId, null, 'control.transferred', {
        controller: c.controller,
        generation: c.generation,
      });
      return c;
    });
  }
  async observe(botId) {
    const c = await this.ensure(botId);
    await this.owned(c);
    const value = await this.guest(c, '/screen');
    this.store.put('computer', { ...this.record(botId), reobserveRequired: false });
    return value;
  }
  async input(botId, args, signal) {
    let c = await this.ensure(botId);
    await this.owned(c);
    if (c.reobserveRequired) {
      await this.observe(botId);
      c = this.record(botId);
    }
    return this.guest(c, '/input', args, signal);
  }
  async command(botId, command, signal) {
    const c = await this.ensure(botId);
    if (typeof command !== 'string' || command.length > 32000)
      fail('invalid_input', 'Command must be at most 32000 characters');
    if (c.volumes.length !== 2)
      fail(
        'migration_required',
        'Recreate this pre-0.2 computer with a separate workspace volume before running commands',
        409,
      );
    const job = await this.lock(botId, async () => {
      const current = this.record(botId);
      if (
        current.controller !== 'agent' ||
        current.generation !== c.generation ||
        current.state !== 'ready'
      )
        fail('human_control', 'Computer authority changed before job admission', 409);
      return this.helper(c, 'job', [
        '--read-only',
        '--tmpfs',
        '/tmp:rw,nosuid,size=128m',
        '-v',
        `${c.volumes[1]}:/home/bot/workspace`,
        '-w',
        '/home/bot/workspace',
        '--entrypoint',
        '/bin/bash',
        c.imageId,
        '-lc',
        command,
      ]);
    });
    let output = '',
      exitCode = null,
      truncated = false,
      timedOut = false,
      cleanup;
    const cancel = () => {
      cleanup ??= this.cleanup(job);
      cleanup.catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (signal?.aborted) fail('cancelled', 'Command cancelled before dispatch', 409);
      this.store.put('computer_job', { ...job, state: 'running' });
      try {
        const r = await exec(this.binary, ['start', '--attach', job.resourceName], {
          windowsHide: true,
          timeout: 60000,
          maxBuffer: 262144,
        });
        output = r.stdout;
        exitCode = 0;
      } catch (e) {
        output = (e.stdout ?? '') + (e.stderr ?? '');
        exitCode = typeof e.code === 'number' ? e.code : null;
        truncated = e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        timedOut = !!e.killed;
      }
      if (signal?.aborted) fail('cancelled', 'Command cancelled', 409);
      return {
        jobId: job.id,
        exitCode,
        output: output.slice(0, 262144),
        truncated,
        timedOut,
        workspace:
          'Bot-owned shared workspace; isolated job container; no desktop or browser profile access',
      };
    } finally {
      signal?.removeEventListener('abort', cancel);
      await (cleanup ?? this.cleanup(job));
      this.touch(botId);
    }
  }
  async suspendLocked(botId, pause) {
    const c = this.record(botId);
    if (c.controller === 'human')
      fail('human_control', 'Hand back human control before pausing or stopping', 409);
    await this.quiesce(c);
    const info = await this.owned(c);
    this.closeViewers(botId);
    if (pause) {
      if (info.State.Running && !info.State.Paused) {
        await this.guest(c, '/quiesce', {});
        await this.docker(['pause', c.resourceName]);
      }
    } else {
      if (info.State.Paused) await this.docker(['unpause', c.resourceName]);
      if (info.State.Running) await this.docker(['stop', '--time', '10', c.resourceName]);
    }
    return this.changed(c, {
      state: pause ? 'paused' : 'stopped',
      desired: pause ? 'paused' : 'stopped',
      leaseSession: null,
      controller: 'agent',
    });
  }
  async stop(botId) {
    return this.lock(botId, () => this.suspendLocked(botId, false));
  }
  async pause(botId) {
    return this.lock(botId, () => this.suspendLocked(botId, true));
  }
  requireGeneration(c, expectedGeneration) {
    if (c.generation !== expectedGeneration)
      fail('stale_generation', 'Inspect the current computer generation before continuing', 409);
    if (c.controller === 'human')
      fail('human_control', 'Hand back control before replacing this computer', 409);
  }
  replaceGeneration(old, reason, patch = {}) {
    const current = this.record(old.botId);
    this.requireGeneration(current, old.generation);
    const generation = current.generation + 1;
    // The coordinator owns every generation transition. Retain the exact old
    // identity before allocating anything under the new one.
    return this.store.tx(() => {
      const previous = this.store.put('computer_generation', {
        ...current,
        id: id(),
        retainedReason: reason,
        retainedAt: Date.now(),
      });
      const next = this.store.put('computer', {
        ...current,
        previousGenerationId: previous.id,
        generation,
        resourceName: `bot-workshop-${old.botId}-g${generation}`,
        volumes: [
          `bot-workshop-${old.botId}-g${generation}-home`,
          `bot-workshop-${old.botId}-g${generation}-workspace`,
        ],
        containerId: null,
        secretRef: null,
        guestPort: null,
        imageId: null,
        restoreImageId: null,
        restoredFrom: null,
        health: null,
        controller: 'agent',
        leaseSession: null,
        state: 'unprovisioned',
        desired: 'stopped',
        error: null,
        reobserveRequired: true,
        ...patch,
      });
      this.store.event(old.botId, null, 'computer.generation_replaced', {
        previous: current.generation,
        generation,
        reason,
      });
      return next;
    });
  }
  reset(botId, expectedGeneration) {
    return this.lock(botId, async () => {
      const old = this.record(botId);
      this.requireGeneration(old, expectedGeneration);
      if (old.containerId) await this.suspendLocked(botId, false);
      else await this.quiesce(old);
      return this.replaceGeneration(old, 'User reset: old home/browser/workspace retained');
    });
  }
  updateImage(botId, expectedGeneration) {
    return this.lock(botId, async () => {
      const old = this.record(botId);
      this.requireGeneration(old, expectedGeneration);
      const image = JSON.parse(await this.docker(['image', 'inspect', IMAGE]))[0];
      if (!image?.Id || image.Os !== 'linux')
        fail('computer_unavailable', 'Build the supported Linux desktop image first', 409);
      // Snapshot and generation replacement share one lease. Agent jobs cannot
      // resume between the durable backup and restoring its new image.
      const snapshot = await this.snapshots.createLocked(botId);
      return this.snapshots.restoreLocked(botId, snapshot.id, expectedGeneration, image.Id);
    });
  }
  removeGeneration(botId, generationId) {
    return this.lock(botId, () => this.removeGenerationLocked(botId, generationId));
  }
  async removeGenerationLocked(botId, generationId) {
    let retained = this.store.get(generationId, 'computer_generation');
    if (retained.botId !== botId || retained.generation >= this.record(botId).generation)
      fail('not_authorized', 'Choose a retained generation owned by this Bot', 403);
    if (retained.state === 'unbound_after_restore')
      fail(
        'ownership_unknown',
        'This restored record belongs to the original installation. Clean it up from that original workspace.',
        409,
      );
    if (retained.state === 'removed') return retained;
    try {
      for (const job of this.store
        .list('computer_job', botId)
        .filter((j) => j.generation === retained.generation && j.state !== 'removed'))
        await this.cleanup(job);
      const container = await this.docker([
        'ps',
        '-a',
        '--filter',
        `name=^${retained.resourceName}$`,
        '--format',
        '{{.Names}}',
      ]);
      if (container) await this.owned(retained);
      const present = [];
      for (const name of retained.volumes) {
        const found = await this.docker([
          'volume',
          'ls',
          '--filter',
          `name=^${name}$`,
          '--format',
          '{{.Name}}',
        ]);
        if (!found) continue;
        const volume = JSON.parse(await this.docker(['volume', 'inspect', name]))[0];
        if (
          volume.Name !== name ||
          volume.Labels?.['workshop.installation'] !== this.installation() ||
          volume.Labels?.['workshop.bot'] !== botId ||
          volume.Labels?.['workshop.generation'] !== String(retained.generation)
        )
          fail(
            'ownership_unknown',
            'Retained volume ownership does not match; desktop and volume deletion refused.',
            409,
          );
        present.push(name);
      }
      // Validate every present desktop/volume before removing any of them.
      if (container) await this.docker(['rm', '--force', retained.resourceName]);
      for (const name of present) await this.docker(['volume', 'rm', name]);
      retained = this.store.put('computer_generation', {
        ...retained,
        state: 'removed',
        removedAt: Date.now(),
        error: null,
      });
      this.store.event(botId, null, 'computer.generation_removed', {
        generation: retained.generation,
      });
      return retained;
    } catch (error) {
      this.store.put('computer_generation', {
        ...retained,
        state: 'cleanup_incomplete',
        error: error.message,
      });
      throw error;
    }
  }
  removeComputer(botId, expectedGeneration) {
    return this.lock(botId, async () => {
      const old = this.record(botId);
      this.requireGeneration(old, expectedGeneration);
      this.closeViewers(botId);
      // Transfer ownership to a durable retained record before attempting
      // deletion, including partial provisioning with no container handshake.
      const next = this.replaceGeneration(old, 'User removal of computer and persistent volumes');
      await this.removeGenerationLocked(botId, next.previousGenerationId);
      return this.record(botId);
    });
  }
  configure(botId, input) {
    const c = this.record(botId),
      { idlePauseSeconds, idleStopSeconds } = input;
    if (
      !Number.isInteger(idlePauseSeconds) ||
      idlePauseSeconds < 30 ||
      !Number.isInteger(idleStopSeconds) ||
      idleStopSeconds < idlePauseSeconds ||
      idleStopSeconds > 604800
    )
      fail(
        'invalid_input',
        'Idle pause must be at least 30 seconds; stop must be between pause and 7 days',
      );
    return this.store.put('computer', { ...c, idlePauseSeconds, idleStopSeconds });
  }
  async tick() {
    if (this.stopping || this.ticking || Date.now() < this.nextIdleCheck) return;
    this.nextIdleCheck = Date.now() + 10000;
    this.ticking = true;
    try {
      for (const c of this.store.list('computer')) {
        if (this.stopping) break;
        if (
          !['ready', 'paused'].includes(c.state) ||
          c.controller === 'human' ||
          this.busy.has(c.botId)
        )
          continue;
        const active = this.store
          .list('run', c.botId)
          .some((r) =>
            ['preparing', 'running', 'waiting_approval', 'waiting_child', 'cancelling'].includes(
              r.state,
            ),
          );
        if (active || this.viewers.get(c.botId)?.size) {
          this.touch(c.botId);
          continue;
        }
        const age = (Date.now() - (c.lastUsedAt ?? Date.now())) / 1000;
        try {
          if (age >= (c.idleStopSeconds ?? 1800)) await this.stop(c.botId);
          else if (c.state === 'ready' && age >= (c.idlePauseSeconds ?? 300))
            await this.pause(c.botId);
        } catch (e) {
          this.store.event(c.botId, null, 'computer.idle_failed', {
            tag: e.tag ?? 'operation_failed',
          });
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  async drain() {
    this.stopping = true;
    this.engineStartAbort?.abort();
    await this.engineStartPending?.catch(() => {});
    await this.image.stop();
    while (this.ticking || this.busy.size) await new Promise((r) => setTimeout(r, 50));
  }
  snapshot(botId) {
    return this.snapshots.create(botId);
  }
  restore(botId, snapshotId, expectedGeneration) {
    return this.snapshots.restore(botId, snapshotId, expectedGeneration);
  }
}
