import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, id } from '../packages/host/src/store.mjs';
import { Vault } from '../packages/host/src/security.mjs';
import { OAuth } from '../packages/host/src/oauth.mjs';
import { Connections } from '../packages/host/src/connections.mjs';
import { providerPreset, adaptOperation } from '../packages/host/src/provider-presets.mjs';
import { startHost, stopHost, waitFor } from './support.mjs';

test('expanded provider operations preserve IDs, repeated query values and explicit catalog policy ownership', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'orbit-catalog-'))),
    vault = new Vault(store);
  const connections = new Connections(store, vault),
    oauth = new OAuth(store, vault, connections, 'http://127.0.0.1:4317');
  try {
    const owner = id(),
      bot = store.put('bot', { id: id(), ownerId: owner });
    const google = providerPreset('google', 'mail');
    assert.equal(google.tools.length, 27);
    const search = adaptOperation(
      google.tools.find((operation) => operation.name === 'mail.search'),
      { q: 'subject:fixture', labelIds: ['INBOX', 'UNREAD'], includeSpamTrash: false },
    );
    assert.deepEqual(new URLSearchParams(search.queryEntries).getAll('labelIds'), [
      'INBOX',
      'UNREAD',
    ]);
    const archive = adaptOperation(
      google.tools.find((operation) => operation.name === 'mail.archive'),
      { id: 'message/with?chars' },
    );
    assert.equal(archive.path, '/gmail/v1/users/me/messages/message%2Fwith%3Fchars/modify');
    assert.deepEqual(archive.body, { removeLabelIds: ['INBOX'] });
    const modified = adaptOperation(
      google.tools.find((operation) => operation.name === 'mail.modify_labels'),
      { id: 'selected', addLabelIds: ['STARRED'] },
    );
    assert.deepEqual(modified.body, { addLabelIds: ['STARRED'] });
    const calendar = providerPreset('google', 'calendar');
    assert.equal(calendar.tools.length, 6);
    assert.equal(providerPreset('microsoft', 'mail').tools.length, 14);
    assert.equal(providerPreset('microsoft', 'calendar').tools.length, 7);
    const created = oauth.create(owner, {
      name: 'Catalog fixture',
      provider: 'google',
      service: 'mail',
      clientId: 'synthetic-client',
      botIds: [bot.id],
    });
    let connection = store.get(created.id, 'connection');
    connection = store.put('connection', {
      ...connection,
      discoveredTools: connection.tools
        .slice(0, 2)
        .map((operation) => ({ ...operation, policy: 'deny' })),
    });
    const updated = oauth.updateCatalog(owner, connection.id, { revision: connection.revision });
    assert.equal(updated.discoveredTools.length, 27);
    assert.equal(
      updated.discoveredTools.find((operation) => operation.name === 'mail.search').policy,
      'deny',
    );
    assert.equal(
      updated.discoveredTools.find((operation) => operation.name === 'mail.archive').policy,
      'ask',
    );
    assert.throws(
      () => oauth.updateCatalog(owner, connection.id, { revision: connection.revision }),
      (error) => error.tag === 'stale_revision',
    );
    assert.throws(
      () => oauth.updateCatalog(id(), connection.id, { revision: updated.revision }),
      (error) => error.tag === 'not_authorized',
    );
  } finally {
    store.close();
  }
});

test('public custom rules enforce exact operations, Ask-first precedence, denied dispatch and changes during approval', async () => {
  const received = [];
  const remote = http.createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    received.push({
      path: request.url,
      method: request.method,
      body: text ? JSON.parse(text) : null,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"synthetic":true}');
  });
  await new Promise((resolve) => remote.listen(0, '127.0.0.1', resolve));
  const host = await startHost(mkdtempSync(join(tmpdir(), 'orbit-rules-')), 14360);
  try {
    await host.call('/auth/setup', {
      name: 'Rules fixture',
      password: 'Synthetic-rules-only-2026',
    });
    const bot = (
      await host.call('/bots', {
        name: 'Rules Bot',
        purpose: 'Synthetic rules',
        role: 'No real effects',
        capabilities: ['extensions'],
      })
    ).body;
    const created = await host.call('/connections', {
      name: 'Synthetic Gmail transport',
      kind: 'http',
      endpoint: 'http://127.0.0.1:' + remote.address().port,
      botIds: [bot.id],
      tools: providerPreset('google', 'mail').tools,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    let connection = (await host.call('/connections/' + created.body.id + '/discover', {})).body;
    const rule = {
      description: 'Allow only fixture archiving',
      operation: 'mail.archive',
      behavior: 'allow',
      botIds: [bot.id],
      enabled: true,
    };
    let saved = await host.call('/connections/' + connection.id + '/rules', {
      revision: connection.revision,
      rules: [rule],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    connection = saved.body;
    const submit = () =>
      host.call('/bots/' + bot.id + '/actions', {
        connectionId: connection.id,
        operation: 'mail.archive',
        args: { id: 'fixture/message' },
        nonce: id(),
      });
    const overview = async () => (await host.call('/bots/' + bot.id + '/overview')).body;
    const first = await submit();
    assert.equal(first.status, 202);
    await waitFor(async () =>
      (await overview()).runs.find((run) => run.id === first.body.id && run.state === 'settled'),
    );
    assert.deepEqual(received[0], {
      path: '/gmail/v1/users/me/messages/fixture%2Fmessage/modify',
      method: 'POST',
      body: { removeLabelIds: ['INBOX'] },
    });
    saved = await host.call('/connections/' + connection.id + '/rules', {
      revision: connection.revision,
      rules: [
        ...connection.rules,
        { ...rule, behavior: 'ask', description: 'Ask first takes priority' },
      ],
    });
    connection = saved.body;
    const second = await submit();
    const approval = await waitFor(async () =>
      (await overview()).approvals.find(
        (value) => value.runId === second.body.id && value.state === 'pending',
      ),
    );
    assert.equal(received.length, 1);
    saved = await host.call('/connections/' + connection.id + '/rules', {
      revision: connection.revision,
      rules: [{ ...rule, behavior: 'deny', description: 'Deny before dispatch' }],
    });
    connection = saved.body;
    await host.call('/bots/' + bot.id + '/approvals/' + approval.id, {
      revision: approval.revision,
      decision: 'approved',
    });
    await waitFor(async () =>
      (await overview()).runs.find((run) => run.id === second.body.id && run.state === 'failed'),
    );
    assert.equal(received.length, 1);
    assert.equal((await submit()).status, 403);
    assert.equal(
      (
        await host.call('/connections/' + connection.id + '/rules', {
          revision: connection.revision - 1,
          rules: [],
        })
      ).status,
      409,
    );
  } finally {
    await stopHost(host);
    await new Promise((resolve) => remote.close(resolve));
  }
});
