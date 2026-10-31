import { z } from 'zod';
import { fail, id } from './store.mjs';
import { validate } from './product.mjs';
export async function extraRoutes(ctx) {
  const {
    path,
    method,
    url,
    req,
    res,
    session,
    body,
    send,
    store,
    workflows,
    connections,
    knowledge,
    harness,
    access,
    devices,
    triggers,
    oauth,
    actions,
    coding,
    reminders,
    learning,
    personalVault,
    librarySearch,
    documents,
    semantic,
    retention,
    push,
    computers,
    vault,
  } = ctx;
  const searchPath = path.match(/^\/api\/bots\/([^/]+)\/library-search$/);
  if (searchPath && method === 'POST') {
    access.requireBot(session.accountId, searchPath[1]);
    send(res, await librarySearch.search(searchPath[1], await body(req)));
    return true;
  }
  const semanticPath = path.match(/^\/api\/bots\/([^/]+)\/semantic(?:\/(config|search))?$/);
  if (semanticPath) {
    const [, botId, operation] = semanticPath;
    access.requireBot(session.accountId, botId, method !== 'GET');
    if (method === 'GET' && !operation) send(res, semantic.config(botId));
    else if (method === 'POST' && operation === 'config') {
      if (req.workshopRemote)
        fail('not_authorized', 'Semantic endpoint credentials are primary-local only', 403);
      send(res, semantic.configure(botId, await body(req)));
    } else if (method === 'POST' && operation === 'search') {
      const config = semantic.config(botId);
      const secret = config.secretRef ? vault.read(config.secretRef) : '';
      send(res, await semantic.search(botId, await body(req), secret));
    } else return false;
    return true;
  }
  const retentionPath = path.match(/^\/api\/admin\/retention(?:\/(prune))?$/);
  if (retentionPath) {
    if (!access.admin(session.accountId)) fail('not_authorized', 'Workspace owner required', 403);
    const [, operation] = retentionPath;
    if (method === 'GET' && !operation)
      send(res, {
        ...retention.config(),
        states:
          'Events, expired search snapshots, settled run partials and read notifications are pruned; active conversations, artifacts, memories and receipts are retained.',
      });
    else if (method === 'POST' && !operation) send(res, retention.save(await body(req)));
    else if (method === 'POST' && operation === 'prune') send(res, retention.prune());
    else return false;
    return true;
  }
  const pushPath = path.match(
    /^\/api\/push(?:\/(config|status|subscriptions(?:\/([^/]+)\/remove)?))?$/,
  );
  if (pushPath) {
    const [, operation, subscriptionId] = pushPath;
    if (method === 'POST' && operation === 'config') {
      if (!access.admin(session.accountId)) fail('not_authorized', 'Workspace owner required', 403);
      send(res, await push.configure(session.accountId));
    } else if (method === 'GET' && operation === 'status')
      send(res, push.status(session.accountId));
    else if (method === 'GET' && operation === 'subscriptions')
      send(res, push.status(session.accountId).subscriptions);
    else if (method === 'POST' && operation === 'subscriptions')
      send(res, push.subscribe(session.accountId, await body(req)), 201);
    else if (method === 'POST' && subscriptionId)
      send(res, push.unsubscribe(session.accountId, subscriptionId));
    else return false;
    return true;
  }
  const marketplacePath = path.match(
    /^\/api\/marketplace\/templates(?:\/([^/]+)\/(publish|install))?$/,
  );
  if (marketplacePath) {
    const [, key, operation] = marketplacePath;
    if (method === 'GET' && !key) send(res, learning.listTemplates(session.accountId));
    else if (method === 'POST' && operation === 'publish') {
      const listing = learning.publishTemplate(session.accountId, key, await body(req));
      send(res, listing, 201);
    } else if (method === 'POST' && operation === 'install') {
      const BotInputModule = await import('./contracts.mjs');
      const payload = BotInputModule.BotInput.parse(
        learning.installTemplate(session.accountId, key, await body(req)),
      );
      const bot = store.tx(() => {
        const record = store.put('bot', {
          id: id(),
          ownerId: session.accountId,
          ...payload,
          pinned: false,
          hidden: false,
          retired: false,
        });
        store.put('bot_revision', {
          ...record,
          id: id(),
          botId: record.id,
          configRevision: record.revision,
        });
        store.event(record.id, null, 'bot.created', { id: record.id, fromTemplate: key });
        return record;
      });
      computers.record(bot.id);
      const listing = store.get(key, 'template_listing');
      store.put('template_listing', { ...listing, installs: (listing.installs ?? 0) + 1 });
      send(res, bot, 201);
    } else return false;
    return true;
  }
  if (path === '/api/org' && method === 'GET') {
    if (!access.admin(session.accountId)) fail('not_authorized', 'Workspace owner required', 403);
    send(res, {
      kind: 'personal_workspace',
      owner: session.accountId,
      satellites: devices.store
        .list('device')
        .filter((d) => d.ownerId === session.accountId)
        .map((d) => ({ id: d.id, label: d.label, state: d.state })),
      note: 'Orbit is a single-owner local host; satellites are this owner’s paired devices, managed under Devices.',
    });
    return true;
  }
  const vaultPath = path.match(/^\/api\/vault(?:\/([^/]+))?(?:\/(reveal|remove|fill))?$/);
  if (vaultPath) {
    const [, key, operation] = vaultPath;
    if (req.workshopRemote)
      fail('not_authorized', 'Personal vault management is primary-local only', 403);
    if (method === 'GET' && !key) send(res, personalVault.list(session.accountId));
    else if (method === 'POST' && operation === 'reveal') {
      await body(req);
      send(res, personalVault.reveal(session.accountId, key));
    } else if (method === 'POST' && operation === 'fill') {
      send(res, personalVault.fillRequest(session.accountId, key, (await body(req)).botId), 201);
    } else if (method === 'POST' && operation === 'remove')
      send(res, personalVault.remove(session.accountId, key, await body(req)));
    else if (method === 'POST' && !operation)
      send(res, personalVault.save(session.accountId, await body(req), key), key ? 200 : 201);
    else return false;
    return true;
  }
  const recipePath = path.match(/^\/api\/bots\/([^/]+)\/recipes(?:\/([^/]+))?(?:\/(run|remove))?$/);
  if (recipePath) {
    const [, botId, key, operation] = recipePath;
    access.requireBot(session.accountId, botId, method !== 'GET');
    if (method === 'GET' && !key) send(res, learning.list(botId));
    else if (method === 'POST' && operation === 'run') {
      send(res, learning.run(botId, key, await body(req)), 202);
      setImmediate(() => void harness.pump());
    } else if (method === 'POST' && operation === 'remove')
      send(res, learning.remove(session.accountId, botId, key, await body(req)));
    else if (method === 'POST' && !operation)
      send(res, learning.save(session.accountId, botId, await body(req), key), key ? 200 : 201);
    else return false;
    return true;
  }
  const reminderPath = path.match(
    /^\/api\/bots\/([^/]+)\/reminders(?:\/([^/]+)\/(cancel|unpin))?$/,
  );
  if (reminderPath) {
    const [, botId, reminderId, reminderAction] = reminderPath;
    access.requireBot(session.accountId, botId, method !== 'GET');
    if (method === 'GET' && !reminderId) send(res, store.list('reminder', botId));
    else if (method === 'POST' && reminderAction === 'cancel')
      send(res, reminders.cancel(botId, reminderId));
    else if (method === 'POST' && reminderAction === 'unpin')
      send(res, reminders.unpin(botId, reminderId));
    else if (method === 'POST' && !reminderId) send(res, reminders.create(botId, await body(req)), 201);
    else return false;
    return true;
  }
  if (path === '/api/coding/config') {
    if (!access.admin(session.accountId) || req.workshopRemote)
      fail('not_authorized', 'T3 configuration requires the primary-local workspace owner', 403);
    if (method === 'GET') send(res, coding.config());
    else if (method === 'POST')
      send(res, await coding.configure(session.accountId, await body(req)));
    else return false;
    return true;
  }
  const codingPath = path.match(
    /^\/api\/bots\/([^/]+)\/coding(?:\/([^/]+))?(?:\/(inspect|send))?$/,
  );
  if (codingPath) {
    const [, botId, taskId, operation] = codingPath;
    access.requireBot(session.accountId, botId, method !== 'GET');
    if (method === 'GET' && !taskId) send(res, coding.list(botId));
    else if (method === 'POST' && !taskId)
      send(res, await coding.start(botId, await body(req)), 202);
    else if (method === 'POST' && operation === 'inspect')
      send(res, await coding.inspect(botId, taskId));
    else if (method === 'POST' && operation === 'send')
      send(res, await coding.send(botId, taskId, await body(req)), 202);
    else return false;
    return true;
  }
  const hostAction = path.match(/^\/api\/bots\/([^/]+)\/actions$/);
  const catalogPath = path.match(/^\/api\/oauth\/connections\/([^/]+)\/catalog$/);
  if (catalogPath && method === 'POST') {
    send(res, oauth.updateCatalog(session.accountId, catalogPath[1], await body(req)));
    return true;
  }
  if (hostAction && method === 'POST') {
    access.requireBot(session.accountId, hostAction[1], true);
    send(res, actions.create(session.accountId, hostAction[1], await body(req)), 202);
    return true;
  }
  const oauthApplication = path.match(/^\/api\/oauth\/applications\/(google|microsoft)$/);
  if (oauthApplication) {
    if (!access.admin(session.accountId) || req.workshopRemote)
      fail('not_authorized', 'App setup requires the primary-local workspace owner', 403);
    if (method === 'GET') send(res, oauth.application(session.accountId, oauthApplication[1]));
    else if (method === 'POST')
      send(
        res,
        oauth.configureApplication(session.accountId, oauthApplication[1], await body(req)),
      );
    else return false;
    return true;
  }
  const oauthFlow = path.match(/^\/api\/(oauth|mcp\/oauth)\/flows\/([^/]+)(?:\/(cancel))?$/);
  if (oauthFlow) {
    const owner = oauthFlow[1] === 'oauth' ? oauth : connections.mcpOAuth;
    if (method === 'POST' && oauthFlow[3]) {
      owner.cancelFlow(oauthFlow[2], session.accountId);
      send(res, owner.flow(oauthFlow[2], session.accountId));
    } else if (method === 'GET' && !oauthFlow[3])
      send(res, owner.flow(oauthFlow[2], session.accountId));
    else return false;
    return true;
  }
  if (path === '/api/oauth/connections' && method === 'POST') {
    send(res, oauth.create(session.accountId, await body(req)), 201);
    return true;
  }
  const oauthAction = path.match(/^\/api\/oauth\/connections\/([^/]+)\/(authorize|disconnect)$/);
  if (oauthAction && method === 'POST') {
    if (req.workshopRemote && oauthAction[2] === 'authorize')
      fail('not_authorized', 'Start provider sign-in on the primary computer', 403);
    send(
      res,
      oauthAction[2] === 'authorize'
        ? oauth.begin(oauthAction[1], session.accountId)
        : oauth.disconnect(oauthAction[1], session.accountId),
    );
    return true;
  }
  if (path === '/api/triggers') {
    if (method === 'GET')
      send(
        res,
        store
          .list('trigger')
          .filter((t) => t.ownerId === session.accountId)
          .map((t) => ({ ...t, secretRef: undefined })),
      );
    else if (method === 'POST') send(res, triggers.create(session.accountId, await body(req)), 201);
    else return false;
    return true;
  }
  const trigger = path.match(/^\/api\/triggers\/([^/]+)$/);
  if (trigger && method === 'POST') {
    const row = store.get(trigger[1], 'trigger');
    if (row.ownerId !== session.accountId) fail('not_authorized', 'Trigger owner required', 403);
    const v = validate(
      z.object({ enabled: z.boolean(), revision: z.number().int() }).strict(),
      await body(req),
    );
    send(res, {
      ...store.put('trigger', { ...row, enabled: v.enabled }, v.revision),
      secretRef: undefined,
    });
    return true;
  }
  if (path === '/api/devices') {
    if (method === 'GET')
      send(
        res,
        store
          .list('device')
          .filter((d) => d.ownerId === session.accountId)
          .map((d) => devices.public(d)),
      );
    else if (method === 'POST') send(res, devices.begin(session.accountId, await body(req)), 201);
    else return false;
    return true;
  }
  const device = path.match(/^\/api\/devices\/([^/]+)(?:\/(check|operate))?$/);
  if (device) {
    const d = store.get(device[1], 'device');
    if (d.ownerId !== session.accountId) fail('not_authorized', 'Device owner required', 403);
    if (method === 'POST') {
      if (device[2] === 'check') send(res, await devices.check(d.id));
      else if (device[2] === 'operate') {
        const v = validate(
          z
            .object({
              botId: z.string().uuid(),
              operation: z.enum(['read', 'write']),
              path: z.string().min(1).max(1000),
              content: z.string().max(262144).optional(),
            })
            .strict(),
          await body(req),
        );
        if (store.get(v.botId, 'bot').ownerId !== session.accountId)
          fail('not_authorized', 'Bot owner required', 403);
        send(
          res,
          await devices.operation({ botId: v.botId }, d.id, v.operation, {
            path: v.path,
            ...(v.content === undefined ? {} : { content: v.content }),
          }),
        );
      } else send(res, devices.update(d.id, session.accountId, await body(req)));
      return true;
    }
  }
  if (path === '/api/collaboration') {
    send(res, {
      accounts: store.list('account').map((a) => ({ id: a.id, name: a.name })),
      teams: store
        .list('team')
        .filter(
          (t) =>
            t.ownerId === session.accountId ||
            store
              .list('membership')
              .some(
                (m) =>
                  m.teamId === t.id && m.accountId === session.accountId && m.state === 'active',
              ),
        ),
      memberships: store
        .list('membership')
        .filter(
          (m) =>
            m.accountId === session.accountId ||
            store.get(m.teamId, 'team').ownerId === session.accountId,
        ),
      shares: store.list('share').filter((s) => s.ownerId === session.accountId),
      rooms: store.list('room').filter((r) => access.canRoom(session.accountId, r)),
    });
    return true;
  }
  if (path === '/api/invites' && method === 'POST') {
    send(res, access.invite(session.accountId), 201);
    return true;
  }
  if (path === '/api/teams' && method === 'POST') {
    send(res, access.team(session.accountId, await body(req)), 201);
    return true;
  }
  const membership = path.match(/^\/api\/teams\/([^/]+)\/members\/([^/]+)$/);
  if (membership && method === 'POST') {
    const team = store.get(membership[1], 'team');
    if (team.ownerId !== session.accountId) fail('not_authorized', 'Team owner required', 403);
    const member = store.get(membership[2], 'membership');
    if (member.teamId !== team.id || member.accountId === team.ownerId)
      fail('not_authorized', 'This member cannot be revoked here', 403);
    send(res, store.put('membership', { ...member, state: 'revoked' }));
    return true;
  }
  if (path === '/api/rooms' && method === 'POST') {
    send(res, access.room(session.accountId, await body(req)), 201);
    return true;
  }
  const roomMatch = path.match(/^\/api\/rooms\/([^/]+)\/messages$/);
  if (roomMatch) {
    const room = store.get(roomMatch[1], 'room');
    if (!access.canRoom(session.accountId, room))
      fail('not_authorized', 'Room access required', 403);
    if (method === 'GET') {
      send(res, {
        room,
        messages: store
          .list('room_message')
          .filter((m) => m.roomId === room.id)
          .slice(-200),
      });
      return true;
    }
    if (method === 'POST') {
      access.requireBot(session.accountId, room.botId, true);
      const v = validate(
        z
          .object({
            text: z.string().min(1).max(16000),
            askBot: z.boolean().default(false),
            nonce: z.string().uuid(),
          })
          .strict(),
        await body(req),
      );
      let message = store
        .list('room_message')
        .find((m) => m.roomId === room.id && m.nonce === v.nonce);
      if (!message)
        message = store.put('room_message', {
          id: id(),
          botId: room.botId,
          roomId: room.id,
          accountId: session.accountId,
          ...v,
        });
      if (v.askBot && !message.runId) {
        let c = store.list('conversation', room.botId).find((c) => c.roomId === room.id);
        if (!c)
          c = store.put('conversation', {
            id: id(),
            botId: room.botId,
            roomId: room.id,
            name: room.name,
            sessionFile: null,
          });
        const run = ctx.workflows.product.accept(room.botId, c.id, v.text, v.nonce);
        message = store.put('room_message', { ...message, runId: run.id });
      }
      send(res, message, 201);
      return true;
    }
  }
  const share = path.match(/^\/api\/bots\/([^/]+)\/shares$/);
  if (share && method === 'POST') {
    send(res, access.share(session.accountId, share[1], await body(req)));
    return true;
  }
  if (path === '/api/connections') {
    if (method === 'GET')
      send(
        res,
        store
          .list('connection')
          .filter((c) => c.ownerId === session.accountId)
          .map((c) => connections.public(c)),
      );
    else if (method === 'POST')
      send(res, connections.public(connections.create(session.accountId, await body(req))), 201);
    else return false;
    return true;
  }
  const rulePath = path.match(/^\/api\/connections\/([^/]+)\/rules$/);
  if (rulePath && method === 'POST') {
    send(res, connections.saveRules(session.accountId, rulePath[1], await body(req)));
    return true;
  }
  const c = path.match(/^\/api\/connections\/([^/]+)(?:\/(discover))?$/);
  if (c) {
    const connection = store.get(c[1], 'connection');
    if (connection.ownerId !== session.accountId)
      fail('not_authorized', 'Connection owner required', 403);
    if (method === 'POST')
      send(
        res,
        c[2]
          ? await connections.discover(connection.id)
          : connections.update(connection.id, session.accountId, await body(req)),
      );
    else return false;
    return true;
  }
  if (path === '/api/notifications') {
    if (method === 'GET')
      send(
        res,
        store
          .list('notification')
          .filter((n) => n.ownerId === session.accountId)
          .slice(-100)
          .reverse(),
      );
    else if (method === 'POST') {
      const v = validate(z.object({ id: z.string().uuid() }).strict(), await body(req));
      const n = store.get(v.id, 'notification');
      if (n.ownerId !== session.accountId) fail('not_authorized', 'Wrong owner', 403);
      send(res, store.put('notification', { ...n, read: true }));
    } else return false;
    return true;
  }
  if (path === '/api/analytics') {
    const days = Number(url.searchParams.get('days') ?? 30);
    if (![7, 30, 90].includes(days)) fail('invalid_input', 'Choose 7, 30 or 90 days');
    send(res, workflows.analytics(session.accountId, days));
    return true;
  }
  const match = path.match(
    /^\/api\/bots\/([^/]+)\/(workflow|waits\/[^/]+|children|knowledge(?:\/[^/]+)?|queue(?:\/[^/]+)?)$/,
  );
  if (!match) return false;
  const botId = match[1],
    op = match[2],
    bot = store.get(botId, 'bot');
  access.requireBot(session.accountId, botId, method !== 'GET');
  if (op === 'workflow') {
    send(res, {
      ...workflows.overview(botId),
      knowledge: store.list('knowledge', botId),
      externalActions: store.list('external_action', botId),
    });
    return true;
  }
  if (op.startsWith('waits/') && method === 'POST') {
    const wait = store.get(op.split('/')[1], 'input_wait');
    if (wait.botId !== botId) fail('not_authorized', 'Wrong Bot', 403);
    const v = validate(
      z.object({ answer: z.string().min(1).max(32000), revision: z.number().int() }).strict(),
      await body(req),
    );
    send(res, workflows.answer(wait.id, v.answer, v.revision, session.accountId));
    return true;
  }
  if (op === 'children' && method === 'POST') {
    const v = validate(
      z
        .object({
          parentRunId: z.string().uuid(),
          targetBotId: z.string().uuid(),
          objective: z.string().min(1).max(16000),
          allowedCapabilities: z.array(z.string()).default(['memory', 'library']),
          maxTurns: z.number().int().default(10),
        })
        .strict(),
      await body(req),
    );
    const r = store.get(v.parentRunId, 'run');
    if (r.botId !== botId || ['settled', 'failed', 'cancelled', 'interrupted'].includes(r.state))
      fail('not_running', 'Choose an active parent run', 409);
    if (!bot.capabilities.includes('delegation'))
      fail('not_authorized', 'Enable delegation in Bot settings', 403);
    const { parentRunId, ...args } = v;
    send(res, workflows.createChild(r, args), 202);
    return true;
  }
  if (op === 'knowledge') {
    if (method === 'GET') send(res, knowledge.search(botId, url.searchParams.get('query') ?? ''));
    else if (method === 'POST') send(res, knowledge.add(botId, await body(req)), 201);
    else return false;
    return true;
  }
  if (op.startsWith('knowledge/') && method === 'PATCH') {
    send(res, knowledge.revise(op.split('/')[1], botId, await body(req)));
    return true;
  }
  if (op === 'queue') {
    send(
      res,
      store
        .list('run', botId)
        .filter((r) => !['settled', 'failed', 'cancelled', 'interrupted'].includes(r.state))
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.acceptedAt - b.acceptedAt)
        .map((r) => ({ ...r, config: undefined })),
    );
    return true;
  }
  if (op.startsWith('queue/') && method === 'POST') {
    const run = store.get(op.split('/')[1], 'run');
    if (run.botId !== botId || run.state !== 'queued')
      fail('stale_revision', 'Only queued tasks can be reordered', 409);
    const v = validate(
      z
        .object({ priority: z.number().int().min(-100).max(100), revision: z.number().int() })
        .strict(),
      await body(req),
    );
    send(res, store.put('run', { ...run, priority: v.priority }, v.revision));
    return true;
  }
  return false;
}
