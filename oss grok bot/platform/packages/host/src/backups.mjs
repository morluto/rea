import {
  mkdirSync,
  existsSync,
  cpSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fail } from './store.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function files(root, dir = root) {
  const result = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (lstatSync(path).isSymbolicLink())
      fail('unsupported_backup', 'Symbolic links are not part of product backup scope');
    if (statSync(path).isDirectory()) result.push(...files(root, path));
    else
      result.push({
        path: relative(root, path).split(sep).join('/'),
        bytes: statSync(path).size,
        sha256: sha(readFileSync(path)),
      });
  }
  return result;
}
export function createBackup(store) {
  const folder = join(store.root, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(folder, { recursive: true });
  store.db.exec(`VACUUM INTO '${join(folder, 'product.sqlite').replaceAll("'", "''")}'`);
  for (const name of ['artifacts', 'sessions', 'computer-snapshots', 'vault.key'])
    if (existsSync(join(store.root, name)))
      cpSync(join(store.root, name), join(folder, name), { recursive: true });
  const manifest = {
    schemaVersion: 1,
    at: Date.now(),
    sourceRoot: store.root,
    sourcePlatform: process.platform,
    sessions: Object.fromEntries(
      store
        .list('conversation')
        .filter((c) => c.sessionFile)
        .map((c) => [c.id, relative(store.root, c.sessionFile).split(sep).join('/')]),
    ),
    scope: [
      'product database',
      'canonical Pi sessions',
      'artifact bytes',
      'vault key',
      'completed computer snapshot archives',
    ],
    excluded: ['Live Docker home/browser volumes', 'external device files'],
    files: files(folder),
  };
  writeFileSync(join(folder, 'backup.json'), JSON.stringify(manifest, null, 2));
  return { path: folder, ...manifest };
}
export function inspectBackup(folder) {
  folder = resolve(folder);
  if (lstatSync(folder).isSymbolicLink()) fail('invalid_backup', 'Use an actual backup directory');
  const manifest = JSON.parse(readFileSync(join(folder, 'backup.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files))
    fail('unsupported_backup', 'Unsupported backup manifest');
  for (const f of manifest.files) {
    const path = resolve(folder, f.path);
    const rel = relative(realpathSync(folder), realpathSync(path));
    if (isAbsolute(rel) || rel.startsWith('..') || lstatSync(path).isSymbolicLink())
      fail('invalid_backup', 'Backup manifest escapes its root');
    const bytes = readFileSync(path);
    if (bytes.length !== f.bytes || sha(bytes) !== f.sha256)
      fail('invalid_backup', `Backup integrity check failed: ${f.path}`);
  }
  if (
    !manifest.files.some((f) => f.path === 'product.sqlite') ||
    !manifest.files.some((f) => f.path === 'vault.key')
  )
    fail('invalid_backup', 'Database and vault key are required');
  const db = new DatabaseSync(join(folder, 'product.sqlite'), { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    if (Object.values(integrity)[0] !== 'ok')
      fail('invalid_backup', 'SQLite integrity check failed');
    if (db.prepare('PRAGMA user_version').get().user_version > 1)
      fail('unsupported_backup', 'Backup schema is newer than this app');
  } finally {
    db.close();
  }
  return manifest;
}
export function restoreToNewRoot(folder, destination) {
  folder = resolve(folder);
  destination = resolve(destination);
  const manifest = inspectBackup(folder);
  if (existsSync(destination))
    fail(
      'destination_exists',
      'Restore requires a new, empty destination path; existing data is never overwritten',
      409,
    );
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const f of manifest.files) {
    const target = join(destination, f.path);
    mkdirSync(resolve(target, '..'), { recursive: true });
    cpSync(join(folder, f.path), target);
  }
  const db = new DatabaseSync(join(destination, 'product.sqlite'));
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const row of db.prepare('SELECT id,kind,data FROM records').all()) {
      const value = JSON.parse(row.data);
      if (row.kind === 'conversation' && value.sessionFile) {
        const rel = manifest.sessions?.[value.id];
        if (typeof rel !== 'string') fail('invalid_backup', 'Canonical session mapping is missing');
        if (isAbsolute(rel) || rel.startsWith('..'))
          fail('invalid_backup', 'Canonical session reference escapes source backup root');
        value.sessionFile = join(destination, rel);
      }
      // Restored compute/pairing identities are observations of the old host,
      // never authority to stop/adopt resources on a different installation.
      if (row.kind === 'installation') value.value = randomUUID();
      if (row.kind === 'computer')
        Object.assign(value, {
          state: 'restored_unbound',
          desired: 'stopped',
          containerId: null,
          guestPort: null,
          restoredIdentity: {
            resourceName: value.resourceName,
            generation: value.generation,
            volumes: value.volumes,
          },
          resourceName: `bot-workshop-${value.botId}-restore-${value.generation + 1}`,
          volumes: [
            `bot-workshop-${value.botId}-restore-${value.generation + 1}-home`,
            `bot-workshop-${value.botId}-restore-${value.generation + 1}-workspace`,
          ],
          generation: value.generation + 1,
        });
      if (row.kind === 'computer_snapshot' && value.file)
        value.file = join(destination, 'computer-snapshots', value.id + '.tar.gz');
      if (['computer_job', 'computer_generation'].includes(row.kind))
        Object.assign(value, {
          state: 'restored_unbound',
          originInstallation: 'backup; no authority on current engine',
        });
      if (row.kind === 'computer_generation') value.state = 'unbound_after_restore';
      if (row.kind === 'device') Object.assign(value, { state: 'revoked', secretRef: null });
      if (row.kind === 'auth_session') value.expiresAt = 0;
      if (row.kind === 'routine')
        Object.assign(value, { enabled: false, state: 'paused_after_restore' });
      if (row.kind === 'trigger') value.enabled = false;
      if (row.kind === 'remote_config') value.enabled = false;
      if (row.kind === 'coding_config') value.enabled = false;
      if (row.kind === 'reminder' && value.state === 'scheduled')
        value.state = 'paused_after_restore';
      if (row.kind === 'remote_client') value.state = 'revoked';
      if (row.kind === 'remote_pair') value.state = 'expired';
      if (row.kind === 'model' && value.authMode === 'chatgpt') {
        // Restore creates a new installation/agent-host identity. Its plan grant
        // must be authorized for that host rather than silently attributed to the old one.
        if (value.secretRef) db.prepare('DELETE FROM secrets WHERE id=?').run(value.secretRef);
        Object.assign(value, {
          secretRef: null,
          oauthState: 'reconnect_after_restore',
          connection: 'unverified',
          receipt: null,
          generation: (value.generation ?? 0) + 1,
        });
      }
      if (
        row.kind === 'run' &&
        !['settled', 'failed', 'cancelled', 'interrupted'].includes(value.state)
      )
        Object.assign(value, {
          state: 'interrupted',
          outcome: 'unknown',
          reason: 'Restored backup: explicit reconciliation is required before continuing.',
        });
      db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(value), row.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.close();
  }
  return {
    destination,
    sourceBackup: folder,
    files: manifest.files.length,
    compute: 'unbound; original Docker resources untouched',
    schedules: 'paused; explicit resume required',
    sessions: 'expired; sign in again',
  };
}
