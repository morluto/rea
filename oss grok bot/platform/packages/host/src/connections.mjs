import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { validate } from './product.mjs';
import { adaptOperation } from './provider-presets.mjs';
import { fail, id } from './store.mjs';
import { version } from './version.mjs';
const url = z.url().refine((s) => {
  const u = new URL(s);
  return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
}, 'Use an HTTP(S) URL without embedded credentials');
export const ConnectionInput = z
  .object({
    name: z.string().min(1).max(120),
    kind: z.enum(['mcp', 'http']),
    endpoint: url,
    token: z.string().max(8192).optional(),
    accountLabel: z.string().max(200).default('User configured account'),
    routeDeviceId: z.string().uuid().nullable().default(null),
    botIds: z.array(z.string().uuid()).max(100),
    tools: z
      .array(
        z.object({
          name: z.string().regex(/^[a-zA-Z][\w.-]{0,79}$/),
          description: z.string().max(4000),
          inputSchema: z.record(z.string(), z.unknown()),
          method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
          path: z.string().startsWith('/').max(2000).default('/'),
          policy: z.enum(['ask', 'allow', 'deny']).default('ask'),
          adapter: z
            .enum([
              'gmail-draft',
              'gmail-send',
              'google-query',
              'gmail-mark-read',
              'gmail-mark-unread',
              'gmail-archive',
              'gmail-inbox',
              'graph-draft',
              'graph-send',
              'google-calendar-list',
              'google-calendar-event',
              'graph-event',
            ])
            .optional(),
        }),
      )
      .max(64)
      .default([]),
  })
  .strict();
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const connectionToolName = (connectionId, operation) =>
  `ext_${connectionId.replaceAll('-', '').slice(0, 12)}_${digest(operation).slice(0, 12)}`;
export const connectionFingerprint = (c) =>
  digest({
    endpoint: c.endpoint,
    tools: c.discoveredTools,
    rules: c.rules ?? [],
    botIds: c.botIds,
    route: c.routeDeviceId,
    account: c.oauth?.accountSubject,
    oauthGeneration: c.oauth?.generation,
    mcpPrincipalGeneration: c.mcpOAuth?.generation,
  });
