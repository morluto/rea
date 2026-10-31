import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, id } from '../packages/host/src/store.mjs';
import { Harness } from '../packages/host/src/harness.mjs';

function fixture() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'orbit-memory-search-')));
  const botId = id();
  store.put('bot', { id: botId, name: 'Search fixture', capabilities: ['memory'] });
  const conversationId = id();
  store.put('conversation', { id: conversationId, botId, name: 'Search context' });
  const run = store.put('run', {
    id: id(),
    botId,
    conversationId,
    state: 'queued',
    config: { capabilities: ['memory'] },
    cancelRequested: false,
  });
  return { store, botId, conversationId, run };
}

async function searchTool(store, run) {
  const harness = new Harness(store, null, null, null);
  const tools = await harness.tools(run);
  const search = tools.find((t) => t.name === 'memory_search');
  assert.ok(search, 'harness exposes memory_search');
  return (query) => search.execute('test-call', { query });
}

test('memory_search returns active memories through the real model tool path', async () => {
  const { store, botId, run } = fixture();
  store.put('memory', {
    id: id(),
    botId,
    subject: 'Quorum sandwich protocol',
    content: 'The quorum sandwich protocol requires three pickles.',
    scope: 'bot',
    source: 'fixture',
    certainty: 'user_confirmed',
    state: 'active',
  });
  const search = await searchTool(store, run);
  const out = await search('quorum sandwich');
  assert.equal(out.details.length, 1);
  assert.equal(out.details[0].state, 'active');
  store.close();
});

test('memory_search excludes forgotten and archived memories', async () => {
  const { store, botId, run } = fixture();
  const forgotten = store.put('memory', {
    id: id(),
    botId,
    subject: 'Quorum nap schedule',
    content: 'The quorum nap schedule was revoked.',
    scope: 'bot',
    source: 'fixture',
    certainty: 'user_confirmed',
    state: 'active',
  });
  const archived = store.put('memory', {
    id: id(),
    botId,
    subject: 'Quorum archive entry',
    content: 'The quorum archive entry is retired.',
    scope: 'bot',
    source: 'fixture',
    certainty: 'observed',
    state: 'active',
  });
  store.put('memory', { ...forgotten, content: '[forgotten]', state: 'forgotten' });
  store.put('memory', { ...archived, state: 'archived' });
  const search = await searchTool(store, run);
  const out = await search('quorum');
  assert.deepEqual(
    out.details.map((m) => m.state),
    [],
  );
  const rows = store.list('memory', botId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((m) => m.state).sort(), ['archived', 'forgotten']);
  store.close();
});

test('memory_search isolates conversation-scoped memories to their conversation', async () => {
  const { store, botId, conversationId, run } = fixture();
  const other = store.put('conversation', { id: id(), botId, name: 'Other context' });
  store.put('memory', {
    id: id(),
    botId,
    conversationId: other.id,
    subject: 'Quorum side channel',
    content: 'The quorum side channel belongs elsewhere.',
    scope: 'conversation',
    source: 'fixture',
    certainty: 'observed',
    state: 'active',
  });
  store.put('memory', {
    id: id(),
    botId,
    conversationId,
    subject: 'Quorum main channel',
    content: 'The quorum main channel is visible here.',
    scope: 'conversation',
    source: 'fixture',
    certainty: 'observed',
    state: 'active',
  });
  const search = await searchTool(store, run);
  const out = await search('main channel');
  assert.deepEqual(
    out.details.map((m) => m.subject),
    ['Quorum main channel'],
  );
  store.close();
});
