import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startHost, stopHost } from './support.mjs';
test('account invitations, shared read/operator scopes, team revocation and rooms', async (t) => {
  const host = await startHost(mkdtempSync(join(tmpdir(), 'bot-workshop-access-')), 14321);
  t.after(() => stopHost(host));
  await host.call('/auth/setup', { name: 'owner', password: 'Synthetic-owner-only-2026' });
  const ownerCookie = host.cookie();
  const owner = async (path, value, method = value === undefined ? 'GET' : 'POST') => {
    const r = await fetch(host.base + '/api' + path, {
      method,
      headers: { cookie: ownerCookie, origin: host.base, 'content-type': 'application/json' },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    return { status: r.status, body: await r.json() };
  };
  const first = (await owner('/state')).body.account;
  const bot = (
    await owner('/bots', {
      name: 'Shared test',
      purpose: 'Scope verification',
      role: 'Synthetic test Bot',
    })
  ).body;
  const conversation = (await owner(`/bots/${bot.id}/conversations`, { name: 'Owner context' }))
    .body;
  const library = (
    await owner(`/bots/${bot.id}/artifacts`, {
      name: 'shared.txt',
      mediaType: 'text/plain',
      content: 'Explicitly shared test bytes',
    })
  ).body;
  const invite = (await owner('/invites', {})).body;
  const joined = await host.call('/auth/join', {
    token: invite.token,
    name: 'guest',
    password: 'Synthetic-guest-only-2026',
  });
  assert.equal(joined.status, 201);
  assert.equal(
    (
      await host.call('/auth/join', {
        token: invite.token,
        name: 'duplicate',
        password: 'Synthetic-guest-only-2026',
      })
    ).status,
    403,
  );
  await host.call('/auth/login', { name: 'guest', password: 'Synthetic-guest-only-2026' });
  assert.equal((await host.call('/state')).body.bots.length, 0);
  assert.equal((await host.call(`/bots/${bot.id}/overview`)).status, 403);
  assert.equal((await host.call('/backup', {})).status, 403);
  await owner(`/bots/${bot.id}/shares`, { accountId: joined.body.id, role: 'viewer' });
  assert.equal((await host.call(`/bots/${bot.id}/overview`)).status, 200);
  const download = await fetch(
    host.base + `/api/bots/${bot.id}/artifacts/${library.revision.id}/download`,
    { headers: { cookie: host.cookie() } },
  );
  assert.equal(await download.text(), 'Explicitly shared test bytes');
  const request = { text: 'A shared task', conversationId: conversation.id, nonce: randomUUID() };
  assert.equal((await host.call(`/bots/${bot.id}/tasks`, request)).status, 403);
  await owner(`/bots/${bot.id}/shares`, { accountId: joined.body.id, role: 'operator' });
  assert.equal((await host.call(`/bots/${bot.id}/tasks`, request)).status, 202);
  const patch = {
    name: bot.name,
    purpose: bot.purpose,
    role: 'Unauthorized edit',
    modelId: null,
    capabilities: bot.capabilities,
    maxTurns: bot.maxTurns,
    revision: bot.revision,
  };
  assert.equal((await host.call(`/bots/${bot.id}`, patch, 'PATCH')).status, 403);
  await owner(`/bots/${bot.id}/shares`, {
    accountId: joined.body.id,
    role: 'viewer',
    state: 'revoked',
  });
  assert.equal((await host.call(`/bots/${bot.id}/overview`)).status, 403);
  const team = (await owner('/teams', { name: 'Synthetic team', accountIds: [joined.body.id] }))
    .body;
  await owner(`/bots/${bot.id}/shares`, { teamId: team.id, role: 'operator' });
  const room = (await owner('/rooms', { name: 'Synthetic room', botId: bot.id, teamId: team.id }))
    .body;
  const message = await host.call(`/rooms/${room.id}/messages`, {
    text: 'A real durable room message',
    askBot: false,
    nonce: randomUUID(),
  });
  assert.equal(message.status, 201);
  assert.equal(
    (await owner(`/rooms/${room.id}/messages`)).body.messages[0].text,
    'A real durable room message',
  );
  const collab = (await owner('/collaboration')).body;
  const membership = collab.memberships.find(
    (m) => m.teamId === team.id && m.accountId === joined.body.id,
  );
  assert.equal((await owner(`/teams/${team.id}/members/${membership.id}`, {})).status, 200);
  assert.equal((await host.call(`/rooms/${room.id}/messages`)).status, 403);
  assert.equal((await host.call(`/bots/${bot.id}/overview`)).status, 403);
  assert.equal((await owner('/state')).body.account.id, first.id);
});
