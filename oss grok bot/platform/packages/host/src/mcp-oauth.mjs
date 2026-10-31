import { auth as authorize } from '@modelcontextprotocol/sdk/client/auth.js';
import { randomBytes } from 'node:crypto';
import { hash } from './security.mjs';
import { fail, id } from './store.mjs';

// The SDK owns MCP OAuth discovery/PKCE/issuer binding/refresh. This owner keeps
// each connection's credentials isolated in the platform vault, never ambient stores.
export class McpOAuth {
  constructor(store, vault) {
    this.store = store;
    this.vault = vault;
    this.base = null;
  }
  connection(key) {
    const c = this.store.get(key, 'connection');
    if (c.kind !== 'mcp' || !c.enabled)
      fail('not_authorized', 'This MCP connection is disabled', 403);
    return c;
  }
  read(key, slot) {
    const ref = this.connection(key).mcpOAuth?.[slot];
    return ref ? JSON.parse(this.vault.read(ref)) : undefined;
  }
  save(key, slot, value) {
    const c = this.connection(key),
      state = c.mcpOAuth ?? {};
    const ref = this.vault.save(JSON.stringify(value), state[slot]);
    this.store.put('connection', {
      ...c,
      mcpOAuth: {
        ...state,
        [slot]: ref,
        ...(slot === 'tokenRef' ? { state: 'authorized', authorizedAt: Date.now() } : {}),
      },
    });
  }
  provider(key, flow = null, observeCredential = () => {}) {
    const owner = this;
    const generation = flow?.generation ?? owner.connection(key).mcpOAuth?.generation;
    const guard = () => {
      const current = owner.connection(key);
      if (current.mcpOAuth?.generation !== generation)
        fail('auth_revoked', 'MCP authorization changed', 409);
      if (
        flow &&
        !['pending', 'exchanging'].includes(owner.store.get(flow.id, 'mcp_oauth_flow').state)
      )
        fail('auth_revoked', 'MCP authorization flow ended', 409);
    };
    const redirectUrl = flow?.redirectUri ?? owner.connection(key).mcpOAuth?.redirectUri;
    return {
      redirectUrl,
      clientMetadata: {
        client_name: 'Orbit',
        redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      clientInformation: () => {
        guard();
        return owner.read(key, 'clientRef');
      },
      saveClientInformation: (value) => {
        guard();
        owner.save(key, 'clientRef', value);
      },
      tokens: () => {
        guard();
        const tokens = flow ? undefined : owner.read(key, 'tokenRef');
        if (tokens?.access_token) observeCredential(tokens.access_token);
        return tokens;
      },
      saveTokens: (value) => {
        guard();
        if (value.access_token) observeCredential(value.access_token);
        owner.save(key, 'tokenRef', value);
      },
      state: () => {
        if (!flow) fail('auth_required', 'Reconnect this app from Plugins', 409);
        return owner.vault.read(flow.stateRef);
      },
      redirectToAuthorization: (url) => {
        guard();
        if (!flow) fail('auth_required', 'Reconnect this app from Plugins', 409);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          fail('invalid_authorization', 'Invalid authorization address', 409);
        owner.store.put('mcp_oauth_flow', {
          ...owner.store.get(flow.id, 'mcp_oauth_flow'),
          authorizationUrl: url.href,
        });
      },
      saveCodeVerifier: (value) => {
        guard();
        if (!flow) fail('auth_required', 'Reconnect this app from Plugins', 409);
        const current = owner.store.get(flow.id, 'mcp_oauth_flow');
        owner.store.put('mcp_oauth_flow', {
          ...current,
          verifierRef: owner.vault.save(value, current.verifierRef),
        });
      },
      codeVerifier: () => {
        if (!flow?.verifierRef) fail('auth_required', 'Authorization expired; connect again', 409);
        return owner.vault.read(flow.verifierRef);
      },
      discoveryState: () => {
        guard();
        return owner.read(key, 'discoveryRef');
      },
      saveDiscoveryState: (value) => {
        guard();
        owner.save(key, 'discoveryRef', value);
      },
      invalidateCredentials: (scope) => {
        guard();
        owner.clear(key, scope);
      },
    };
  }
  clear(key, scope = 'all') {
    const c = this.store.get(key, 'connection'),
      value = { ...c.mcpOAuth };
    for (const slot of ['clientRef', 'tokenRef', 'discoveryRef']) {
      if (
        scope !== 'all' &&
        slot !== { client: 'clientRef', tokens: 'tokenRef', discovery: 'discoveryRef' }[scope]
      )
        continue;
      if (value[slot]) this.store.db.prepare('DELETE FROM secrets WHERE id=?').run(value[slot]);
      delete value[slot];
    }
    if (scope === 'all' || scope === 'tokens') value.state = 'auth_required';
    this.store.put('connection', { ...c, mcpOAuth: value });
  }
  async begin(key, ownerId) {
    let c = this.connection(key);
    if (c.ownerId !== ownerId) fail('not_authorized', 'Connection owner required', 403);
    if (!this.base) fail('unavailable', 'Primary host is not ready', 409);
    for (const old of this.store
      .list('mcp_oauth_flow')
      .filter((f) => f.connectionId === key && f.state === 'pending')) {
      this.store.put('mcp_oauth_flow', { ...old, state: 'expired' });
      this.releaseFlow(old);
    }
    this.clear(key, 'tokens');
    c = this.connection(key);
    const state = randomBytes(32).toString('base64url'),
      redirectUri = this.base + '/api/mcp/oauth/callback';
    this.store.put('connection', {
      ...c,
      state: 'auth_required',
      mcpOAuth: {
        ...c.mcpOAuth,
        state: 'auth_required',
        redirectUri,
        generation: (c.mcpOAuth?.generation ?? 0) + 1,
      },
    });
    const flow = this.store.put('mcp_oauth_flow', {
      id: id(),
      connectionId: key,
      ownerId,
      state: 'pending',
      stateHash: hash(state),
      stateRef: this.vault.save(state),
      redirectUri,
      endpoint: c.endpoint,
      generation: (c.mcpOAuth?.generation ?? 0) + 1,
      expiresAt: Date.now() + 600000,
    });
    try {
      const signal = AbortSignal.timeout(30000);
      await authorize(this.provider(key, flow), {
        serverUrl: c.endpoint,
        fetchFn: (url, init) => fetch(url, { ...init, signal }),
      });
      const saved = this.store.get(flow.id, 'mcp_oauth_flow');
      if (!saved.authorizationUrl)
        fail('auth_required', 'The server did not provide an interactive authorization flow', 409);
      return { id: flow.id, authorizationUrl: saved.authorizationUrl, expiresAt: flow.expiresAt };
    } catch (e) {
      const latest = this.store.get(flow.id, 'mcp_oauth_flow');
      if (latest.state === 'pending')
        this.store.put('mcp_oauth_flow', {
          ...latest,
          state: 'failed',
          authorizationUrl: undefined,
        });
      this.releaseFlow(this.store.get(flow.id, 'mcp_oauth_flow'));
      fail(
        'auth_required',
        'MCP sign-in could not start. The provider may require a registered client or a different server URL.',
        409,
      );
    }
  }
  releaseFlow(flow) {
    for (const ref of [flow.stateRef, flow.verifierRef])
      if (ref) this.store.db.prepare('DELETE FROM secrets WHERE id=?').run(ref);
  }
  flow(flowId, ownerId) {
    let flow = this.store.get(flowId, 'mcp_oauth_flow');
    if (flow.ownerId !== ownerId) fail('not_authorized', 'Sign-in owner required', 403);
    const connection = this.store.get(flow.connectionId, 'connection');
    if (
      !connection.enabled ||
      connection.mcpOAuth?.generation !== flow.generation ||
      connection.endpoint !== flow.endpoint
    )
      return {
        id: flow.id,
        state: 'superseded',
        connectionId: flow.connectionId,
        expiresAt: flow.expiresAt,
      };
    if (flow.state === 'pending' && flow.expiresAt <= Date.now()) {
      this.cancelFlow(flow.id, ownerId);
      flow = this.store.put('mcp_oauth_flow', {
        ...this.store.get(flow.id, 'mcp_oauth_flow'),
        state: 'expired',
      });
    }
    return {
      id: flow.id,
      state: flow.state,
      connectionId: flow.connectionId,
      expiresAt: flow.expiresAt,
    };
  }
  cancelFlow(flowId, ownerId) {
    const flow = this.store.get(flowId, 'mcp_oauth_flow');
    if (flow.ownerId !== ownerId) fail('not_authorized', 'Sign-in owner required', 403);
    if (!['pending', 'exchanging'].includes(flow.state)) return;
    this.store.put('mcp_oauth_flow', { ...flow, state: 'cancelled', authorizationUrl: undefined });
    this.releaseFlow(flow);
    const connection = this.store.get(flow.connectionId, 'connection');
    if (connection.enabled && connection.mcpOAuth?.generation === flow.generation)
      this.clear(connection.id, 'tokens');
  }
  async callback(params) {
    const state = params.get('state') ?? '',
      code = params.get('code');
    const flow = this.store.list('mcp_oauth_flow').find((f) => f.stateHash === hash(state));
    if (!flow || flow.state !== 'pending' || flow.expiresAt < Date.now())
      fail('invalid_authorization', 'Authorization expired or already used', 409);
    const c = this.connection(flow.connectionId);
    if (c.ownerId !== flow.ownerId || c.endpoint !== flow.endpoint)
      fail('not_authorized', 'Connection changed during authorization', 403);
    this.store.put('mcp_oauth_flow', { ...flow, state: 'exchanging', authorizationUrl: undefined });
    try {
      if (!code || params.has('error')) fail('auth_required', 'Authorization was declined', 409);
      const signal = AbortSignal.timeout(30000);
      const result = await authorize(this.provider(c.id, flow), {
        serverUrl: c.endpoint,
        authorizationCode: code,
        fetchFn: (url, init) => fetch(url, { ...init, signal }),
      });
      if (result !== 'AUTHORIZED') fail('auth_required', 'Authorization did not finish', 409);
      if (this.store.get(flow.id, 'mcp_oauth_flow').state !== 'exchanging')
        fail('auth_revoked', 'Sign-in was cancelled', 409);
      const current = this.connection(c.id);
      this.store.put('connection', {
        ...current,
        state: 'unverified',
        accountLabel: 'OAuth account (provider-managed identity)',
      });
      this.store.put('mcp_oauth_flow', {
        ...flow,
        state: 'completed',
        authorizationUrl: undefined,
      });
    } catch {
      const latest = this.store.get(flow.id, 'mcp_oauth_flow');
      if (latest.state === 'exchanging')
        this.store.put('mcp_oauth_flow', {
          ...latest,
          state: 'failed',
          authorizationUrl: undefined,
        });
      fail(
        'auth_required',
        'Authorization did not complete. Reconnect this app to try again.',
        409,
      );
    } finally {
      this.releaseFlow(flow);
    }
  }
}
