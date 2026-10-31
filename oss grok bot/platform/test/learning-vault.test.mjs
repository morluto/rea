import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, id } from '../packages/host/src/store.mjs';
import { Vault } from '../packages/host/src/security.mjs';
import { PersonalVault } from '../packages/host/src/personal-vault.mjs';
import { startHost, stopHost, syntheticProvider, waitFor } from './support.mjs';

test('public taught tasks retain revisions, selected conversation, explicit execution and Bot ownership', async () => {
  const remote = await syntheticProvider();
  const host = await startHost(mkdtempSync(join(tmpdir(), 'orbit-learning-')), 14359);
  try {
    assert.equal((await host.call('/vault')).status, 401);
    await host.call('/auth/setup', {
      name: 'Learning fixture',
      password: 'Synthetic-learning-only-2026',
    });
    const model = (
      await host.call('/models', {
        name: 'Synthetic',
        endpoint: 'http://127.0.0.1:' + remote.port + '/v1',
        model: 'synthetic-workflow',
        api: 'openai-completions',
      })
    ).body;
    const bot = (
      await host.call('/bots', {
        name: 'Teacher fixture',
        purpose: 'Test reusable instructions',
        role: 'Synthetic only',
        modelId: model.id,
      })
    ).body;
    const other = (
      await host.call('/bots', {
        name: 'Other fixture',
        purpose: 'Test ownership',
        role: 'Synthetic only',
      })
    ).body;
    const conversation = (
      await host.call('/bots/' + bot.id + '/conversations', { name: 'Learning' })
    ).body;
    const path = '/bots/' + bot.id + '/recipes';
    const recipe = (
      await host.call(path, {
        title: 'Synthetic checklist',
        whenToUse: 'Synthetic reports',
        instructions: 'Check the source and state limitations.',
      })
    ).body;
    assert.ok(recipe.id);
    assert.equal(
      (
        await host.call('/bots/' + other.id + '/recipes/' + recipe.id, {
          title: recipe.title,
          whenToUse: recipe.whenToUse,
          instructions: recipe.instructions,
          revision: recipe.revision,
        })
      ).status,
      403,
    );
    const input = {
      conversationId: conversation.id,
      revision: recipe.revision,
      nonce: id(),
      input: 'Only synthetic data.',
    };
    const accepted = await host.call(path + '/' + recipe.id + '/run', input);
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    assert.match(accepted.body.text, /Check the source and state limitations/);
    assert.equal(
      (await host.call(path + '/' + recipe.id + '/run', input)).body.id,
      accepted.body.id,
    );
    await waitFor(
      async () =>
        (await host.call('/bots/' + bot.id + '/overview')).body.runs.find(
          (run) => run.id === accepted.body.id,
        )?.state === 'settled',
    );
    const edit = {
      title: recipe.title,
      whenToUse: recipe.whenToUse,
      instructions: 'Revised checks',
      revision: recipe.revision,
      exampleRunId: accepted.body.id,
    };
    const updated = await host.call(path + '/' + recipe.id, edit);
    assert.equal(updated.status, 200);
    assert.equal(updated.body.example.runId, accepted.body.id);
    assert.equal((await host.call(path + '/' + recipe.id, edit)).status, 409);
    assert.equal(
      (await host.call(path + '/' + recipe.id + '/run', { ...input, nonce: id() })).status,
      409,
    );
    assert.equal(
      (await host.call(path + '/' + recipe.id + '/remove', { revision: updated.body.revision }))
        .status,
      200,
    );
    assert.equal(
      (
        await host.call(path + '/' + recipe.id + '/run', {
          ...input,
          nonce: id(),
          revision: updated.body.revision + 1,
        })
      ).status,
      403,
    );
    const saved = await host.call('/vault', {
      kind: 'login',
      label: 'Fixture login',
      fields: {
        origin: 'https://example.invalid/account',
        username: 'fixture',
        password: 'Synthetic-private-password',
      },
    });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.origin, 'https://example.invalid');
    assert.ok(
      !JSON.stringify((await host.call('/vault')).body).includes('Synthetic-private-password'),
    );
    assert.equal(
      (await host.call('/vault/' + saved.body.id + '/reveal', {})).body.fields.password,
      'Synthetic-private-password',
    );
    assert.equal(
      (await host.call('/vault/' + saved.body.id + '/remove', { revision: saved.body.revision }))
        .status,
      200,
    );
    assert.equal((await host.call('/vault/' + saved.body.id + '/reveal', {})).status, 403);
  } finally {
    await stopHost(host);
    await new Promise((resolve) => remote.server.close(resolve));
  }
});

test('personal vault encrypts payloads, isolates owners, preserves blank private edits and logically removes secrets', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'orbit-personal-vault-')));
  const vault = new Vault(store),
    personal = new PersonalVault(store, vault),
    owner = id();
  try {
    const input = {
      kind: 'card',
      label: 'Synthetic card',
      fields: { holder: 'Fixture', number: '4242424242424242', expiry: '12/30', cvc: '123' },
    };
    const row = personal.save(owner, input);
    assert.equal(row.last4, '4242');
    assert.equal(row.secretRef, undefined);
    assert.equal(personal.list(id()).length, 0);
    assert.throws(
      () => personal.reveal(id(), row.id),
      (error) => error.tag === 'not_authorized',
    );
    assert.ok(
      !JSON.stringify(store.db.prepare('SELECT * FROM secrets').all()).includes('4242424242424242'),
    );
    const renamed = personal.save(
      owner,
      { kind: 'card', label: 'Renamed', revision: row.revision },
      row.id,
    );
    const updated = personal.save(
      owner,
      { ...input, revision: renamed.revision, fields: { holder: 'Updated', expiry: '12/31' } },
      row.id,
    );
    assert.equal(personal.reveal(owner, row.id).fields.number, input.fields.number);
    assert.equal(personal.reveal(owner, row.id).fields.cvc, '123');
    assert.throws(
      () => personal.remove(owner, row.id, { revision: row.revision }),
      (error) => error.tag === 'stale_revision',
    );
    assert.equal(personal.reveal(owner, row.id).fields.holder, 'Updated');
    personal.remove(owner, row.id, { revision: updated.revision });
    assert.equal(store.db.prepare('SELECT count(*) count FROM secrets').get().count, 0);
    assert.throws(() => personal.reveal(owner, row.id));
  } finally {
    store.close();
  }
});
