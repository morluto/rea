import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fail, id } from './store.mjs';

export const IMAGE = 'bot-workshop-desktop:0.2';
const recipeFiles = ['Dockerfile', 'supervisor.py', 'transport.py'];
const active = (r) => ['building', 'cancelling'].includes(r.state);

// One host-owned image build. Product tasks never receive a host shell/build tool.
export class ComputerImage {
  constructor(computers) {
    this.computers = computers;
    this.store = computers.store;
    this.pending = null;
    this.child = null;
    this.current = null;
    for (const r of this.store.list('computer_image_build').filter(active))
      this.store.put('computer_image_build', {
        ...r,
        state: 'interrupted_unknown',
        finishedAt: Date.now(),
        message:
          'Host stopped before build completion was observed. Inspect the engine before retrying; build cache may remain.',
      });
  }
  status() {
    return (
      this.current ??
      this.store.list('computer_image_build').sort((a, b) => b.createdAt - a.createdAt)[0] ??
      null
    );
  }
  start(accountId) {
    if (this.pending || this.computers.stopping)
      fail('busy', 'An image build is already active or the host is stopping', 409);
    const source = resolve(import.meta.dirname, '../../../computer');
    const files = recipeFiles.map((name) => [name, readFileSync(join(source, name))]);
    const hash = createHash('sha256');
    for (const [name, bytes] of files) hash.update(name).update('\0').update(bytes).update('\0');
    const recipeDigest = hash.digest('hex');
    const r = (this.current = this.store.put('computer_image_build', {
      id: id(),
      accountId,
      recipe: IMAGE,
      recipeDigest,
      state: 'building',
      log: '',
      startedAt: Date.now(),
      message:
        'Checking the Linux engine. Only the bundled public recipe is sent to Docker; no workspace files or registry credentials.',
    }));
    this.pending = this.run(r, files).finally(() => {
      this.pending = null;
      this.child = null;
      this.computers.healthObservation = null;
    });
    return r;
  }
  save(r, patch) {
    Object.assign(r, patch);
    const saved = this.store.put('computer_image_build', r);
    Object.assign(r, saved);
    return saved;
  }
  async run(r, files) {
    try {
      const m = this.computers;
      const health = await m.health();
      if (!health.available)
        throw Error(health.reason ?? 'Start a Linux Docker engine before preparing computers.');
      if (this.status().state === 'cancelling')
        return this.save(r, {
          state: 'cancelled',
          finishedAt: Date.now(),
          message: 'Cancelled before submitting a build.',
        });
      // Inspect endpoint metadata only. Never copy the user's Docker config/credential store.
      const endpoint = JSON.parse(
        await m.docker(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], {
          timeout: 10000,
        }),
      );
      if (r.state === 'cancelling')
        return this.save(r, {
          state: 'cancelled',
          finishedAt: Date.now(),
          message: 'Cancelled before submitting a build.',
        });
      if (typeof endpoint !== 'string' || !/^(unix:\/\/\/|npipe:\/\/\/\/\.\/pipe\/)/.test(endpoint))
        throw Error(
          'Image preparation currently requires a local Unix-socket or Windows named-pipe engine context.',
        );
      const folder = join(this.store.root, 'computer-recipes', r.recipeDigest);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      for (const [name, bytes] of files) writeFileSync(join(folder, name), bytes);
      const config = join(this.store.root, 'computer-build-config');
      mkdirSync(config, { recursive: true, mode: 0o700 });
      const plugins = resolve(dirname(m.binary), '../cli-plugins');
      writeFileSync(
        join(config, 'config.json'),
        JSON.stringify({
          auths: {},
          ...(existsSync(plugins) ? { cliPluginsExtraDirs: [plugins] } : {}),
        }),
      );
      const env = Object.fromEntries(
        [
          'PATH',
          'SystemRoot',
          'WINDIR',
          'COMSPEC',
          'PATHEXT',
          'HOME',
          'USERPROFILE',
          'LOCALAPPDATA',
          'APPDATA',
          'TEMP',
          'TMP',
        ]
          .filter((k) => process.env[k])
          .map((k) => [k, process.env[k]]),
      );
      Object.assign(env, { DOCKER_CONFIG: config, DOCKER_HOST: endpoint, DOCKER_BUILDKIT: '1' });
      this.save(r, {
        message:
          'Building the bundled Linux image. First preparation downloads packages and may take several minutes.',
      });
      const child = (this.child = spawn(
        m.binary,
        [
          '--config',
          config,
          '--host',
          endpoint,
          'build',
          '--load',
          '--progress=plain',
          '--label',
          `workshop.recipe=${r.recipeDigest}`,
          '--label',
          `workshop.installation=${m.installation()}`,
          '--tag',
          IMAGE,
          folder,
        ],
        { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      ));
      let lastSave = 0;
      const append = (bytes) => {
        r.log = (r.log + bytes.toString('utf8').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')).slice(
          -65536,
        );
        if (Date.now() - lastSave > 500) {
          this.save(r, {});
          lastSave = Date.now();
        }
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const timeout = setTimeout(() => this.cancel(), 30 * 60000);
      let exit;
      try {
        exit = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => resolve({ code, signal }));
        });
      } finally {
        clearTimeout(timeout);
        this.child = null;
      }
      if (r.state === 'cancelling' || this.status().state === 'cancelling')
        return this.save(r, {
          state: 'cancelled_unknown',
          finishedAt: Date.now(),
          ...exit,
          message:
            'Build client stopped. The engine may retain build work/cache; refresh infrastructure before retrying. Existing Bot volumes were not changed.',
        });
      if (exit.code !== 0)
        throw Error(
          'Docker did not complete the image build. Review the build output and engine state.',
        );
      const image = JSON.parse(await m.docker(['image', 'inspect', IMAGE], { timeout: 10000 }))[0];
      if (
        image.Os !== 'linux' ||
        image.Config?.Labels?.['workshop.recipe'] !== r.recipeDigest ||
        !image.Id
      )
        throw Error('Built image identity did not match the submitted recipe.');
      return this.save(r, {
        state: 'ready',
        finishedAt: Date.now(),
        imageId: image.Id,
        message:
          'Linux image built and identity verified. Start a Bot computer to check its actual desktop and viewer.',
      });
    } catch (e) {
      return this.save(r, { state: 'failed', finishedAt: Date.now(), message: e.message });
    }
  }
  cancel() {
    const r = this.status();
    if (!r || !active(r)) return r;
    const next = this.save(r, {
      state: 'cancelling',
      message: 'Stopping the build client; engine completion remains unknown until inspected.',
    });
    this.child?.kill('SIGTERM');
    return next;
  }
  async stop() {
    if (this.pending) {
      this.cancel();
      await this.pending;
    }
  }
}
