import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, createReadStream, createWriteStream, statSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fail, id } from './store.mjs';
export class ComputerSnapshots {
  constructor(computers) {
    this.computers = computers;
    this.store = computers.store;
  }
  async transfer(job, file, writing) {
    const child = spawn(
      this.computers.binary,
      ['start', '--attach', ...(writing ? [] : ['--interactive']), job.resourceName],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0
          ? resolve()
          : reject(
              Error(
                `Snapshot archive helper failed (exit ${code}): ${stderrTail || 'no guest output'}`.slice(
                  0,
                  2048,
                ),
              ),
            ),
      );
    });
    completion.catch(() => {});
    let stderrTail = '';
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4096);
    });
    const timer = setTimeout(() => child.kill(), 120000);
    try {
      if (writing) {
        let bytes = 0;
        const cap = new Transform({
          transform(chunk, _, done) {
            bytes += chunk.length;
            done(
              bytes > 2 * 1024 ** 3 ? Error('Snapshot exceeds 2 GiB archive limit') : null,
              chunk,
            );
          },
        });
        child.stdin.end();
        await pipeline(child.stdout, cap, createWriteStream(file, { flags: 'wx' }));
      } else {
        child.stdout.resume();
        await pipeline(createReadStream(file), child.stdin);
      }
      await completion;
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
    }
  }
  async digest(file) {
    const h = createHash('sha256');
    for await (const chunk of createReadStream(file)) h.update(chunk);
    return h.digest('hex');
  }
  create(botId) {
    return this.computers.lock(botId, () => this.createLocked(botId));
  }
  async createLocked(botId) {
    const m = this.computers;
    let c = m.record(botId);
    if (!c.containerId)
      fail('computer_unavailable', 'Provision the computer before taking a snapshot', 409);
    await m.suspendLocked(botId, false);
    c = m.record(botId);
    const snapshotId = id(),
      folder = join(this.store.root, 'computer-snapshots');
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `${snapshotId}.tar.gz`);
    let snapshot = this.store.put('computer_snapshot', {
      id: snapshotId,
      botId,
      generation: c.generation,
      state: 'creating',
      imageId: c.imageId,
      file,
      scope:
        'Stopped Linux home, browser profile and workspace, plus immutable base image identity. No RAM or external account authorization guarantee.',
    });
    let job;
    try {
      job = await m.helper(c, 'snapshot', [
        '--read-only',
        ...m.mounts(c, true),
        '--entrypoint',
        'tar',
        c.imageId,
        '-C',
        '/home',
        '-czf',
        '-',
        'bot',
      ]);
      await this.transfer(job, file, true);
      snapshot = this.store.put('computer_snapshot', {
        ...snapshot,
        state: 'ready',
        digest: await this.digest(file),
        bytes: statSync(file).size,
      });
      return snapshot;
    } catch (e) {
      this.store.put('computer_snapshot', { ...snapshot, state: 'failed' });
      throw e;
    } finally {
      if (job) await m.cleanup(job);
    }
  }
  restore(botId, snapshotId, expectedGeneration) {
    return this.computers.lock(botId, () =>
      this.restoreLocked(botId, snapshotId, expectedGeneration),
    );
  }
  async restoreLocked(botId, snapshotId, expectedGeneration, imageOverride = null) {
    const m = this.computers;
    const old = m.record(botId),
      s = this.store.get(snapshotId, 'computer_snapshot');
    m.requireGeneration(old, expectedGeneration);
    if (s.botId !== botId || s.state !== 'ready')
      fail('not_authorized', 'Select a ready snapshot owned by this Bot', 403);
    if ((await this.digest(s.file)) !== s.digest)
      fail('integrity_failed', 'Snapshot bytes changed; restore refused', 409);
    if (old.containerId) await m.suspendLocked(botId, false);
    let next = m.replaceGeneration(old, 'Snapshot restore: old home/browser/workspace retained', {
      state: 'restoring',
      restoreImageId: imageOverride ?? s.imageId,
    });
    let job;
    try {
      for (const v of next.volumes) await m.volume(next, v);
      job = await m.helper(next, 'restore', [
        '--read-only',
        '--interactive',
        ...m.mounts(next),
        '--entrypoint',
        'tar',
        next.restoreImageId,
        '-C',
        '/home',
        '--no-same-owner',
        '-xzf',
        '-',
      ]);
      await this.transfer(job, s.file, false);
      next = m.changed(next, {
        state: 'stopped',
        desired: 'stopped',
        restoredFrom: s.id,
        error: null,
      });
      return next;
    } catch (e) {
      m.changed(next, { state: 'failed', error: e.message });
      throw e;
    } finally {
      if (job) await m.cleanup(job);
    }
  }
}
