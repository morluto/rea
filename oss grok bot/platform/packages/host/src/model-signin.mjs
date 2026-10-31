import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { fail, id } from './store.mjs';
import { version } from './version.mjs';

// Pi owns authorization/PKCE/callbacks and token refresh. The host owns each
// selected model connection, its encrypted credential, and revocation generation.
export class ModelSignIn {
  constructor(store, vault, providerFactory = openaiProvider) {
    Object.assign(this, { store, vault, providerFactory });
    this.flows = new Map();
    this.writes = new Map();
  }
  catalog() {
    return this.providerFactory()
      .getModels()
      .map(({ id, name }) => ({ id, name }));
  }
  create(ownerId, { name, model }) {
    const selected = this.providerFactory()
      .getModels()
      .find((m) => m.id === model);
    if (!selected) fail('invalid_input', 'Choose a model from the installed provider catalog');
    return this.store.put('model', {
      id: id(),
      ownerId,
      name,
      model,
      authMode: 'chatgpt',
      endpoint: 'https://api.openai.com/v1',
      api: 'openai-responses',
      contextWindow: selected.contextWindow,
      maxTokens: selected.maxTokens,
      vision: selected.input.includes('image'),
      reasoning: selected.reasoning,
      secretRef: null,
      generation: 0,
      oauthState: 'disconnected',
      connection: 'unverified',
      cost: null,
    });
  }
  owned(key, ownerId) {
    const c = this.store.get(key, 'model');
    if (c.ownerId !== ownerId || c.authMode !== 'chatgpt')
      fail('not_authorized', 'ChatGPT connection owner required', 403);
    return c;
  }
  credentials(key, generation) {
    const owner = this;
    const current = () => {
      const c = owner.store.get(key, 'model');
      if (c.authMode !== 'chatgpt' || c.generation !== generation)
        fail('auth_revoked', 'Model authorization changed; reconnect explicitly', 409);
      return c;
    };
    const read = async (provider) => {
      if (provider !== 'openai') return undefined;
      const c = current();
      return c.secretRef ? JSON.parse(owner.vault.read(c.secretRef)) : undefined;
    };
    return {
      read,
      list: async () => (current().secretRef ? [{ providerId: 'openai', type: 'oauth' }] : []),
      modify: (provider, fn, options) => {
        if (provider !== 'openai')
          fail('not_authorized', 'Only the selected provider is available');
        const pending = (owner.writes.get(key) ?? Promise.resolve())
          .catch(() => {})
          .then(async () => {
            options?.signal?.throwIfAborted();
            const credential = await fn(await read(provider));
            options?.signal?.throwIfAborted();
            const c = current();
            if (credential !== undefined) {
              if (credential.type !== 'oauth')
                fail('invalid_credential', 'An OAuth grant is required');
              const secretRef = owner.vault.save(
                JSON.stringify(credential),
                c.secretRef ?? undefined,
              );
              owner.store.put('model', { ...c, secretRef, oauthState: 'connected' });
            }
            return credential ?? read(provider);
          });
        owner.writes.set(key, pending);
        void pending
          .finally(() => {
            if (owner.writes.get(key) === pending) owner.writes.delete(key);
          })
          .catch(() => {});
        return pending;
      },
      delete: async () => {
        fail('not_authorized', 'Disconnect the owned model connection instead');
      },
    };
  }
  provider() {
    const p = this.providerFactory();
    // Subscription connections never fall back to ambient OPENAI_API_KEY.
    return { ...p, auth: { oauth: p.auth.oauth } };
  }
  publicFlow(flow) {
    return {
      id: flow.id,
      modelId: flow.modelId,
      state: flow.state,
      expiresAt: flow.expiresAt,
      authorizationUrl: flow.state === 'pending' ? flow.authorizationUrl : undefined,
      prompt: flow.state === 'pending' ? flow.prompt : undefined,
      message: flow.message,
    };
  }
  flow(key, ownerId) {
    const f = this.flows.get(key);
    if (!f || f.ownerId !== ownerId) fail('not_found', 'Sign-in not found', 404);
    return f;
  }
  async begin(key, ownerId) {
    const prior = this.owned(key, ownerId);
    if (
      [...this.flows.values()].some((f) => ['pending', 'starting', 'cancelling'].includes(f.state))
    )
      fail('busy', 'Finish or cancel the current model sign-in first', 409);
    const c = this.store.put('model', {
      ...prior,
      generation: prior.generation + 1,
      oauthState: 'authorizing',
      connection: 'unverified',
      receipt: null,
    });
    // Keep an existing grant until replacement succeeds; its generation has changed
    // so an old refresh cannot overwrite the new authorization.
    const f = {
      id: id(),
      ownerId,
      modelId: key,
      generation: c.generation,
      state: 'starting',
      controller: new AbortController(),
      expiresAt: Date.now() + 10 * 60 * 1000,
      message: 'Preparing secure sign-in…',
    };
    for (const old of [...this.flows.values()]
      .filter((f) => !['pending', 'starting', 'cancelling'].includes(f.state))
      .slice(0, -20))
      this.flows.delete(old.id);
    this.flows.set(f.id, f);
    const timer = setTimeout(() => f.controller.abort(), 10 * 60 * 1000);
    const models = createModels({
      credentials: this.credentials(key, c.generation),
      authContext: { env: async () => undefined, fileExists: async () => false },
      identity: { name: 'orbit', version },
    });
    models.setProvider(this.provider());
    f.done = models
      .login(
        'openai',
        'oauth',
        {
          signal: f.controller.signal,
          notify: (event) => {
            if (f.controller.signal.aborted) return;
            if (event.type === 'auth_url') {
              const url = new URL(event.url);
              if (url.origin !== 'https://auth.openai.com')
                fail('invalid_authorization', 'Unexpected authorization host');
              f.authorizationUrl = url.href;
              f.state = 'pending';
              f.message = 'Finish sign-in on OpenAI, then return here.';
            } else if (event.type === 'progress') f.message = 'Completing sign-in…';
          },
          prompt: (prompt) =>
            new Promise((resolve, reject) => {
              const signal = prompt.signal ?? f.controller.signal;
              if (signal.aborted) return reject(Error('Sign-in cancelled'));
              const abort = () => {
                f.prompt = undefined;
                f.answer = null;
                reject(Error('Sign-in cancelled'));
              };
              signal.addEventListener('abort', abort, { once: true });
              f.prompt = {
                id: id(),
                type: prompt.type,
                message: prompt.message,
                placeholder: prompt.placeholder,
                options: prompt.options,
              };
              f.answer = (value) => {
                signal.removeEventListener('abort', abort);
                f.prompt = undefined;
                f.answer = null;
                resolve(value);
              };
            }),
        },
        {
          getDeviceId: () => this.store.get('installation', 'installation').value,
          agentName: 'Orbit',
        },
      )
      .then(() => {
        if (f.controller.signal.aborted) throw Error('Sign-in cancelled');
        this.owned(key, ownerId);
        f.state = 'connected';
        f.message = 'ChatGPT authorization saved. Test an actual model response next.';
        this.store.event(null, null, 'model.authorized', { ownerId, modelId: key });
      })
      .catch((error) => {
        const current = this.owned(key, ownerId);
        if (current.generation === f.generation)
          this.store.put('model', {
            ...current,
            oauthState: current.secretRef ? 'connected' : 'disconnected',
          });
        f.state = f.controller.signal.aborted ? 'cancelled' : 'failed';
        f.message =
          f.state === 'cancelled'
            ? 'Sign-in cancelled.'
            : String(error.message).includes('Port 1455 is in use')
              ? 'Port 1455 is busy. Cancel the other pending Pi/Codex login and try again.'
              : 'ChatGPT sign-in did not complete. Check account consent and try again.';
      })
      .finally(() => {
        clearTimeout(timer);
        f.prompt = undefined;
        f.answer = null;
      });
    // Return admission immediately; the UI polls only this small flow record.
    return this.publicFlow(f);
  }
  respond(key, ownerId, promptId, value) {
    const f = this.flow(key, ownerId);
    if (!f.answer || f.prompt?.id !== promptId || f.state !== 'pending')
      fail('stale_revision', 'This sign-in prompt has ended', 409);
    f.answer(value);
    return { accepted: true };
  }
  cancel(key, ownerId) {
    const f = this.flow(key, ownerId);
    if (['starting', 'pending'].includes(f.state)) {
      f.state = 'cancelling';
      f.controller.abort();
      const c = this.owned(f.modelId, ownerId);
      this.store.put('model', {
        ...c,
        generation: c.generation + 1,
        oauthState: c.secretRef ? 'connected' : 'disconnected',
      });
    }
    return this.publicFlow(f);
  }
  disconnect(key, ownerId) {
    const c = this.owned(key, ownerId);
    for (const f of this.flows.values())
      if (f.modelId === key && ['starting', 'pending'].includes(f.state)) {
        f.state = 'cancelling';
        f.controller.abort();
      }
    if (c.secretRef) this.store.db.prepare('DELETE FROM secrets WHERE id=?').run(c.secretRef);
    return this.store.put('model', {
      ...c,
      generation: c.generation + 1,
      secretRef: null,
      oauthState: 'disconnected',
      connection: 'unverified',
      receipt: null,
    });
  }
  async stop() {
    for (const f of this.flows.values()) f.controller.abort();
    await Promise.allSettled([...this.flows.values()].map((f) => f.done));
  }
}
