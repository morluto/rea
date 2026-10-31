import { artifactCapabilities } from './product.mjs';
import { conversationPreview } from './sidebar-preview.mjs';

export function libraryOverview(store, bot) {
  const revisions = store.list('artifact_revision', bot.id);
  const accounts = new Map(store.list('account').map(({ id, name }) => [id, name]));
  return {
    artifacts: store.list('artifact', bot.id),
    revisions: revisions.map((revision) => ({
      ...revision,
      ...artifactCapabilities(revision),
      publishedBy: revision.sourceRun
        ? { kind: 'bot', id: bot.id, name: bot.name }
        : revision.publisherAccountId && accounts.has(revision.publisherAccountId)
          ? {
              kind: 'account',
              id: revision.publisherAccountId,
              name: accounts.get(revision.publisherAccountId),
            }
          : { kind: 'unknown' },
    })),
  };
}

export function workspaceState(store, access, workflows, session, publicModel) {
  const bots = store
      .list('bot')
      .filter((b) => access.bot(session.accountId, b.id))
      .map((b) => ({
        ...b,
        activity: workflows.activity(b.id),
        preview: conversationPreview(store.list('conversation', b.id)),
        accessRole:
          b.ownerId === session.accountId
            ? 'owner'
            : access.bot(session.accountId, b.id, true)
              ? 'operator'
              : 'viewer',
      })),
    ids = new Set(bots.map((b) => b.id)),
    routines = store.list('routine').filter((r) => ids.has(r.botId) && r.enabled),
    visible = bots.filter((b) => !b.retired);
  return {
    account: {
      id: session.accountId,
      name: store.get(session.accountId, 'account').name,
      isAdmin: access.admin(session.accountId),
    },
    bots,
    models: store
      .list('model')
      .filter((m) => access.ownedModel(m, session.accountId))
      .map(publicModel),
    computers: store
      .list('computer')
      .filter((c) => ids.has(c.botId))
      .map((c) => ({ ...c, secretRef: undefined, guestPort: undefined })),
    settings: store.list('settings').find((s) => s.ownerId === session.accountId) ??
      store
        .list('settings')
        .find((s) => !s.ownerId && store.list('account')[0]?.id === session.accountId) ?? {
        id: `settings-${session.accountId}`,
        theme: 'system',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timezoneAuto: true,
        accent: 'bot',
        language: 'system',
        microphone: 'system',
        hardwareAcceleration: true,
      },
    extensions: store
      .list('extension')
      .filter((e) => (e.ownerId ?? store.list('account')[0]?.id) === session.accountId),
    summary: {
      working: visible.filter((b) => b.activity.state === 'working').length,
      waiting: visible.filter((b) => b.activity.state === 'waiting').length,
      routines: routines.length,
      nextRoutine: routines.sort((a, b) => a.nextAt - b.nextAt)[0] ?? null,
      notifications: store
        .list('notification')
        .filter((n) => n.ownerId === session.accountId && !n.read).length,
    },
    capabilities: {
      chat: true,
      memory: true,
      library: true,
      routines: true,
      docker: 'probe_required',
      connectors: 'explicit_configuration_required',
      devices: 'pairing_required',
      voice: 'browser_dependent',
      teams: true,
    },
  };
}
