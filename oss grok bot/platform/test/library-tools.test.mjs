import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, id } from '../packages/host/src/store.mjs';
import { Harness } from '../packages/host/src/harness.mjs';

function fixture() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'orbit-library-tools-')));
  const botId = id();
  store.put('bot', { id: botId, name: 'Library fixture', capabilities: ['library'] });
  const otherId = id();
  store.put('bot', { id: otherId, name: 'Other fixture', capabilities: ['library'] });
  const conversationId = id();
  store.put('conversation', { id: conversationId, botId, name: 'Library context' });
  const run = store.put('run', {
    id: id(),
    botId,
    conversationId,
    state: 'queued',
    config: { capabilities: ['library'] },
    cancelRequested: false,
  });
  const revisionId = id();
  const artifactId = id();
  store.put('artifact', { id: artifactId, botId, currentRevisionId: revisionId });
  store.put('artifact_revision', {
    id: revisionId,
    botId,
    artifactId,
    name: 'notes.txt',
    mediaType: 'text/plain',
    size: 3,
    digest: 'abc',
  });
  const foreignRevisionId = id();
  store.put('artifact', { id: id(), botId: otherId, currentRevisionId: foreignRevisionId });
  store.put('artifact_revision', {
    id: foreignRevisionId,
    botId: otherId,
    artifactId: id(),
    name: 'secret.txt',
    mediaType: 'text/plain',
    size: 6,
    digest: 'def',
  });
  return { store, botId, run, revisionId, foreignRevisionId };
}

async function libraryTools(store, run) {
  const harness = new Harness(store, null, null, null);
  const tools = await harness.tools(run);
  const list = tools.find((t) => t.name === 'library_list');
  const read = tools.find((t) => t.name === 'library_read');
  assert.ok(list, 'harness exposes library_list');
  assert.ok(read, 'harness exposes library_read');
  return { list, read };
}

test('library_list returns only this Bot artifact identities', async () => {
  const { store, botId, run } = fixture();
  const { list } = await libraryTools(store, run);
  const out = await list.execute('test-call', {});
  assert.equal(out.details.length, 1);
  assert.equal(out.details[0].botId, botId);
  store.close();
});

test('library_read rejects another Bot revision without a handoff', async () => {
  const { store, run, foreignRevisionId } = fixture();
  const { read } = await libraryTools(store, run);
  await assert.rejects(
    read.execute('test-call', { revisionId: foreignRevisionId }),
    /exact-revision handoff/,
  );
  store.close();
});
