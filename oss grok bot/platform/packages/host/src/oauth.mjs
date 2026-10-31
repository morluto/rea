import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { id, fail } from './store.mjs';
import { hash } from './security.mjs';
import { validate } from './product.mjs';
import { providerPreset } from './provider-presets.mjs';
const PROVIDERS = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    identity: 'https://openidconnect.googleapis.com/v1/userinfo',
  },
  microsoft: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    identity: 'https://graph.microsoft.com/v1.0/me',
  },
};
export class OAuth {
  constructor(store, vault, connections, base, providers = PROVIDERS) {
    this.providers = providers;
    this.store = store;
    this.vault = vault;
    this.connections = connections;
    this.base = base;
    this.refreshes = new Map();
  }
  application(ownerId, provider) {
    validate(z.enum(['google', 'microsoft']), provider);
    const saved = this.store
      .list('oauth_application')
      .find((value) => value.ownerId === ownerId && value.provider === provider);
    return {
      provider,
      configured: !!saved?.clientId,
      clientId: saved?.clientId ?? '',
      hasClientSecret: !!saved?.secretRef,
      revision: saved?.revision ?? 0,
      redirectUri: this.base + (provider === 'google' ? '/' : '/api/oauth/callback'),
    };
  }
  updateCatalog(ownerId, key, input) {
    const value = validate(z.object({ revision: z.number().int() }).strict(), input);
    const connection = this.store.get(key, 'connection');
    if (connection.ownerId !== ownerId || !connection.enabled || !connection.oauth)
      fail('not_authorized', 'Own an enabled provider connection before updating tools', 403);
    if (connection.revision !== value.revision)
      fail('stale_revision', 'Connection changed; refresh before updating', 409);
    const preset = providerPreset(connection.oauth.provider, connection.oauth.service);
    if (preset.scope.some((scope) => !connection.oauth.scope.includes(scope)))
      fail('auth_required', 'New scopes require fresh provider consent', 409);
    const tools = preset.tools.map((tool) => ({
      ...tool,
      policy: connection.discoveredTools.find((prior) => prior.name === tool.name)?.policy ?? 'ask',
      annotations: {},
      outputSchema: null,
    }));
    const next = this.store.put(
      'connection',
      {
        ...connection,
        tools: preset.tools,
        discoveredTools: tools,
        catalogDigest: hash(JSON.stringify(tools)),
      },
      value.revision,
    );
    this.store.event(null, null, 'oauth.catalog_updated', {
      ownerId,
      connectionId: key,
      tools: tools.length,
    });
    return this.connections.public(next);
  }
  configureApplication(ownerId, provider, input) {
    this.application(ownerId, provider);
    const value = validate(
      z
        .object({
          clientId: z.string().trim().min(1).max(1000),
          clientSecret: z.string().max(4096).optional(),
          revision: z.number().int(),
        })
        .strict(),
      input,
    );
    const prior = this.store
      .list('oauth_application')
      .find((record) => record.ownerId === ownerId && record.provider === provider);
    if (value.revision !== (prior?.revision ?? 0))
      fail('stale_revision', 'App registration changed; refresh before saving', 409);
    return this.store.tx(() => {
      let secretRef = prior?.clientId === value.clientId ? prior.secretRef : null;
      if (value.clientSecret)
        secretRef = this.vault.save(value.clientSecret, secretRef ?? undefined);
      if (prior?.secretRef && prior.secretRef !== secretRef)
        this.store.db.prepare('DELETE FROM secrets WHERE id=?').run(prior.secretRef);
      this.store.put(
        'oauth_application',
        { id: prior?.id ?? id(), ownerId, provider, clientId: value.clientId, secretRef },
        prior?.revision,
      );
      return this.application(ownerId, provider);
    });
  }
  create(ownerId, input) {
    const v = validate(
      z
        .object({
          name: z.string().min(1).max(120),
          provider: z.enum(['google', 'microsoft']),
          service: z.enum(['mail', 'calendar']),
          clientId: z.string().min(1).max(1000).optional(),
          clientSecret: z.string().max(4096).optional(),
          botIds: z.array(z.string().uuid()),
        })
        .strict(),
      input,
    );
    const saved = !v.clientId
      ? this.store
          .list('oauth_application')
          .find((value) => value.ownerId === ownerId && value.provider === v.provider)
      : null;
    const clientId = v.clientId ?? saved?.clientId;
    if (!clientId)
      fail('setup_required', 'Set up this provider once before connecting plugins', 409);
    const clientSecret =
      v.clientSecret ?? (saved?.secretRef ? this.vault.read(saved.secretRef) : null);
    const preset = providerPreset(v.provider, v.service);
    const c = this.connections.create(ownerId, {
      name: v.name,
      kind: 'http',
      endpoint: preset.endpoint,
      botIds: v.botIds,
      tools: preset.tools,
      accountLabel: 'Not authenticated',
    });
    return this.connections.public(
      this.store.put('connection', {
        ...c,
        oauth: {
          provider: v.provider,
          service: v.service,
          redirectPath: saved && v.provider === 'google' ? '/' : '/api/oauth/callback',
          clientId,
          clientSecretRef: clientSecret ? this.vault.save(clientSecret) : null,
          tokenRef: null,
          state: 'unconfigured',
          scope: preset.scope,
        },
        state: 'auth_required',
      }),
    );
  }
  begin(connectionId, ownerId) {
    const c = this.store.get(connectionId, 'connection');
    if (c.ownerId !== ownerId || !c.oauth)
      fail('not_authorized', 'OAuth connection owner required', 403);
    for (const prior of this.store
      .list('oauth_flow')
      .filter((value) => value.connectionId === c.id && value.state === 'pending'))
      this.cancelFlow(prior.id, ownerId);
    const state = randomBytes(32).toString('base64url'),
      verifier = randomBytes(48).toString('base64url');
    const redirectUri = this.base + (c.oauth.redirectPath ?? '/api/oauth/callback');
    const flow = this.store.put('oauth_flow', {
      id: id(),
      ownerId,
      connectionId,
      generation: (c.oauth.generation ?? 0) + 1,
      stateHash: hash(state),
      verifierRef: this.vault.save(verifier),
      expiresAt: Date.now() + 600000,
      state: 'pending',
      redirectUri,
    });
    this.store.put('connection', {
      ...c,
      enabled: true,
      state: 'auth_required',
      oauth: {
        ...c.oauth,
        state: 'auth_required',
        pendingFlowId: flow.id,
        generation: (c.oauth.generation ?? 0) + 1,
      },
    });
    const u = new URL(this.providers[c.oauth.provider].authorize);
    for (const [key, value] of Object.entries({
      client_id: c.oauth.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: c.oauth.scope.join(' '),
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      ...(c.oauth.provider === 'google'
        ? { access_type: 'offline', prompt: 'consent' }
        : { response_mode: 'query' }),
    }))
      u.searchParams.set(key, value);
    return {
      id: flow.id,
      authorizeUrl: u.href,
      redirectUri,
      scope: c.oauth.scope,
      expiresAt: Date.now() + 600000,
    };
  }
  flow(flowId, ownerId) {
    let flow = this.store.get(flowId, 'oauth_flow');
    if (flow.ownerId !== ownerId) fail('not_authorized', 'Sign-in owner required', 403);
    const connection = this.store.get(flow.connectionId, 'connection');
    if (
      flow.state === 'connected' &&
      (!connection.enabled || connection.oauth?.generation !== flow.generation)
    )
      return {
        id: flow.id,
        state: 'superseded',
        expiresAt: flow.expiresAt,
        connectionId: flow.connectionId,
      };
    if (flow.state === 'pending' && flow.expiresAt <= Date.now()) {
      this.cancelFlow(flowId, ownerId);
      flow = this.store.put('oauth_flow', {
        ...this.store.get(flowId, 'oauth_flow'),
        state: 'expired',
      });
    }
    return {
      id: flow.id,
      state: flow.state,
      expiresAt: flow.expiresAt,
      connectionId: flow.connectionId,
    };
  }
  cancelFlow(flowId, ownerId) {
    const flow = this.store.get(flowId, 'oauth_flow');
    if (flow.ownerId !== ownerId) fail('not_authorized', 'Sign-in owner required', 403);
    if (!['pending', 'consumed'].includes(flow.state)) return;
    this.store.put('oauth_flow', { ...flow, state: 'cancelled' });
    this.store.db.prepare('DELETE FROM secrets WHERE id=?').run(flow.verifierRef);
    const connection = this.store.get(flow.connectionId, 'connection');
    if (connection.oauth?.pendingFlowId === flowId)
      this.store.put('connection', {
        ...connection,
        state: connection.oauth.tokenRef ? 'configured' : 'auth_required',
        oauth: {
          ...connection.oauth,
          pendingFlowId: null,
          state: connection.oauth.tokenRef ? 'authenticated' : 'unconfigured',
        },
      });
  }
  async exchange(c, params) {
    const oauth = c.oauth;
    const body = new URLSearchParams({
      ...params,
      client_id: oauth.clientId,
      ...(oauth.clientSecretRef ? { client_secret: this.vault.read(oauth.clientSecretRef) } : {}),
    });
    let response;
    try {
      response = await fetch(this.providers[oauth.provider].token, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      fail('auth_unavailable', 'OAuth token endpoint is unavailable; reconnect explicitly', 409);
    }
    const data = await response.json();
    if (!response.ok || typeof data.access_token !== 'string')
      fail('auth_expired', 'Provider refused authentication; reconnect the selected account', 409);
    return data;
  }
  async callback(query) {
    const state = query.get('state');
    const flow = this.store
      .list('oauth_flow')
      .find(
        (f) =>
          f.stateHash === hash(state ?? '') && f.state === 'pending' && f.expiresAt > Date.now(),
      );
    if (!flow) fail('not_authorized', 'OAuth flow expired or was already consumed', 403);
    this.store.put('oauth_flow', { ...flow, state: 'consumed' });
    try {
      if (query.get('error'))
        fail('auth_denied', 'The provider did not authorize this connection', 409);
      const code = query.get('code');
      if (!code) fail('invalid_input', 'OAuth callback did not contain a code');
      const currentConnection = () => {
        const current = this.store.get(flow.connectionId, 'connection');
        if (!current.enabled || current.oauth?.pendingFlowId !== flow.id)
          fail('auth_revoked', 'Connection was disconnected or reauthorized during sign-in', 409);
        return current;
      };
      const c = currentConnection();
      const tokens = await this.exchange(c, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: flow.redirectUri,
        code_verifier: this.vault.read(flow.verifierRef),
      });
      currentConnection();
      const response = await fetch(this.providers[c.oauth.provider].identity, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        fail(
          'auth_unverified',
          'Provider identity could not be verified; reconnect before using the account',
          409,
        );
      const identity = await response.json();
      const account = identity.email ?? identity.mail ?? identity.userPrincipalName;
      const subject = identity.sub ?? identity.id;
      if (typeof account !== 'string' || typeof subject !== 'string')
        fail('auth_unverified', 'Provider identity omitted account identity');
      const latest = currentConnection();
      const tokenRef = this.vault.save(JSON.stringify(tokens), latest.oauth.tokenRef ?? undefined);
      const oauth = {
        ...latest.oauth,
        tokenRef,
        state: 'authenticated',
        pendingFlowId: null,
        accountSubject: subject,
        accountEmail: account,
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      };
      const next = this.store.put('connection', {
        ...latest,
        oauth,
        accountLabel: account,
        state: 'configured',
        discoveredTools: c.tools.map((t) => ({ ...t, annotations: {}, outputSchema: null })),
        lastCheck: Date.now(),
      });
      this.store.put('oauth_flow', {
        ...this.store.get(flow.id, 'oauth_flow'),
        state: 'connected',
      });
      return this.connections.public(next);
    } catch (error) {
      const latestFlow = this.store.get(flow.id, 'oauth_flow');
      if (latestFlow.state === 'consumed')
        this.store.put('oauth_flow', { ...latestFlow, state: 'failed' });
      throw error;
    } finally {
      this.store.db.prepare('DELETE FROM secrets WHERE id=?').run(flow.verifierRef);
    }
  }
  async bearer(c) {
    if (!c.oauth) return c.secretRef ? this.vault.read(c.secretRef) : null;
    const current = this.store.get(c.id, 'connection');
    if (!current.enabled || !current.oauth?.tokenRef)
      fail('auth_required', 'Authenticate the selected connector account first', 409);
    let tokens = JSON.parse(this.vault.read(current.oauth.tokenRef));
    if (current.oauth.expiresAt > Date.now() + 60000) return tokens.access_token;
    if (this.refreshes.has(c.id)) return this.refreshes.get(c.id);
    const promise = (async () => {
      try {
        if (!tokens.refresh_token)
          fail('auth_expired', 'The selected account needs reauthentication', 409);
        const updated = await this.exchange(current, {
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
        });
        tokens = { ...tokens, ...updated };
        const latest = this.store.get(c.id, 'connection');
        if (
          !latest.enabled ||
          latest.oauth?.tokenRef !== current.oauth.tokenRef ||
          latest.oauth?.generation !== current.oauth.generation
        )
          fail('auth_revoked', 'Connection changed while refreshing credentials', 409);
        this.vault.save(JSON.stringify(tokens), current.oauth.tokenRef);
        this.store.put('connection', {
          ...latest,
          oauth: {
            ...latest.oauth,
            state: 'authenticated',
            expiresAt: Date.now() + (updated.expires_in ?? 3600) * 1000,
          },
        });
        return tokens.access_token;
      } catch (e) {
        const latest = this.store.get(c.id, 'connection');
        if (
          latest.enabled &&
          latest.oauth?.tokenRef === current.oauth.tokenRef &&
          latest.oauth?.generation === current.oauth.generation
        )
          this.store.put('connection', {
            ...latest,
            oauth: { ...latest.oauth, state: 'expired' },
            state: 'auth_required',
          });
        throw e;
      } finally {
        this.refreshes.delete(c.id);
      }
    })();
    this.refreshes.set(c.id, promise);
    return promise;
  }
  disconnect(key, ownerId) {
    const c = this.store.get(key, 'connection');
    if (c.ownerId !== ownerId || !c.oauth)
      fail('not_authorized', 'OAuth connection owner required', 403);
    if (c.oauth.tokenRef)
      this.store.db.prepare('DELETE FROM secrets WHERE id=?').run(c.oauth.tokenRef);
    for (const f of this.store
      .list('oauth_flow')
      .filter((f) => f.connectionId === key && ['pending', 'consumed'].includes(f.state))) {
      this.store.put('oauth_flow', { ...f, state: 'expired' });
      if (f.verifierRef) this.store.db.prepare('DELETE FROM secrets WHERE id=?').run(f.verifierRef);
    }
    return this.connections.public(
      this.store.put('connection', {
        ...c,
        enabled: false,
        state: 'disconnected',
        oauth: {
          ...c.oauth,
          tokenRef: null,
          state: 'disconnected',
          pendingFlowId: null,
          generation: (c.oauth.generation ?? 0) + 1,
        },
      }),
    );
  }
}