function schemaValidator(schema) {
  if (JSON.stringify(schema).length > 65536 || schema.type !== 'object')
    fail('invalid_schema', 'Tool input must be an object schema up to 64 KiB');
  const dialect = schema.$schema ?? 'http://json-schema.org/draft-07/schema#';
  if (
    ![
      'http://json-schema.org/draft-07/schema#',
      'https://json-schema.org/draft/2020-12/schema',
    ].includes(dialect)
  )
    fail('unsupported_schema', 'Only draft-07 and 2020-12 JSON Schema are supported');
  const ajv = dialect.includes('2020-12')
    ? new Ajv2020({ strict: false, allErrors: false, validateFormats: false })
    : new Ajv({ strict: false, allErrors: false, validateFormats: false });
  if (!ajv.validateSchema(schema))
    fail('invalid_schema', 'Tool schema does not validate against its declared dialect');
  try {
    return ajv.compile(schema);
  } catch {
    fail('invalid_schema', 'Tool schema cannot be compiled; external references are unsupported');
  }
}
function scrub(value, key) {
  if (!key) return value;
  if (typeof value === 'string') return value.replaceAll(key, '[redacted transport credential]');
  if (Array.isArray(value)) return value.map((v) => scrub(v, key));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, key)]));
  return value;
}
async function readBounded(response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > 1024 * 1024) fail('capacity', 'Connector response exceeds the 1 MiB inline limit');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}
export class Connections {
  constructor(store, vault) {
    this.store = store;
    this.vault = vault;
  }
  public(c) {
    return {
      ...c,
      secretRef: undefined,
      hasCredential: !!c.secretRef || !!c.oauth?.tokenRef || !!c.mcpOAuth?.tokenRef,
      mcpOAuth: c.mcpOAuth
        ? { state: c.mcpOAuth.state, authorizedAt: c.mcpOAuth.authorizedAt }
        : undefined,
      oauth: c.oauth
        ? {
            provider: c.oauth.provider,
            service: c.oauth.service,
            clientId: c.oauth.clientId,
            state: c.oauth.state,
            scope: c.oauth.scope,
            accountEmail: c.oauth.accountEmail,
            expiresAt: c.oauth.expiresAt,
          }
        : undefined,
    };
  }
  create(ownerId, input) {
    const { token, ...value } = validate(ConnectionInput, input);
    for (const botId of value.botIds)
      if (this.store.get(botId, 'bot').ownerId !== ownerId)
        fail('not_authorized', 'You must own a Bot to grant it a connection', 403);
    if (value.routeDeviceId && this.store.get(value.routeDeviceId, 'device').ownerId !== ownerId)
      fail('not_authorized', 'Routed device owner required', 403);
    for (const t of value.tools) schemaValidator(t.inputSchema);
    return this.store.put('connection', {
      id: id(),
      ownerId,
      ...value,
      secretRef: token ? this.vault.save(token) : null,
      state: 'unverified',
      enabled: true,
      discoveredTools: [],
      lastCheck: null,
    });
  }
  async client(c, credentials = new Set()) {
    const client = new Client({ name: 'orbit', version });
    const token = c.secretRef ? this.vault.read(c.secretRef) : null;
    const transport = new StreamableHTTPClientTransport(new URL(c.endpoint), {
      ...(c.mcpOAuth
        ? { authProvider: this.mcpOAuth.provider(c.id, null, (value) => credentials.add(value)) }
        : {}),
      requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} },
    });
    try {
      await client.connect(transport, { signal: AbortSignal.timeout(15000) });
      return client;
    } catch {
      await client.close().catch(() => {});
      fail(
        'connection_failed',
        'MCP connection failed. Check endpoint, authentication and server availability.',
        409,
      );
    }
  }
  async discover(connectionId) {
    const c = this.store.get(connectionId, 'connection');
    let client;
    try {
      let tools = [];
      if (c.oauth && !c.oauth.tokenRef)
        fail('auth_required', 'Authenticate this account before enabling its tools', 409);
      if (c.kind === 'mcp') {
        client = await this.client(c);
        let cursor;
        const seen = new Set();
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, {
            signal: AbortSignal.timeout(15000),
          });
          for (const t of page.tools) {
            if (tools.length >= 64)
              fail(
                'capacity',
                'Select a narrower MCP server; at most 64 tools can be registered per connection',
              );
            if (seen.has(t.name)) fail('invalid_schema', 'Server advertised duplicate tool names');
            seen.add(t.name);
            schemaValidator(t.inputSchema);
            if (t.outputSchema) schemaValidator(t.outputSchema);
            tools.push({
              name: t.name,
              description: t.description ?? t.name,
              inputSchema: t.inputSchema,
              outputSchema: t.outputSchema ?? null,
              annotations: t.annotations ?? {},
              policy: 'ask',
            });
          }
          if (page.nextCursor === cursor && cursor)
            fail('protocol_error', 'MCP server repeated its page cursor');
          cursor = page.nextCursor;
        } while (cursor);
      } else {
        tools = c.tools.map((t) => ({ ...t, annotations: {}, outputSchema: null }));
        if (!tools.length)
          fail('invalid_input', 'HTTP connectors require at least one named operation');
      }
      const next = this.store.put('connection', {
        ...c,
        discoveredTools: tools,
        state: c.kind === 'mcp' ? 'ready' : 'configured',
        lastCheck: Date.now(),
        catalogDigest: digest(tools),
      });
      return this.public(next);
    } catch (e) {
      this.store.put('connection', { ...c, state: 'failed', lastCheck: Date.now() });
      throw e;
    } finally {
      await client?.close();
    }
  }
  update(idValue, ownerId, input) {
    const c = this.store.get(idValue, 'connection');
    if (c.ownerId !== ownerId) fail('not_authorized', 'Connection owner required', 403);
    const value = validate(
      z
        .object({
          revision: z.number().int(),
          enabled: z.boolean(),
          botIds: z.array(z.string().uuid()),
          policies: z.record(z.string(), z.enum(['ask', 'allow', 'deny'])),
        })
        .strict(),
      input,
    );
    for (const botId of value.botIds)
      if (this.store.get(botId, 'bot').ownerId !== ownerId)
        fail('not_authorized', 'Bot owner required', 403);
    return this.public(
      this.store.put(
        'connection',
        {
          ...c,
          enabled: value.enabled,
          botIds: value.botIds,
          discoveredTools: c.discoveredTools.map((t) => ({
            ...t,
            policy: value.policies[t.name] ?? t.policy,
          })),
        },
        value.revision,
      ),
    );
  }
  async execute(run, c, operation, args, signal) {
    const current = this.store.get(c.id, 'connection');
    if (this.decision(current, operation, run.botId) === 'deny')
      fail('not_authorized', 'A current action rule denies this operation', 403);
    if (
      !current.enabled ||
      connectionFingerprint(current) !== connectionFingerprint(c) ||
      !current.botIds.includes(run.botId)
    )
      fail(
        'stale_revision',
        'Connection grants or schema changed; start a new run with the current configuration',
        409,
      );
    const validator = schemaValidator(operation.inputSchema);
    if (!validator(args))
      fail('invalid_input', 'Arguments do not match the named connector operation');
    const token = c.mcpOAuth
      ? this.mcpOAuth.read(c.id, 'tokenRef')?.access_token
      : this.oauth
        ? await this.oauth.bearer(c)
        : c.secretRef
          ? this.vault.read(c.secretRef)
          : null;
    let action = this.store.put('external_action', {
      id: id(),
      botId: run.botId,
      runId: run.id,
      connectionId: c.id,
      connectionRevision: c.revision,
      account: c.accountLabel,
      operation: operation.name,
      input: args,
      state: 'submitting',
      outcome: 'unknown',
    });
    let client;
    const credentials = new Set(token ? [token] : []);
    try {
      let result;
      if (c.kind === 'mcp') {
        client = await this.client(c, credentials);
        result = await client.callTool({ name: operation.name, arguments: args }, undefined, {
          signal,
          timeout: 60000,
        });
      } else {
        const adapted = adaptOperation(operation, args);
        const target = new URL(adapted.path, c.endpoint);
        if (target.origin !== new URL(c.endpoint).origin)
          fail('not_authorized', 'Connector operation changed endpoint origin', 403);
        if (operation.method === 'GET')
          for (const [key, value] of adapted.queryEntries) target.searchParams.append(key, value);
        const headers = {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        };
        const body = ['GET', 'DELETE'].includes(operation.method)
          ? undefined
          : JSON.stringify(adapted.body);
        if (c.routeDeviceId) {
          if (!run.config.capabilities.includes('devices'))
            fail('not_authorized', 'Enable device capabilities for routed connections', 403);
          result = await this.devices.operation(
            run,
            c.routeDeviceId,
            'fetch',
            { url: target.href, method: operation.method, headers, body },
            signal,
          );
        } else {
          const response = await fetch(target, {
            method: operation.method,
            headers,
            body,
            redirect: 'error',
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
              : AbortSignal.timeout(60000),
          });
          result = { status: response.status, ok: response.ok, body: await readBounded(response) };
        }
      }
      for (const credential of credentials) result = scrub(result, credential);
      if (operation.outputSchema && !result.isError) {
        const check = schemaValidator(operation.outputSchema);
        if (!check(result.structuredContent))
          result = {
            ...result,
            isError: true,
            validation: {
              tag: 'provider_schema_error',
              message: 'The response does not match the discovered output schema',
            },
          };
      }
      action = this.store.put('external_action', {
        ...action,
        state: 'responded',
        outcome: result.isError || result.ok === false ? 'provider_error' : 'response_received',
        response: result,
        finishedAt: Date.now(),
      });
      this.store.event(run.botId, run.id, 'external_action.responded', {
        id: action.id,
        connectionId: c.id,
        operation: operation.name,
        outcome: action.outcome,
      });
      const apps = [];
      for (const block of result?.content ?? []) {
        if (
          block?.type === 'resource' &&
          block.resource?.mimeType === 'text/html' &&
          typeof block.resource?.text === 'string'
        ) {
          const bytes = Buffer.from(block.resource.text, 'utf8');
          if (bytes.length > 512 * 1024) continue;
          const digest = createHash('sha256').update(bytes).digest('hex');
          mkdirSync(join(this.store.root, 'artifacts'), { recursive: true });
          const artifactPath = join(this.store.root, 'artifacts', digest);
          if (!existsSync(artifactPath)) writeFileSync(artifactPath, bytes, { flag: 'wx' });
          const artifact = this.store.put('artifact', {
            id: id(),
            botId: run.botId,
            name: `${operation.name}-app.html`,
            currentRevisionId: null,
            state: 'available',
          });
          const revision = this.store.put('artifact_revision', {
            id: id(),
            botId: run.botId,
            artifactId: artifact.id,
            name: `${operation.name}-app.html`,
            mediaType: 'text/html',
            size: bytes.length,
            digest,
            sourceRun: run.id,
            provenance: 'mcp_app',
          });
          this.store.put('artifact', { ...artifact, currentRevisionId: revision.id });
          this.store.event(run.botId, run.id, 'mcp.app_published', {
            artifactId: artifact.id,
            revisionId: revision.id,
            connectionId: c.id,
            operation: operation.name,
          });
          apps.push({ revisionId: revision.id, name: revision.name, digest });
        }
      }
      return {
        receiptId: action.id,
        account: c.accountLabel,
        operation: operation.name,
        outcome: action.outcome,
        result,
        ...(apps.length ? { apps } : {}),
        limitation:
          'A protocol response does not establish external delivery or later completion. Returned app views render in the workspace sandbox without product API access.',
      };
    } catch (e) {
      this.store.put('external_action', {
        ...action,
        state: signal?.aborted ? 'cancel_requested' : 'unknown',
        outcome: 'unknown',
        finishedAt: Date.now(),
      });
      fail(
        signal?.aborted ? 'outcome_unknown' : 'connector_failure',
        'No conclusive provider result. Inspect the retained action receipt before retrying.',
        409,
      );
    } finally {
      await client?.close();
    }
  }
  validateOperation(c, name, args, botId) {
    const op = c.discoveredTools.find((t) => t.name === name);
    if (!op || this.decision(c, op, botId) === 'deny')
      fail('not_authorized', 'This named operation is unavailable or denied', 403);
    if (!schemaValidator(op.inputSchema)(args))
      fail('invalid_input', 'Arguments do not match the selected operation');
    return op;
  }
  decision(connection, operation, botId) {
    if (operation.policy === 'deny') return 'deny';
    const rules = (connection.rules ?? []).filter(
      (rule) =>
        rule.enabled &&
        rule.operation === operation.name &&
        (!rule.botIds.length || rule.botIds.includes(botId)),
    );
    for (const behavior of ['deny', 'ask', 'allow'])
      if (rules.some((rule) => rule.behavior === behavior)) return behavior;
    return operation.policy;
  }
  saveRules(ownerId, key, input) {
    const connection = this.store.get(key, 'connection');
    if (connection.ownerId !== ownerId) fail('not_authorized', 'Connection owner required', 403);
    const value = validate(
      z
        .object({
          revision: z.number().int(),
          rules: z
            .array(
              z
                .object({
                  id: z.string().uuid().optional(),
                  description: z.string().trim().min(1).max(1000),
                  operation: z.string().min(1).max(100),
                  behavior: z.enum(['ask', 'allow', 'deny']),
                  botIds: z.array(z.string().uuid()).max(100).default([]),
                  enabled: z.boolean().default(true),
                })
                .strict(),
            )
            .max(100),
        })
        .strict(),
      input,
    );
    for (const rule of value.rules) {
      if (!connection.discoveredTools.some((operation) => operation.name === rule.operation))
        fail('invalid_input', 'Select an exact named operation from this connection');
      if (rule.botIds.some((botId) => !connection.botIds.includes(botId)))
        fail('not_authorized', 'Rules may only target this connection granted Bots', 403);
    }
    const rules = value.rules.map((rule) => ({ ...rule, id: rule.id ?? id() }));
    if (new Set(rules.map((rule) => rule.id)).size !== rules.length)
      fail('invalid_input', 'Rule identities must be unique');
    const next = this.store.put('connection', { ...connection, rules }, value.revision);
    this.store.event(null, null, 'connection.rules_changed', {
      ownerId,
      connectionId: key,
      rules: rules.length,
    });
    return this.public(next);
  }
  async tools(run, wrap) {
    const tools = [];
    for (const c of this.store
      .list('connection')
      .filter(
        (c) =>
          c.enabled && ['ready', 'configured'].includes(c.state) && c.botIds.includes(run.botId),
      )) {
      for (const op of c.discoveredTools) {
        const decision = this.decision(c, op, run.botId);
        if (decision === 'deny') continue;
        const name = connectionToolName(c.id, op.name);
        const parameters = structuredClone(op.inputSchema);
        delete parameters.$schema;
        tools.push(
          wrap(
            name,
            'extensions',
            `${c.name} / ${op.name}: ${op.description}\nSelected account: ${c.accountLabel}`,
            parameters,
            (args, signal) => this.execute(run, c, op, args, signal),
            decision !== 'allow',
          ),
        );
      }
    }
    return tools;
  }
}
