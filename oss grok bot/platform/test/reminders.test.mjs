import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Reminders } from '../packages/host/src/reminders.mjs';
import { Store, id } from '../packages/host/src/store.mjs';
import { startHost, stopHost, waitFor } from './support.mjs';
import { artifactPlaybackURL } from '../apps/desktop/artifact-permissions.mjs';

test('one-time reminders retain origin, catch up once without inference, and support cancellation', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'orbit-reminder-')));
  const bot = store.put('bot', {
    id: id(),
    ownerId: id(),
    name: 'Synthetic reminder Bot',
    capabilities: ['routines'],
  });
  const conversation = store.put('conversation', { id: id(), botId: bot.id });
  const run = store.put('run', { id: id(), botId: bot.id, conversationId: conversation.id });
  const reminders = new Reminders(store);
  try {
    const input = {
      message: 'Synthetic one-time assignment reminder.',
      delaySeconds: 60,
      nonce: id(),
    };
    const row = reminders.create(bot.id, input, run.id);
    assert.equal(row.conversationId, conversation.id);
    assert.equal(reminders.create(bot.id, input, run.id).id, row.id);
    reminders.tick(row.dueAt - 1);
    assert.equal(store.list('notification').length, 0);
    reminders.tick(row.dueAt + 60000);
    reminders.tick(row.dueAt + 120000);
    assert.equal(store.list('notification').length, 1);
    assert.equal(store.get(row.id, 'reminder').state, 'notified');
    assert.equal(store.list('run').length, 1);
    const cancelled = reminders.create(bot.id, { ...input, nonce: id() });
    reminders.cancel(bot.id, cancelled.id);
    reminders.tick(cancelled.dueAt + 1);
    assert.equal(store.list('notification').length, 1);
    const foreign = store.put('conversation', { id: id(), botId: id() });
    assert.throws(
      () => reminders.create(bot.id, { ...input, nonce: id(), conversationId: foreign.id }),
      (error) => error.tag === 'not_authorized',
    );
  } finally {
    store.db.close();
  }
});

test('public reminder creates a durable notice and exposes origin in overview', async () => {
  const host = await startHost(mkdtempSync(join(tmpdir(), 'orbit-reminder-http-')), 14358);
  try {
    await host.call('/auth/setup', {
      name: 'Synthetic reminder owner',
      password: 'Synthetic-reminder-only-2026',
    });
    const bot = (
      await host.call('/bots', {
        name: 'Reminder fixture',
        purpose: 'One-time check',
        role: 'Synthetic fixture only.',
        capabilities: ['routines'],
      })
    ).body;
    const conversation = (await host.call('/bots/' + bot.id + '/conversations', { name: 'Origin' }))
      .body;
    const response = await host.call('/bots/' + bot.id + '/reminders', {
      message: 'One-time synthetic reminder',
      delaySeconds: 0.05,
      nonce: id(),
      conversationId: conversation.id,
    });
    assert.equal(response.status, 201);
    await waitFor(
      async () =>
        (await host.call('/bots/' + bot.id + '/reminders')).body.find(
          (row) => row.state === 'notified',
        ),
      'one-time reminder',
    );
    const notices = (await host.call('/notifications')).body;
    assert.equal(notices.length, 1);
    assert.equal(notices[0].kind, 'reminder');
    const overview = (await host.call('/bots/' + bot.id + '/overview')).body;
    assert.equal(overview.reminders[0].conversationId, conversation.id);
    assert.equal(overview.runs.length, 0);
  } finally {
    await stopHost(host);
  }
});

test('desktop game permissions apply only to explicitly selected artifact playback', () => {
  const host = 'http://127.0.0.1:4317';
  const path = host + '/api/bots/' + id() + '/artifacts/' + id() + '/render';
  assert.equal(artifactPlaybackURL(path, host), false);
  assert.equal(artifactPlaybackURL(path + '?play=1', host), true);
  assert.equal(
    artifactPlaybackURL(path.replace(host, 'https://example.com') + '?play=1', host),
    false,
  );
  assert.equal(artifactPlaybackURL(host + '/api/auth/status?play=1', host), false);
  assert.equal(artifactPlaybackURL('null', host), false);
});
