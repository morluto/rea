import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { validate } from './product.mjs';
import { fail, id } from './store.mjs';
export const pluginCatalog = JSON.parse(
  readFileSync(new URL('./plugin-catalog.json', import.meta.url), 'utf8'),
);
const Setup = z
  .object({
    revision: z.number().int().optional(),
    botIds: z.array(z.string().uuid()).max(100),
    endpoint: z.url().optional(),
    auth: z.enum(['oauth', 'token', 'none']).default('oauth'),
    token: z.string().max(8192).optional(),
    clientId: z.string().max(1000).optional(),
    clientSecret: z.string().max(4096).optional(),
    accountLabel: z.string().max(200).default('User configured account'),
  })
  .strict();
const ServerInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    endpoint: z.url().refine((value) => {
      const target = new URL(value);
      return ['http:', 'https:'].includes(target.protocol) && !target.username && !target.password;
    }, 'Use an HTTP(S) URL without embedded credentials'),
    auth: z.enum(['oauth', 'token', 'none']).default('none'),
    token: z.string().max(8192).optional(),
    clientId: z.string().max(1000).optional(),
    clientSecret: z.string().max(4096).optional(),
    accountLabel: z.string().max(200).default('User configured account'),
    botIds: z.array(z.string().uuid()).max(100),
  })
  .strict();
