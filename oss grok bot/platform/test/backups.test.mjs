import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../packages/host/src/store.mjs';
import { Vault } from '../packages/host/src/security.mjs';
import { Product } from '../packages/host/src/product.mjs';
import { createBackup, inspectBackup, restoreToNewRoot } from '../packages/host/src/backups.mjs';
test('verified product backup restores to a new root without adopting original live resources', () => {
  const root = mkdtempSync(join(tmpdir(), 'workshop-backup-source-')),
    store = new Store(root),
    vault = new Vault(store),
    product = new Product(store);
  store.put('installation', { id: 'installation', value: 'original-installation' });
  store.put('bot', { id: 'bot', ownerId: 'owner', name: 'Synthetic backup Bot' });
  store.put('auth_session', { id: 'auth', expiresAt: Date.now() + 100000 });
  store.put('routine', { id: 'routine', botId: 'bot', enabled: true });
  store.put('computer', {
    id: 'computer',
    botId: 'bot',
    resourceName: 'owned-original',
    generation: 1,
    volumes: ['owned-home'],
    containerId: 'original-container',
    state: 'ready',
  });
  store.put('remote_config', { id: 'remote-config', enabled: true });
  store.put('remote_client', { id: 'remote-client', state: 'paired' });
  store.put('remote_pair', { id: 'remote-pair', state: 'pending' });
  store.put('computer_generation', {
    id: 'retained-computer',
    botId: 'bot',
    generation: 0,
    resourceName: 'original-retained',
    containerId: 'retained-original-container',
    state: 'stopped',
  });
  const credential = vault.save('synthetic-secret-not-real');
  const planCredential = vault.save('synthetic-plan-grant');
  store.put('model', {
    id: 'plan-model',
    authMode: 'chatgpt',
    secretRef: planCredential,
    generation: 2,
    connection: 'verified',
  });
  const artifact = product.artifact('bot', {
    name: 'retained.txt',
    mediaType: 'text/plain',
    content: 'Exact backup artifact bytes',
  });
  const backup = createBackup(store);
  assert.ok(inspectBackup(backup.path).files.length >= 3);
  const destination = join(mkdtempSync(join(tmpdir(), 'workshop-backup-parent-')), 'restored');
  const receipt = restoreToNewRoot(backup.path, destination);
  assert.equal(receipt.compute, 'unbound; original Docker resources untouched');
  const restored = new Store(destination);
  assert.equal(new Vault(restored).read(credential), 'synthetic-secret-not-real');
  assert.equal(restored.get('plan-model').secretRef, null);
  assert.equal(restored.get('plan-model').oauthState, 'reconnect_after_restore');
  assert.equal(restored.get('plan-model').generation, 3);
  assert.equal(
    restored.db.prepare('SELECT count(*) n FROM secrets WHERE id=?').get(planCredential).n,
    0,
  );
  assert.equal(new Vault(store).read(planCredential), 'synthetic-plan-grant');
  assert.equal(
    new Product(restored).bytes(restored.get(artifact.revision.id, 'artifact_revision')).toString(),
    'Exact backup artifact bytes',
  );
  assert.equal(restored.get('retained-computer').state, 'unbound_after_restore');
  assert.equal(restored.get('retained-computer').containerId, 'retained-original-container');
  assert.equal(restored.get('routine').enabled, false);
  assert.equal(restored.get('remote-config').enabled, false);
  assert.equal(restored.get('remote-client').state, 'revoked');
  assert.equal(restored.get('remote-pair').state, 'expired');
  assert.equal(restored.get('auth').expiresAt, 0);
  assert.equal(restored.get('computer').containerId, null);
  assert.notEqual(restored.get('computer').resourceName, 'owned-original');
  assert.notEqual(restored.get('installation').value, 'original-installation');
  assert.equal(store.get('computer').containerId, 'original-container');
  assert.throws(() => restoreToNewRoot(backup.path, destination), /new, empty destination/);
  const bytes = join(backup.path, 'artifacts', artifact.revision.digest);
  writeFileSync(bytes, 'tampered');
  assert.throws(() => inspectBackup(backup.path), /integrity check failed/);
  restored.close();
  store.close();
});
