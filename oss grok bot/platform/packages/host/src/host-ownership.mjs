import net from 'node:net';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fail } from './store.mjs';
// Acquire OS ownership BEFORE opening SQLite or reconciling any run. PID files
// cannot establish ownership after a crash/PID reuse. Windows named pipes and
// Linux abstract sockets disappear with their owning process.
export async function acquireHost(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(root),
    key = createHash('sha256')
      .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
      .digest('hex')
      .slice(0, 32);
  const path =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\bot-workshop-${key}`
      : process.platform === 'linux'
        ? `\0bot-workshop-${key}`
        : join(canonical, '.host-owner.sock');
  const owner = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    owner.once('error', reject);
    owner.listen({ path, exclusive: true }, resolve);
  }).catch(() =>
    fail(
      'host_already_owned',
      'Another host owns this data root, or OS ownership could not be established. No database was opened or reconciled. On macOS inspect a stale .host-owner.sock after a crash before removing it.',
      409,
    ),
  );
  return {
    path,
    close: () => new Promise((resolve, reject) => owner.close((e) => (e ? reject(e) : resolve()))),
  };
}