export class Plugins {
  constructor(store, connections, oauth, vault) {
    Object.assign(this, { store, connections, oauth, vault });
  }
  list(ownerId) {
    return pluginCatalog.map((recipe) => {
      const installed = this.store
        .list('plugin_install')
        .find((p) => p.ownerId === ownerId && p.pluginId === recipe.id);
      const connection = installed?.connectionId
        ? this.connections.public(this.store.get(installed.connectionId, 'connection'))
        : null;
      return {
        ...recipe,
        updateAvailable:
          installed?.state === 'installed' && installed.version !== recipe.version
            ? { installed: installed.version, catalog: recipe.version }
            : null,
        sandbox:
          recipe.setup === 'skill'
            ? 'Skills run as model guidance text only; they cannot call tools, reach the network, or access credentials.'
            : 'Connector calls run host-side with explicit grants; returned app views render in the workspace sandbox without product API access.',
        connectionReady:
          installed?.state === 'installed' &&
          (recipe.setup === 'skill'
            ? this.store.get(installed.extensionId, 'extension').state === 'enabled'
            : !!connection?.enabled &&
              (connection.oauth
                ? connection.oauth.state === 'authenticated'
                : connection.state === 'ready')),
        signInReady:
          recipe.setup === 'oauth'
            ? this.oauth.application(ownerId, recipe.provider).configured
            : !!recipe.endpoint,
        installed: installed ? { ...installed, connection } : null,
      };
    });
  }
  configure(ownerId, pluginId, input) {
    const recipe = pluginCatalog.find((p) => p.id === pluginId);
    if (!recipe) fail('not_found', 'Plugin not found', 404);
    const v = validate(Setup, input);
    const prior = this.store
      .list('plugin_install')
      .find((p) => p.ownerId === ownerId && p.pluginId === pluginId);
    if (prior && v.revision !== prior.revision)
      fail('stale_revision', 'Plugin changed; refresh before saving', 409);
    for (const key of v.botIds)
      if (this.store.get(key, 'bot').ownerId !== ownerId)
        fail('not_authorized', 'Bot owner required', 403);
    if (
      recipe.setup === 'oauth' &&
      !v.clientId &&
      !this.oauth.application(ownerId, recipe.provider).configured
    )
      fail('setup_required', 'Set up this provider once before connecting plugins', 409);
    if (recipe.setup === 'mcp' && !(v.endpoint ?? recipe.endpoint))
      fail('invalid_input', 'Provide the MCP server URL for this app');
    if (recipe.setup === 'mcp' && v.auth === 'token' && !v.token)
      fail('invalid_input', 'Enter the API key or bearer token for this configuration');
    return this.store.tx(() => {
      if (recipe.setup !== 'skill') this.grantExtensions(ownerId, v.botIds);
      if (prior) this.disconnect(prior);
      let connectionId = null,
        extensionId = null;
      if (recipe.setup === 'skill')
        extensionId = this.store.put('extension', {
          id: id(),
          ownerId,
          name: recipe.name,
          type: 'skill',
          version: recipe.version,
          source: 'Bundled Orbit workflow',
          instructions: recipe.instructions,
          botIds: v.botIds,
          state: 'enabled',
          capabilities: [],
        }).id;
      else if (recipe.setup === 'oauth')
        connectionId = this.oauth.create(ownerId, {
          name: recipe.name,
          provider: recipe.provider,
          service: recipe.service,
          clientId: v.clientId,
          ...(v.clientSecret ? { clientSecret: v.clientSecret } : {}),
          botIds: v.botIds,
        }).id;
      else {
        let c = this.connections.create(ownerId, {
          name: recipe.name,
          kind: 'mcp',
          endpoint: v.endpoint ?? recipe.endpoint,
          botIds: v.botIds,
          accountLabel: v.accountLabel,
          ...(v.auth === 'token' && v.token ? { token: v.token } : {}),
        });
        if (v.auth === 'oauth') {
          const clientRef = v.clientId
            ? this.vault.save(
                JSON.stringify({
                  client_id: v.clientId,
                  ...(v.clientSecret ? { client_secret: v.clientSecret } : {}),
                }),
              )
            : null;
          c = this.store.put('connection', {
            ...c,
            state: 'auth_required',
            mcpOAuth: {
              state: 'auth_required',
              generation: 0,
              ...(clientRef ? { clientRef } : {}),
            },
          });
        }
        connectionId = c.id;
      }
      const installed = this.store.put(
        'plugin_install',
        {
          id: prior?.id ?? id(),
          ownerId,
          pluginId,
          version: recipe.version,
          state: 'installed',
          botIds: v.botIds,
          connectionId,
          extensionId,
        },
        prior?.revision,
      );
      this.store.event(null, null, 'plugin.configured', { id: installed.id, pluginId, ownerId });
      return this.list(ownerId).find((p) => p.id === pluginId);
    });
  }
  addServer(ownerId, input) {
    const v = validate(ServerInput, input);
    if (v.auth === 'token' && !v.token)
      fail('invalid_input', 'Enter the API key or bearer token for this server');
    for (const botId of v.botIds)
      if (this.store.get(botId, 'bot').ownerId !== ownerId)
        fail('not_authorized', 'Bot owner required', 403);
    return this.store.tx(() => {
      this.grantExtensions(ownerId, v.botIds);
      let connection = this.connections.create(ownerId, {
        name: v.name,
        kind: 'mcp',
        endpoint: v.endpoint,
        botIds: v.botIds,
        accountLabel: v.accountLabel,
        ...(v.auth === 'token' ? { token: v.token } : {}),
      });
      if (v.auth === 'oauth') {
        const clientRef = v.clientId
          ? this.vault.save(
              JSON.stringify({
                client_id: v.clientId,
                ...(v.clientSecret ? { client_secret: v.clientSecret } : {}),
              }),
            )
          : null;
        connection = this.store.put('connection', {
          ...connection,
          state: 'auth_required',
          mcpOAuth: {
            state: 'auth_required',
            generation: 0,
            ...(clientRef ? { clientRef } : {}),
          },
        });
      }
      this.store.event(null, null, 'plugin.server_added', { id: connection.id, ownerId });
      return this.connections.public(connection);
    });
  }
  grantExtensions(ownerId, botIds) {
    for (const botId of botIds) {
      const bot = this.store.get(botId, 'bot');
      if (bot.ownerId !== ownerId) fail('not_authorized', 'Bot owner required', 403);
      if (bot.capabilities.includes('extensions')) continue;
      this.store.put('bot', { ...bot, capabilities: [...bot.capabilities, 'extensions'] });
    }
  }
  async connect(ownerId, pluginId, input) {
    const recipe = pluginCatalog.find((value) => value.id === pluginId);
    if (!recipe) fail('not_found', 'Plugin not found', 404);
    const value = validate(
      z.object({ botIds: z.array(z.string().uuid()).max(100) }).strict(),
      input,
    );
    let plugin = this.list(ownerId).find((value) => value.id === pluginId);
    if (plugin.installed?.state !== 'installed')
      plugin = this.configure(ownerId, pluginId, {
        botIds: value.botIds,
        ...(plugin.installed ? { revision: plugin.installed.revision } : {}),
      });
    const connection = plugin.installed.connection;
    if (recipe.setup === 'skill') return { plugin, authorization: null };
    if (connection.oauth)
      return {
        plugin,
        authorization: { ...this.oauth.begin(connection.id, ownerId), type: 'oauth' },
      };
    if (connection.mcpOAuth) {
      const flow = await this.connections.mcpOAuth.begin(connection.id, ownerId);
      return {
        plugin,
        authorization: { ...flow, authorizeUrl: flow.authorizationUrl, type: 'mcp' },
      };
    }
    await this.connections.discover(connection.id);
    return {
      plugin: this.list(ownerId).find((value) => value.id === pluginId),
      authorization: null,
    };
  }
  disconnect(installed) {
    if (installed.connectionId) {
      const c = this.store.get(installed.connectionId, 'connection');
      if (c.ownerId !== installed.ownerId)
        fail('ownership_unknown', 'Plugin connection ownership changed', 409);
      if (c.oauth) this.oauth.disconnect(c.id, installed.ownerId);
      if (c.oauth?.clientSecretRef)
        this.store.db.prepare('DELETE FROM secrets WHERE id=?').run(c.oauth.clientSecretRef);
      if (c.mcpOAuth) this.connections.mcpOAuth.clear(c.id);
      if (c.secretRef) this.store.db.prepare('DELETE FROM secrets WHERE id=?').run(c.secretRef);
      const current = this.store.get(c.id, 'connection');
      this.store.put('connection', {
        ...current,
        enabled: false,
        botIds: [],
        secretRef: null,
        state: 'disconnected',
        ...(current.oauth ? { oauth: { ...current.oauth, clientSecretRef: null } } : {}),
      });
      for (const f of this.store
        .list('mcp_oauth_flow')
        .filter((f) => f.connectionId === c.id && f.state === 'pending')) {
        this.connections.mcpOAuth.releaseFlow(f);
        this.store.put('mcp_oauth_flow', { ...f, state: 'expired', authorizationUrl: undefined });
      }
    }
    if (installed.extensionId) {
      const e = this.store.get(installed.extensionId, 'extension');
      if (e.ownerId !== installed.ownerId)
        fail('ownership_unknown', 'Plugin skill ownership changed', 409);
      this.store.put('extension', { ...e, state: 'disabled', botIds: [] });
    }
  }
  uninstall(ownerId, pluginId, revision) {
    const p = this.store
      .list('plugin_install')
      .find((p) => p.ownerId === ownerId && p.pluginId === pluginId);
    if (!p) fail('not_found', 'Installed plugin not found', 404);
    if (p.revision !== revision)
      fail('stale_revision', 'Plugin changed; refresh before removing', 409);
    return this.store.tx(() => {
      this.disconnect(p);
      const value = this.store.put('plugin_install', { ...p, state: 'uninstalled' }, revision);
      this.store.event(null, null, 'plugin.uninstalled', { id: p.id, pluginId, ownerId });
      return value;
    });
  }
}
