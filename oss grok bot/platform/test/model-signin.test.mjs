import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { Store, id } from '../packages/host/src/store.mjs';
import { Vault } from '../packages/host/src/security.mjs';
import { ModelSignIn } from '../packages/host/src/model-signin.mjs';
import { modelRuntime } from '../packages/host/src/harness.mjs';
import { startHost, stopHost, waitFor } from './support.mjs';

const fixture = (oauth) => () => ({
  ...openaiProvider(),
  auth: {
    oauth,
    apiKey: {
      resolve: () => {
        throw Error('Ambient API-key auth must never run');
      },
    },
  },
});
const state = () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'orbit-model-auth-'))),
    vault = new Vault(store);
  store.put('installation', { id: 'installation', value: id() });
  return { store, vault };
};
const grant = (suffix) => ({
  type: 'oauth',
  access: 'synthetic-access-' + suffix,
  refresh: 'synthetic-refresh-' + suffix,
  expires: Date.now() + 3600000,
});

test('ChatGPT model uses the supported Pi Responses transport with plan-compatible request fields', async () => {
  const { store, vault } = state();
  const manager = new ModelSignIn(store, vault);
  try {
    const c = manager.create(id(), { name: 'Transport fixture', model: 'gpt-6.1-sol' });
    const configured = store.put('model', {
      ...c,
      secretRef: vault.save(JSON.stringify(grant('transport'))),
      oauthState: 'connected',
    });
    const { runtime, model } = await modelRuntime(configured, '', manager);
    let payload, auth;
    const item = {
      type: 'message',
      id: 'fixture-message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Fixture response', annotations: [] }],
    };
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      },
      {
        type: 'response.content_part.added',
        output_index: 0,
        content_index: 0,
        item_id: item.id,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      {
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        item_id: item.id,
        delta: 'Fixture response',
      },
      {
        type: 'response.output_text.done',
        output_index: 0,
        content_index: 0,
        item_id: item.id,
        text: 'Fixture response',
      },
      { type: 'response.output_item.done', output_index: 0, item },
      {
        type: 'response.completed',
        response: {
          id: 'fixture-response',
          object: 'response',
          status: 'completed',
          output: [item],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ];
    const response = await runtime.completeSimple(
      model,
      {
        systemPrompt: 'Use local tools only.',
        messages: [{ role: 'user', content: 'Reply briefly.', timestamp: Date.now() }],
        tools: [
          {
            name: 'fixture_tool',
            description: 'Fixture local tool',
            parameters: { type: 'object', properties: {} },
          },
        ],
      },
      {
        maxTokens: 64,
        reasoning: 'off',
        transport: 'sse',
        maxRetries: 0,
        fetch: async (url, init) => {
          assert.equal(String(url), 'https://api.openai.com/v1/responses');
          payload = JSON.parse(init.body);
          auth = new Headers(init.headers).get('authorization');
          return new Response(
            events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      },
    );
    assert.equal(response.stopReason, 'stop', response.errorMessage);
    assert.equal(response.content.find((c) => c.type === 'text').text, 'Fixture response');
    assert.equal(auth, 'Bearer synthetic-access-transport');
    assert.equal(payload.stream, true);
    assert.equal(payload.store, false);
    assert.ok(Array.isArray(payload.input));
    assert.equal(payload.max_output_tokens, undefined);
    assert.equal(payload.temperature, undefined);
    assert.ok(!payload.input.some((i) => i.type === 'message' && i.role === 'system'));
    const declared = payload.input
      .filter((item) => item.type === 'additional_tools')
      .flatMap((item) => item.tools);
    assert.ok(
      declared.some((tool) => tool.name === 'fixture_tool'),
      'Local functions are declared through supported additional_tools input items',
    );
  } finally {
    await manager.stop();
    store.close();
  }
});

test('Pi model sign-in uses isolated encrypted grants, selected model ownership, serialized refresh and disconnect', async () => {
  const { store, vault } = state();
  let refreshes = 0;
  const oauth = {
    name: 'Fixture OAuth',
    login: async (interaction, options) => {
      assert.equal(options.agentName, 'Orbit');
      assert.equal(options.getDeviceId(), store.get('installation', 'installation').value);
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/fixture' });
      assert.equal(
        await interaction.prompt({
          type: 'manual_code',
          message: 'Fixture callback',
          signal: interaction.signal,
        }),
        'synthetic-callback',
      );
      return grant('initial');
    },
    refresh: async () => {
      refreshes++;
      await new Promise((r) => setTimeout(r, 20));
      return grant('refreshed');
    },
    toAuth: async (c) => ({ apiKey: c.access }),
  };
  const manager = new ModelSignIn(store, vault, fixture(oauth)),
    owner = id();
  try {
    const c = manager.create(owner, { name: 'Fixture plan', model: 'gpt-6.1-sol' });
    await assert.rejects(() => modelRuntime(c, '', manager), /Sign in with ChatGPT/);
    const started = await manager.begin(c.id, owner),
      f = manager.flow(started.id, owner);
    await waitFor(() => !!f.prompt);
    assert.throws(() => manager.flow(f.id, id()), /not found/);
    assert.throws(() => manager.respond(f.id, owner, id(), 'synthetic-callback'), /ended/);
    manager.respond(f.id, owner, f.prompt.id, 'synthetic-callback');
    await f.done;
    assert.equal(f.state, 'connected');
    const connected = store.get(c.id, 'model');
    assert.ok(!JSON.stringify(connected).includes('synthetic-access'));
    assert.equal(JSON.parse(vault.read(connected.secretRef)).access, 'synthetic-access-initial');
    vault.save(JSON.stringify({ ...grant('initial'), expires: 0 }), connected.secretRef);
    const credentials = manager.credentials(c.id, connected.generation);
    const a = createModels({ credentials }),
      b = createModels({ credentials });
    a.setProvider(manager.provider());
    b.setProvider(manager.provider());
    const [one, two] = await Promise.all([a.getAuth('openai'), b.getAuth('openai')]);
    assert.equal(one.auth.apiKey, 'synthetic-access-refreshed');
    assert.equal(two.auth.apiKey, one.auth.apiKey);
    assert.equal(refreshes, 1);
    const reconnect = await manager.begin(c.id, owner);
    await assert.rejects(
      () => modelRuntime(store.get(c.id, 'model'), '', manager),
      /Sign in with ChatGPT/,
    );
    manager.cancel(reconnect.id, owner);
    await manager.flow(reconnect.id, owner).done;
    assert.equal(store.get(c.id, 'model').oauthState, 'connected');
    manager.disconnect(c.id, owner);
    assert.equal(store.get(c.id, 'model').oauthState, 'disconnected');
    await assert.rejects(() => credentials.read('openai'), /authorization changed/);
    assert.equal(store.db.prepare('SELECT count(*) n FROM secrets').get().n, 0);
  } finally {
    await manager.stop();
    store.close();
  }
});

test('model disconnect while login or refresh is pending cannot recreate a forgotten credential', async () => {
  const { store, vault } = state();
  let release, entered;
  let started = new Promise((r) => (entered = r));
  const oauth = {
    name: 'Fixture OAuth',
    login: async () => {
      entered();
      await new Promise((r) => (release = r));
      return grant('late');
    },
    refresh: async () => {
      entered();
      await new Promise((r) => (release = r));
      return grant('late-refresh');
    },
    toAuth: async (c) => ({ apiKey: c.access }),
  };
  const manager = new ModelSignIn(store, vault, fixture(oauth)),
    owner = id();
  try {
    const c = manager.create(owner, { name: 'Fixture plan', model: 'gpt-6.1-sol' });
    const flow = await manager.begin(c.id, owner);
    await started;
    manager.disconnect(c.id, owner);
    release();
    await manager.flow(flow.id, owner).done;
    assert.equal(store.get(c.id, 'model').secretRef, null);
    assert.equal(store.db.prepare('SELECT count(*) n FROM secrets').get().n, 0);
    let current = store.get(c.id, 'model');
    current = store.put('model', {
      ...current,
      oauthState: 'connected',
      secretRef: vault.save(JSON.stringify({ ...grant('old'), expires: 0 })),
    });
    const models = createModels({ credentials: manager.credentials(c.id, current.generation) });
    models.setProvider(manager.provider());
    started = new Promise((r) => (entered = r));
    const pending = models.getAuth('openai');
    await started;
    manager.disconnect(c.id, owner);
    release();
    await assert.rejects(pending, /authorization changed|credential|auth/i);
    assert.equal(store.db.prepare('SELECT count(*) n FROM secrets').get().n, 0);
  } finally {
    await manager.stop();
    store.close();
  }
});

test('public model setup starts the actual supported Pi OAuth listener and cancels it without signing in', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-model-auth-http-')),
    host = await startHost(root, 14352);
  try {
    assert.equal((await host.call('/model-signin/catalog')).status, 401);
    await host.call('/auth/setup', {
      name: 'Synthetic auth fixture',
      password: 'Synthetic-only-model-login-2026',
    });
    const catalog = await host.call('/model-signin/catalog');
    assert.ok(catalog.body.some((m) => m.id === 'gpt-6.1-sol'));
    const configured = await host.call('/model-signin', {
      name: 'Fixture ChatGPT plan',
      model: 'gpt-6.1-sol',
    });
    assert.equal(configured.status, 201);
    assert.equal(configured.body.hasCredential, false);
    assert.equal(configured.body.secretRef, undefined);
    assert.equal((await host.call(`/models/${configured.body.id}/check`, {})).status, 409);
    const started = await host.call(`/models/${configured.body.id}/authorize`, {});
    assert.equal(started.status, 200);
    let f;
    await waitFor(async () => {
      f = (await host.call(`/model-signin/flows/${started.body.id}`)).body;
      return f.authorizationUrl || f.state === 'failed';
    });
    assert.equal(f.state, 'pending', f.message);
    const u = new URL(f.authorizationUrl);
    assert.equal(u.origin, 'https://auth.openai.com');
    assert.equal(u.searchParams.get('agent_name_hint'), 'Orbit');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.match(u.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
    const invalid = new URL('http://127.0.0.1:1455/auth/callback');
    invalid.searchParams.set('code', 'fixture-invalid');
    invalid.searchParams.set('state', 'wrong-state');
    assert.equal((await fetch(invalid)).status, 400);
    await host.call(`/model-signin/flows/${f.id}/cancel`, {});
    await waitFor(
      async () => (await host.call(`/model-signin/flows/${f.id}`)).body.state === 'cancelled',
    );
    assert.equal((await host.call('/state')).body.models[0].hasCredential, false);
    const again = await host.call(`/models/${configured.body.id}/authorize`, {});
    assert.equal(again.status, 200);
    await waitFor(
      async () => !!(await host.call(`/model-signin/flows/${again.body.id}`)).body.authorizationUrl,
    );
    await host.call(`/model-signin/flows/${again.body.id}/cancel`, {});
  } finally {
    await stopHost(host);
  }
});
