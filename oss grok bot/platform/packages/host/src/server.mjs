import { version } from './version.mjs';
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, cpSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { Store, fail, id, Failure } from './store.mjs';
import { Vault, hash, passwordHash, passwordMatches } from './security.mjs';
import { Product, validate, nextOccurrence, artifactCapabilities } from './product.mjs';
import {
  BotInput,
  ModelInput,
  TaskInput,
  MemoryInput,
  RoutineInput,
  ArtifactInput,
  SettingsInput,
} from './contracts.mjs';
import { Harness, connectCheck } from './harness.mjs';
import { Computers } from './computers.mjs';
import { OAuth } from './oauth.mjs';
import { Actions } from './actions.mjs';
import { workspaceState, libraryOverview } from './projections.mjs';
import { Remote } from './remote.mjs';
import { acquireHost } from './host-ownership.mjs';
import { createBackup, inspectBackup } from './backups.mjs';
import { Triggers } from './triggers.mjs';
import { Devices } from './devices.mjs';
import { Access } from './access.mjs';
import { Workflows } from './workflows.mjs';
import { Connections } from './connections.mjs';
import { McpOAuth } from './mcp-oauth.mjs';
import { Plugins } from './plugins.mjs';
import { ModelSignIn } from './model-signin.mjs';
import { Knowledge } from './knowledge.mjs';
import { extraRoutes } from './routes-extra.mjs';
import { Coding } from './coding.mjs';
import { Reminders } from './reminders.mjs';
import { Learning } from './learning.mjs';
import { PersonalVault } from './personal-vault.mjs';
import { LibrarySearch } from './library-search.mjs';
import { Documents } from './documents.mjs';
import { Semantic } from './semantic.mjs';
import { Retention } from './retention.mjs';
import { Push } from './push.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
let port = Number(process.env.WORKSHOP_PORT ?? 4317);
const dataRoot = resolve(process.env.WORKSHOP_DATA ?? join(root, '.local'));
const hostOwner = await acquireHost(dataRoot);
const store = new Store(dataRoot);
if (!store.list('installation').length)
  store.put('installation', { id: 'installation', value: id() });
const access = new Access(store);
const vault = new Vault(store),
  product = new Product(store),
  computers = new Computers(store, vault),
  harness = new Harness(store, product, vault, computers);
const devices = new Devices(store, vault),
  triggers = new Triggers(store, vault);
const workflows = new Workflows(store, product),
  connections = new Connections(store, vault),
  knowledge = new Knowledge(store, product);
workflows.harness = harness;
harness.workflows = workflows;
harness.extensions = connections;
const mcpOAuth = new McpOAuth(store, vault);
connections.mcpOAuth = mcpOAuth;
harness.knowledge = knowledge;
harness.devices = devices;
connections.devices = devices;
const oauth = new OAuth(store, vault, connections, `http://127.0.0.1:${port}`);
connections.oauth = oauth;
const plugins = new Plugins(store, connections, oauth, vault);
const modelSignIn = new ModelSignIn(store, vault);
harness.modelSignIn = modelSignIn;
const coding = new Coding(store);
harness.coding = coding;
const reminders = new Reminders(store);
const learning = new Learning(store, product),
  personalVault = new PersonalVault(store, vault);
personalVault.computers = computers;
const documents = new Documents(store, product);
const librarySearch = new LibrarySearch(store, product, documents);
harness.librarySearch = librarySearch;
harness.documents = documents;
const semantic = new Semantic(store, product, documents, vault);
harness.semantic = semantic;
const retention = new Retention(store);
const push = new Push(store, vault);
workflows.push = push;
reminders.push = push;
coding.push = push;
harness.reminders = reminders;
const actions = new Actions(store, product, connections);
harness.actions = actions;
harness.recover();
const listeners = new Set();
const tickets = new Map();
let shuttingDown = false;
const allowedHost = (host) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;
function originCheck(req) {
  if (!allowedHost(req.headers.host)) fail('not_authorized', 'Loopback host required', 403);
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
    fail('not_authorized', 'Same-origin request required', 403);
}
function auth(req) {
  const token = req.headers.cookie
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('workshop='))
    ?.slice(9);
  if (!token) fail('unauthenticated', 'Sign in required', 401);
  const session = store
    .list('auth_session')
    .find((s) => s.tokenHash === hash(token) && s.expiresAt > Date.now());
  if (!session) fail('unauthenticated', 'Session expired', 401);
  return session;
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 12 * 1024 * 1024)
      fail('capacity', 'Request exceeds the 12 MiB transport limit', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    fail('invalid_input', 'Malformed JSON');
  }
}
function send(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
function owned(key, kind, botId) {
  const row = store.get(key, kind);
  if (row.botId !== botId) fail('not_authorized', 'Resource belongs to another Bot', 403);
  return row;
}
function publicModel(m) {
  return { ...m, secretRef: undefined, hasCredential: !!m.secretRef };
}
async function route(req, res) {
  originCheck(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;
  if (shuttingDown && method !== 'GET')
    fail('unavailable', 'Host is stopping; no new mutations are accepted', 503);
  if (path === '/api/health')
    return send(res, {
      status: shuttingDown ? 'stopping' : 'running',
      product: 'Orbit',
      version,
      node: process.version,
      pid: process.pid,
    });
  if (path === '/api/auth/status') {
    let session;
    try {
      session = auth(req);
    } catch {}
    return send(res, {
      setup: !store.list('account').length,
      authenticated: !!session,
      account: session ? store.get(session.accountId, 'account').name : null,
    });
  }
  if (
    method === 'GET' &&
    (path === '/api/oauth/callback' ||
      (path === '/' &&
        url.searchParams.has('state') &&
        (url.searchParams.has('code') || url.searchParams.has('error'))))
  ) {
    await oauth.callback(url.searchParams);
    res.writeHead(302, {
      location: '/?connected=1',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    return res.end();
  }
  if (path === '/api/mcp/oauth/callback' && method === 'GET') {
    await mcpOAuth.callback(url.searchParams);
    res.writeHead(302, {
      location: '/',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    return res.end();
  }
  const hook = path.match(/^\/api\/hooks\/([^/]+)$/);
  if (hook && method === 'POST') return send(res, await triggers.receive(hook[1], req), 202);
  if (path === '/api/devices/pair' && method === 'POST')
    return send(res, devices.pair(await body(req)), 201);
  if (path === '/api/auth/join' && method === 'POST')
    return send(res, access.join(await body(req)), 201);
  if (path === '/api/auth/setup' || path === '/api/auth/login') {
    if (method !== 'POST') fail('not_found', 'Not found', 404);
    const input = validate(
      z
        .object({ name: z.string().min(1).max(120), password: z.string().min(12).max(512) })
        .strict(),
      await body(req),
    );
    let account = path.endsWith('setup')
      ? store.list('account')[0]
      : store.list('account').find((a) => a.name === input.name);
    if (path.endsWith('setup')) {
      if (account) fail('already_configured', 'Account already exists', 409);
      account = store.put('account', {
        id: id(),
        name: input.name,
        password: passwordHash(input.password),
      });
    } else if (
      !account ||
      input.name !== account.name ||
      !passwordMatches(input.password, account.password)
    )
      fail('unauthenticated', 'Invalid account or password', 401);
    const token = randomBytes(32).toString('hex');
    store.put('auth_session', {
      id: id(),
      accountId: account.id,
      tokenHash: hash(token),
      expiresAt: Date.now() + 7 * 86400000,
    });
    res.setHeader(
      'Set-Cookie',
      `workshop=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${req.workshopRemote ? '; Secure' : ''}`,
    );
    return send(res, { authenticated: true });
  }
  // Static code contains no credentials or product data. All data/viewer routes authenticate below.
  if (!path.startsWith('/api/') && method === 'GET') {
    const vendor = {
      '/vendor/marked.js': 'marked/lib/marked.esm.js',
      '/vendor/purify.js': 'dompurify/dist/purify.es.mjs',
    };
    const staticPath = vendor[path]
      ? join(root, 'node_modules', vendor[path])
      : path === '/'
        ? join(root, 'apps/workspace/index.html')
        : path.startsWith('/novnc/')
          ? join(root, 'node_modules/@novnc/novnc', path.slice(7))
          : join(root, 'apps/workspace', path.slice(1));
    const base = vendor[path]
      ? join(root, 'node_modules')
      : path.startsWith('/novnc/')
        ? join(root, 'node_modules/@novnc/novnc')
        : join(root, 'apps/workspace');
    const canonical = resolve(staticPath);
    if (!canonical.startsWith(base + '\\') && !canonical.startsWith(base + '/'))
      fail('not_found', 'Not found', 404);
    if (!existsSync(canonical) || !statSync(canonical).isFile())
      fail('not_found', 'Not found', 404);
    const types = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.mjs': 'application/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.ttf': 'font/ttf',
      '.woff2': 'font/woff2',
      '.webmanifest': 'application/manifest+json',
    };
    res.writeHead(200, {
      'content-type': types[extname(canonical)] ?? 'application/octet-stream',
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws:; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    return res.end(readFileSync(canonical));
  }
  const session = auth(req);
  if (method !== 'GET' && req.headers.origin !== `http://${req.headers.host}`)
    fail('not_authorized', 'Mutation requires a same-origin request', 403);
  if (
    await extraRoutes({
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
    })
  )
    return;
  if (path === '/api/auth/logout' && method === 'POST') {
    store.put('auth_session', { ...session, expiresAt: 0 });
    for (const c of store.list('computer'))
      if (c.leaseSession === session.id) computers.closeViewers(c.botId);
    res.setHeader('Set-Cookie', 'workshop=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return send(res, { ok: true });
  }
  if (path.startsWith('/api/remote')) {
    if (req.workshopRemote || !access.admin(session.accountId))
      fail('not_authorized', 'Remote access is managed on the primary host only', 403);
    if (path === '/api/remote' && method === 'GET') return send(res, remote.status());
    if (path === '/api/remote' && method === 'POST')
      return send(res, await remote.configure(session.accountId, await body(req)));
    if (path === '/api/remote/quick' && method === 'POST')
      return send(res, await remote.quick(session.accountId, await body(req)));
    if (path === '/api/remote/pair' && method === 'POST') {
      const v = validate(z.object({ name: z.string().min(1).max(120) }).strict(), await body(req));
      return send(res, remote.begin(session.accountId, v.name), 201);
    }
    const revoke = path.match(/^\/api\/remote\/clients\/([^/]+)\/revoke$/);
    if (revoke && method === 'POST') return send(res, remote.revoke(revoke[1], session.accountId));
    fail('not_found', 'Remote operation not found', 404);
  }
  if (path === '/api/state')
    return send(res, workspaceState(store, access, workflows, session, publicModel));
  const mcpAuthorization = path.match(/^\/api\/connections\/([^/]+)\/authorize$/);
  if (mcpAuthorization && method === 'POST') {
    if (req.workshopRemote)
      fail('not_authorized', 'Start account sign-in on the primary computer', 403);
    return send(res, await mcpOAuth.begin(mcpAuthorization[1], session.accountId));
  }
  if (path === '/api/model-signin/catalog' && method === 'GET')
    return send(res, modelSignIn.catalog());
  if (path === '/api/model-signin' && method === 'POST') {
    const value = validate(
      z.object({ name: z.string().min(1).max(120), model: z.string().min(1).max(256) }).strict(),
      await body(req),
    );
    return send(res, publicModel(modelSignIn.create(session.accountId, value)), 201);
  }
  const modelAuth = path.match(/^\/api\/models\/([^/]+)\/(authorize|disconnect)$/);
  if (modelAuth && method === 'POST') {
    if (req.workshopRemote)
      fail('not_authorized', 'Start model sign-in on the primary computer', 403);
    return send(
      res,
      modelAuth[2] === 'authorize'
        ? await modelSignIn.begin(modelAuth[1], session.accountId)
        : publicModel(modelSignIn.disconnect(modelAuth[1], session.accountId)),
    );
  }
  const signInFlow = path.match(/^\/api\/model-signin\/flows\/([^/]+)(?:\/(cancel|answer))?$/);
  if (signInFlow) {
    if (req.workshopRemote)
      fail('not_authorized', 'Use model sign-in on the primary computer', 403);
    if (!signInFlow[2] && method === 'GET')
      return send(res, modelSignIn.publicFlow(modelSignIn.flow(signInFlow[1], session.accountId)));
    if (signInFlow[2] === 'cancel' && method === 'POST')
      return send(res, modelSignIn.cancel(signInFlow[1], session.accountId));
    if (signInFlow[2] === 'answer' && method === 'POST') {
      const value = validate(
        z.object({ promptId: z.string().uuid(), value: z.string().min(1).max(12000) }).strict(),
        await body(req),
      );
      return send(
        res,
        modelSignIn.respond(signInFlow[1], session.accountId, value.promptId, value.value),
      );
    }
  }
  if (path === '/api/plugins' && method === 'GET')
    return send(res, plugins.list(session.accountId));
  if (path === '/api/plugins/servers' && method === 'POST')
    return send(res, plugins.addServer(session.accountId, await body(req)), 201);
  const pluginConnect = path.match(/^\/api\/plugins\/([a-z0-9-]+)\/connect$/);
  if (pluginConnect && method === 'POST') {
    if (req.workshopRemote)
      fail('not_authorized', 'Start provider sign-in on the primary computer', 403);
    return send(res, await plugins.connect(session.accountId, pluginConnect[1], await body(req)));
  }
  const pluginRoute = path.match(/^\/api\/plugins\/([a-z0-9-]+)(?:\/(uninstall))?$/);
  if (pluginRoute && method === 'POST') {
    const value = await body(req);
    return send(
      res,
      pluginRoute[2]
        ? plugins.uninstall(
            session.accountId,
            pluginRoute[1],
            validate(z.object({ revision: z.number().int() }).strict(), value).revision,
          )
        : plugins.configure(session.accountId, pluginRoute[1], value),
    );
  }
  if (path === '/api/docker' && method === 'GET')
    return send(res, {
      ...(await computers.health()),
      build: computers.image.status(),
      canPrepare: access.admin(session.accountId),
      canStart:
        process.platform === 'win32' && !req.workshopRemote && access.admin(session.accountId),
    });
  if (path === '/api/docker/start' && method === 'POST') {
    if (req.workshopRemote || !access.admin(session.accountId))
      fail(
        'not_authorized',
        'Start the Linux engine from the primary computer as the workspace owner.',
        403,
      );
    return send(res, await computers.startEngine());
  }
  if (['/api/docker/prepare', '/api/docker/cancel'].includes(path) && method === 'POST') {
    if (!access.admin(session.accountId))
      fail('not_authorized', 'Workspace owner is required to prepare the shared Linux image', 403);
    return send(
      res,
      path.endsWith('/prepare')
        ? computers.image.start(session.accountId)
        : computers.image.cancel(),
      202,
    );
  }
  if (path === '/api/metrics')
    return send(res, {
      scope: 'host process only; excludes browser and containers',
      cpuMicroseconds: process.cpuUsage(),
      peakRssKiB: process.resourceUsage().maxRSS,
      currentRssBytes: process.memoryUsage().rss,
      uptimeSeconds: process.uptime(),
      activeRuns: harness.active.size,
      queuedRuns: store.list('run').filter((r) => r.state === 'queued').length,
    });
  if (path === '/api/settings' && method === 'POST') {
    const v = validate(SettingsInput, await body(req));
    return send(
      res,
      store.put('settings', {
        ...store.list('settings').find((s) => s.ownerId === session.accountId),
        id: `settings-${session.accountId}`,
        ownerId: session.accountId,
        ...v,
      }),
    );
  }
  if (path === '/api/shutdown' && method === 'POST') {
    if (!access.admin(session.accountId)) fail('not_authorized', 'Workspace owner required', 403);
    send(res, { accepted: true, state: 'stopping' });
    setImmediate(shutdown);
    return;
  }
  if (path === '/api/models' && method === 'POST') {
    const { apiKey, ...v } = validate(ModelInput, await body(req));
    const secretRef = apiKey ? vault.save(apiKey) : null;
    const model = store.put('model', {
      id: id(),
      ownerId: session.accountId,
      ...v,
      secretRef,
      connection: 'unverified',
      cost: null,
    });
    return send(res, publicModel(model), 201);
  }
  const modelCheck = path.match(/^\/api\/models\/([^/]+)\/check$/);
  if (modelCheck && method === 'POST') {
    const m = store.get(modelCheck[1], 'model');
    if (!access.ownedModel(m, session.accountId))
      fail('not_authorized', 'Model owner required', 403);
    try {
      const receipt = await connectCheck(
        m,
        m.authMode !== 'chatgpt' && m.secretRef ? vault.read(m.secretRef) : '',
        modelSignIn,
      );
      const current = store.get(m.id, 'model');
      if (current.generation !== m.generation)
        fail('auth_revoked', 'Authorization changed during the model check', 409);
      store.put('model', { ...current, connection: 'verified', receipt });
      return send(res, receipt);
    } catch (e) {
      const current = store.get(m.id, 'model');
      if (current.generation === m.generation)
        store.put('model', { ...current, connection: 'failed', receipt: null });
      throw e;
    }
  }
  if (path === '/api/bots' && method === 'POST') {
    const v = validate(BotInput, await body(req));
    if (v.modelId && !access.ownedModel(store.get(v.modelId, 'model'), session.accountId))
      fail('not_authorized', 'Model owner required', 403);
    const bot = store.tx(() => {
      const b = store.put('bot', {
        id: id(),
        ownerId: session.accountId,
        ...v,
        pinned: false,
        hidden: false,
        retired: false,
      });
      store.put('bot_revision', { ...b, id: id(), botId: b.id, configRevision: b.revision });
      store.event(b.id, null, 'bot.created', { id: b.id });
      return b;
    });
    computers.record(bot.id);
    return send(res, bot, 201);
  }
  if (path === '/api/events') {
    let cursor = Number(url.searchParams.get('cursor') ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) fail('invalid_input', 'Invalid event cursor');
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.flushHeaders();
    const progress = (value) => {
      try {
        auth(req);
        access.requireBot(session.accountId, value.botId);
        if (res.writableLength > 1024 * 1024) return res.end();
        res.write(`event: progress\ndata: ${JSON.stringify(value)}\n\n`);
      } catch (e) {
        if (e.tag !== 'not_authorized') res.end();
      }
    };
    harness.progressListeners.add(progress);
    const timer = setInterval(() => {
      try {
        auth(req);
        if (res.writableLength > 1024 * 1024) {
          res.end();
          return;
        }
        const events = store.events(cursor);
        for (const event of events) {
          cursor = event.seq;
          if (event.bot && !access.bot(session.accountId, event.bot)) continue;
          if (!event.bot && event.data?.ownerId && event.data.ownerId !== session.accountId)
            continue;
          res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
          cursor = event.seq;
        }
        if (!events.length) res.write(': keepalive\n\n');
      } catch {
        res.end();
      }
    }, 300);
    listeners.add(res);
    res.on('close', () => {
      harness.progressListeners.delete(progress);
      clearInterval(timer);
      listeners.delete(res);
    });
    return;
  }
  if (path === '/api/backup' && method === 'POST') {
    if (!access.admin(session.accountId)) fail('not_authorized', 'Workspace owner required', 403);
    if (harness.active.size || harness.starting.size || computers.busy.size)
      fail('busy', 'Stop active tasks and finish computer operations before backing up', 409);
    return send(res, createBackup(store));
  }
  if (path === '/api/backups' && method === 'GET') {
    if (!access.admin(session.accountId)) fail('not_authorized', 'Workspace owner required', 403);
    const folder = join(store.root, 'backups');
    const entries = existsSync(folder)
      ? readdirSync(folder)
          .filter((name) => existsSync(join(folder, name, 'backup.json')))
          .map((name) => {
            const path = join(folder, name);
            try {
              const m = inspectBackup(path);
              return {
                name,
                path,
                at: m.at,
                files: m.files.length,
                valid: true,
                excluded: m.excluded,
              };
            } catch {
              return { name, path, valid: false };
            }
          })
      : [];
    return send(res, entries);
  }
  if (path === '/api/extensions' && method === 'POST') {
    const v = validate(
      z
        .object({
          name: z.string().min(1).max(120),
          type: z.enum(['skill', 'plugin', 'mcp', 'connector', 'device']),
          version: z.string().min(1).max(80),
          instructions: z.string().max(32000).default(''),
          source: z.string().max(2000),
          botIds: z.array(z.string().uuid()).max(100).default([]),
        })
        .strict(),
      await body(req),
    );
    for (const b of v.botIds)
      if (store.get(b, 'bot').ownerId !== session.accountId)
        fail('not_authorized', 'Bot owner required', 403);
    return send(
      res,
      store.put('extension', {
        id: id(),
        ownerId: session.accountId,
        ...v,
        state: v.type === 'skill' ? 'enabled' : 'manifest_only',
        capabilities: [],
        installedCode: false,
      }),
      201,
    );
  }
  const match = path.match(/^\/api\/bots\/([^/]+)(?:\/(.*))?$/);
  if (!match) fail('not_found', 'Not found', 404);
  const botId = match[1],
    op = match[2] ?? '';
  const bot = store.get(botId, 'bot');
  access.requireBot(session.accountId, botId, method !== 'GET' && op !== 'computer/ticket');
  if (
    ['', 'navigation', 'retire'].includes(op) &&
    method !== 'GET' &&
    bot.ownerId !== session.accountId
  )
    fail('not_authorized', 'Only the Bot owner may change configuration or lifecycle', 403);
  if (!op && method === 'PATCH') {
    const data = await body(req);
    const expected = validate(z.number().int(), data.revision);
    delete data.revision;
    const value = validate(BotInput, data);
    if (
      value.modelId &&
      value.modelId !== bot.modelId &&
      !access.ownedModel(store.get(value.modelId, 'model'), session.accountId)
    )
      fail('not_authorized', 'Model owner required', 403);
    return send(
      res,
      store.tx(() => {
        const b = store.put('bot', { ...bot, ...value }, expected);
        store.put('bot_revision', { ...b, id: id(), botId, configRevision: b.revision });
        store.event(botId, null, 'bot.updated', { revision: b.revision });
        return b;
      }),
    );
  }
  if (op === 'navigation' && method === 'POST') {
    const v = validate(
      z.object({ pinned: z.boolean(), hidden: z.boolean() }).strict(),
      await body(req),
    );
    return send(res, store.put('bot', { ...bot, ...v }));
  }
  if (op === 'retire' && method === 'POST') {
    for (const r of store.list('run', botId)) await harness.cancel(r.id);
    for (const r of store.list('routine', botId))
      store.put('routine', { ...r, enabled: false, state: 'retired' });
    return send(res, store.put('bot', { ...bot, retired: true }));
  }
  if (op === 'template')
    return send(res, {
      schemaVersion: 1,
      name: bot.name,
      purpose: bot.purpose,
      role: bot.role,
      color: bot.color,
      capabilities: bot.capabilities,
      model: null,
      credentials: [],
      history: [],
      memory: [],
    });
  if (op === 'overview')
    return send(res, {
      conversations: store.list('conversation', botId),
      runs: store.list('run', botId).map((r) => ({ ...r, config: undefined })),
      memories: store.list('memory', botId),
      routines: store.list('routine', botId),
      reminders: store.list('reminder', botId),
      codingTasks: store.list('coding_task', botId).map((task) => ({
        id: task.id,
        title: task.title,
        state: task.state,
        conversationId: task.conversationId,
        result: task.result,
        resultAt: task.resultAt,
        threadId: task.threadId,
      })),
      occurrences: store.list('occurrence', botId),
      ...libraryOverview(store, bot),
      approvals: store.list('approval', botId),
      computer: { ...computers.record(botId), secretRef: undefined, guestPort: undefined },
    });
  if (op === 'conversations' && method === 'POST') {
    const v = validate(z.object({ name: z.string().min(1).max(120) }).strict(), await body(req));
    return send(res, store.put('conversation', { id: id(), botId, ...v, sessionFile: null }), 201);
  }
  const history = op.match(/^conversations\/([^/]+)\/history$/);
  if (history) {
    const c = owned(history[1], 'conversation', botId);
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const limitRaw = url.searchParams.get('limit');
    const direction = url.searchParams.get('direction') ?? undefined;
    const limit =
      limitRaw == null ? undefined : Math.min(Math.max(Number(limitRaw) || 200, 1), 500);
    if (cursor === undefined && limit === undefined && direction === undefined)
      return send(res, harness.history(c));
    return send(res, harness.history(c, { cursor, limit, direction }));
  }
  if (op === 'tasks' && method === 'POST') {
    const v = validate(TaskInput, await body(req));
    if (shuttingDown) fail('unavailable', 'Host is stopping', 503);
    const accepted = product.accept(
      botId,
      v.conversationId,
      v.text,
      v.nonce,
      'interactive',
      null,
      v.artifactRevisionIds,
    );
    send(res, accepted, 202);
    setImmediate(() => {
      void harness.pump();
    });
    return;
  }
  const runOp = op.match(/^runs\/([^/]+)\/(cancel|steer|events)$/);
  if (runOp) {
    const r = owned(runOp[1], 'run', botId);
    if (runOp[2] === 'events')
      return send(
        res,
        store
          .events(Number(url.searchParams.get('cursor') ?? 0), botId)
          .filter((e) => e.run === r.id),
      );
    if (method !== 'POST') fail('not_found', 'Not found', 404);
    if (runOp[2] === 'cancel') return send(res, await harness.cancel(r.id));
    const v = validate(z.object({ text: z.string().min(1).max(32000) }).strict(), await body(req));
    const active = harness.active.get(r.id);
    if (!active) fail('not_running', 'Run is not loaded', 409);
    store.event(botId, r.id, 'request.steer_accepted', { text: v.text });
    await active.session.steer(v.text);
    return send(res, { accepted: true });
  }
  if (op === 'memory' && method === 'POST')
    return send(res, product.memory(botId, await body(req)), 201);
  const memory = op.match(/^memory\/([^/]+)$/);
  if (memory && method === 'PATCH') {
    const old = owned(memory[1], 'memory', botId);
    const v = validate(
      z
        .object({
          revision: z.number().int(),
          content: z.string().min(1).max(32000),
          state: z.enum(['active', 'archived', 'forgotten']),
        })
        .strict(),
      await body(req),
    );
    return send(
      res,
      store.tx(() => {
        store.put('memory_revision', { ...old, id: id(), memoryId: old.id });
        const m = store.put(
          'memory',
          { ...old, content: v.state === 'forgotten' ? '[forgotten]' : v.content, state: v.state },
          v.revision,
        );
        if (v.state === 'forgotten') {
          for (const prior of store
            .list('memory_revision', botId)
            .filter((p) => p.memoryId === old.id))
            store.put('memory_revision', { ...prior, content: '[forgotten]' });
        }
        store.event(botId, null, 'memory.changed', { id: old.id, state: m.state });
        return m;
      }),
    );
  }
  if (op === 'routines' && method === 'POST')
    return send(res, product.routine(botId, await body(req)), 201);
  const routine = op.match(/^routines\/([^/]+)(?:\/(run))?$/);
  if (routine && method === 'POST') {
    const r = owned(routine[1], 'routine', botId);
    if (routine[2]) {
      let c = store.list('conversation', botId).find((c) => c.routineId === r.id);
      if (!c)
        c = store.put('conversation', {
          id: id(),
          botId,
          name: r.name,
          routineId: r.id,
          sessionFile: null,
        });
      return send(res, product.accept(botId, c.id, r.task, id(), 'scheduled'));
    }
    const { revision, ...input } = await body(req);
    validate(z.number().int().positive(), revision);
    const v = validate(RoutineInput, input);
    return send(
      res,
      store.tx(() => {
        const next = store.put(
          'routine',
          {
            ...r,
            ...v,
            state: v.enabled ? 'enabled' : 'paused',
            nextAt: nextOccurrence(v.cron, v.timezone),
          },
          revision,
        );
        store.put('routine_revision', {
          ...next,
          id: id(),
          routineId: r.id,
          definitionRevision: next.revision,
        });
        store.event(botId, null, 'routine.changed', { id: r.id, revision: next.revision });
        return next;
      }),
    );
  }
  if (op === 'artifacts' && method === 'POST')
    return send(res, product.artifact(botId, await body(req), undefined, session.accountId), 201);
  const artifactMetadata = op.match(/^artifacts\/([^/]+)\/metadata$/);
  if (artifactMetadata && method === 'POST')
    return send(res, product.artifactMetadata(botId, artifactMetadata[1], await body(req)));
  const imageArtifact = op.match(/^artifacts\/([^/]+)\/image$/);
  if (imageArtifact && method === 'GET') {
    const revision = owned(imageArtifact[1], 'artifact_revision', botId);
    if (!artifactCapabilities(revision).inlineImage)
      fail(
        'unsupported',
        'Inline image preview supports PNG, JPEG, GIF, WebP and AVIF. Download other originals.',
      );
    res.writeHead(200, {
      'content-type': revision.mediaType,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'content-security-policy': "sandbox; default-src 'none'",
    });
    return res.end(product.bytes(revision));
  }
  const renderArtifact = op.match(/^artifacts\/([^/]+)\/render$/);
  if (renderArtifact && method === 'GET') {
    const revision = owned(renderArtifact[1], 'artifact_revision', botId);
    if (revision.mediaType !== 'text/html')
      fail('unsupported', 'Interactive rendering supports standalone HTML only');
    if (revision.size > 2 * 1024 * 1024)
      fail('capacity', 'Interactive HTML exceeds the 2 MiB rendering limit');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        url.searchParams.get('play') === '1'
          ? "sandbox allow-scripts allow-pointer-lock; default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src https://cdn.jsdelivr.net https://unpkg.com; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'"
          : "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
    });
    return res.end(product.bytes(revision));
  }
  const download = op.match(/^artifacts\/([^/]+)\/download$/);
  if (download) {
    const revision = owned(download[1], 'artifact_revision', botId);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(revision.name)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    return res.end(product.bytes(revision));
  }
  const preview = op.match(/^artifacts\/([^/]+)\/preview$/);
  if (preview) {
    const revision = owned(preview[1], 'artifact_revision', botId);
    if (revision.size > 200000)
      fail('capacity', 'Preview limited to 200 KB; download original bytes');
    const documentKind = documents.supported(revision.mediaType);
    if (documentKind) {
      const doc = await documents.excerpt(revision, 100000);
      if (!['ready', 'partial'].includes(doc.state) || !doc.text)
        fail('unavailable', `Document preview is ${doc.state}`);
      return send(res, {
        ...revision,
        content: doc.text,
        contentTruncated: doc.truncated,
        documentState: doc.state,
        extractedBy: doc.extractor,
        extractionLimitations: doc.limitations,
      });
    }
    if (!/^(text\/|application\/json)/.test(revision.mediaType))
      fail('unsupported', 'No text preview for this media type');
    return send(res, { ...revision, content: product.bytes(revision).toString('utf8') });
  }
  const documentText = op.match(/^artifacts\/([^/]+)\/document$/);
  if (documentText && method === 'GET') {
    const revision = owned(documentText[1], 'artifact_revision', botId);
    const maxChars = Math.min(
      Math.max(Number(url.searchParams.get('maxChars') ?? 200000) || 200000, 1000),
      200000,
    );
    const doc = await documents.excerpt(revision, maxChars);
    if (!['ready', 'partial'].includes(doc.state) || !doc.text)
      fail(doc.state === 'unsupported' ? 'unsupported' : 'unavailable', doc.limitations.join('; '));
    return send(res, doc);
  }
  const approval = op.match(/^approvals\/([^/]+)$/);
  if (approval && method === 'POST') {
    const a = owned(approval[1], 'approval', botId);
    const v = validate(
      z.object({ decision: z.enum(['approved', 'denied']), revision: z.number().int() }).strict(),
      await body(req),
    );
    if (a.tool === 'vault_fill' && !a.runId)
      return send(
        res,
        await personalVault.resolveFill(session.accountId, a.id, v.decision, v.revision),
      );
    if (a.state !== 'pending' || a.expiresAt < Date.now())
      fail('stale_revision', 'Approval is no longer pending', 409);
    const next = store.put(
      'approval',
      { ...a, state: v.decision, decidedBy: session.accountId },
      v.revision,
    );
    store.event(botId, a.runId, 'approval.resolved', { id: a.id, state: next.state });
    return send(res, next);
  }
  if (op === 'computer/generations' && method === 'GET')
    return send(
      res,
      store.list('computer_generation', botId).map((c) => computers.public(c)),
    );
  const removeGeneration = op.match(/^computer\/generations\/([^/]+)\/remove$/);
  if (removeGeneration && method === 'POST') {
    if (bot.ownerId !== session.accountId) fail('not_authorized', 'Computer owner required', 403);
    return send(
      res,
      computers.public(await computers.removeGeneration(botId, removeGeneration[1])),
    );
  }
  if (op === 'computer/snapshots' && method === 'GET')
    return send(
      res,
      store.list('computer_snapshot', botId).map((s) => ({ ...s, file: undefined })),
    );
  const computer = op.match(
    /^computer\/(start|stop|pause|snapshot|restore|reset|update|remove|policy|takeover|handback|ticket)$/,
  );
  if (computer && method === 'POST') {
    const action = computer[1];
    if (bot.ownerId !== session.accountId && action !== 'ticket')
      fail('not_authorized', 'Computer lifecycle/control requires the Bot owner', 403);
    if (['start', 'stop', 'pause'].includes(action))
      return send(res, computers.public(await computers[action](botId)));
    if (action === 'snapshot') return send(res, await computers.snapshot(botId));
    if (action === 'restore') {
      const v = validate(
        z
          .object({
            snapshotId: z.string().uuid(),
            expectedGeneration: z.number().int().positive(),
          })
          .strict(),
        await body(req),
      );
      return send(
        res,
        computers.public(await computers.restore(botId, v.snapshotId, v.expectedGeneration)),
      );
    }
    if (action === 'remove') {
      const v = validate(
        z
          .object({
            expectedGeneration: z.number().int().positive(),
            confirmRemove: z.literal(true),
          })
          .strict(),
        await body(req),
      );
      return send(
        res,
        computers.public(await computers.removeComputer(botId, v.expectedGeneration)),
      );
    }
    if (action === 'reset' || action === 'update') {
      const v = validate(
        z.object({ expectedGeneration: z.number().int().positive() }).strict(),
        await body(req),
      );
      return send(
        res,
        computers.public(
          await computers[action === 'reset' ? 'reset' : 'updateImage'](
            botId,
            v.expectedGeneration,
          ),
        ),
      );
    }
    if (action === 'policy') {
      const v = validate(
        z
          .object({ idlePauseSeconds: z.number().int(), idleStopSeconds: z.number().int() })
          .strict(),
        await body(req),
      );
      return send(res, computers.public(computers.configure(botId, v)));
    }
    if (action === 'takeover' || action === 'handback')
      return send(
        res,
        computers.public(await computers.control(botId, session.id, action === 'takeover')),
      );
    const c = computers.record(botId);
    await computers.owned(c);
    const token = randomBytes(32).toString('hex');
    const mode =
      bot.ownerId === session.accountId && c.controller === 'human' && c.leaseSession === session.id
        ? 'control'
        : 'watch';
    tickets.set(hash(token), {
      botId,
      sessionId: session.id,
      generation: c.generation,
      mode,
      expiresAt: Date.now() + 30000,
    });
    return send(res, { ticket: token, mode, generation: c.generation });
  }
  fail('not_found', 'Not found', 404);
}
const server = http.createServer((req, res) =>
  route(req, res).catch((error) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const known = error instanceof Failure;
    send(
      res,
      {
        error: {
          tag: known ? error.tag : 'operation_failed',
          message: known ? error.message : 'Operation failed. Inspect local service health.',
        },
      },
      known ? error.status : 500,
    );
  }),
);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
async function upgrade(req, socket, head) {
  try {
    originCheck(req);
    if (req.headers.origin !== `http://${req.headers.host}`)
      fail('not_authorized', 'Origin required', 403);
    const session = auth(req);
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname !== '/api/viewer') throw Error();
    const token = u.searchParams.get('ticket');
    const key = hash(token ?? '');
    const ticket = tickets.get(key);
    tickets.delete(key);
    if (!ticket || ticket.expiresAt < Date.now() || ticket.sessionId !== session.id) throw Error();
    const c = computers.record(ticket.botId);
    access.requireBot(session.accountId, c.botId, ticket.mode === 'control');
    await computers.owned(c);
    if (
      c.generation !== ticket.generation ||
      (ticket.mode === 'control' && (c.controller !== 'human' || c.leaseSession !== session.id))
    )
      throw Error();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const remote = new WebSocket(`ws://127.0.0.1:${c.guestPort}/viewer/${ticket.mode}`, {
        headers: { authorization: `Bearer ${vault.read(c.secretRef)}` },
        maxPayload: 8 * 1024 * 1024,
      });
      const set = computers.viewers.get(c.botId) ?? new Set();
      set.add(ws);
      computers.viewers.set(c.botId, set);
      let connected = false;
      remote.on('open', () => (connected = true));
      ws.on('message', (data) => {
        if (connected && remote.readyState === WebSocket.OPEN) remote.send(data);
      });
      remote.on('message', (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      });
      remote.on('error', () => ws.close(1011, 'Guest viewer unavailable'));
      ws.on('error', () => remote.close());
      remote.on('close', () => ws.close());
      ws.on('close', () => {
        remote.close();
        set.delete(ws);
      });
      const expiry = setInterval(() => {
        try {
          auth(req);
          access.requireBot(session.accountId, c.botId, ticket.mode === 'control');
        } catch {
          ws.close(1008, 'Session expired');
        }
      }, 10000);
      ws.on('close', () => clearInterval(expiry));
    });
  } catch {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
}
server.on('upgrade', upgrade);
const remote = new Remote(store, vault, route, upgrade);
let lastRetentionPrune = 0;
const tick = setInterval(() => {
  if (!shuttingDown) {
    try {
      product.tick();
      reminders.tick();
      void coding.monitor();
      actions.tick();
      void harness.pump();
      void computers.tick().catch(() => {});
      if (Date.now() - lastRetentionPrune > 3600000) {
        lastRetentionPrune = Date.now();
        try {
          retention.prune();
        } catch {
          console.error('Retention prune failed; records retained.');
        }
      }
    } catch {
      console.error('Scheduler tick failed; pending records retained.');
    }
  }
  for (const [key, ticket] of tickets) if (ticket.expiresAt < Date.now()) tickets.delete(key);
}, 500);
server.listen(port, '127.0.0.1', () => {
  port = server.address().port;
  oauth.base = `http://127.0.0.1:${port}`;
  mcpOAuth.base = oauth.base;
  console.log(`Orbit ${oauth.base} | data ${store.root} | pid ${process.pid}`);
  void remote
    .start(oauth.base)
    .catch(() => console.error('Remote listener unavailable; local workspace remains running.'));
  process.parentPort?.postMessage({ type: 'ready', url: oauth.base, pid: process.pid, version });
});
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(tick);
  documents.stop();
  await remote.stop();
  await modelSignIn.stop();
  await coding.stop();
  await harness.stop();
  await computers.drain();
  for (const res of listeners) res.end();
  for (const c of store.list('computer')) computers.closeViewers(c.botId);
  server.close(() => {
    store.close();
    hostOwner.close().finally(() => process.exit(0));
  });
  server.closeIdleConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.parentPort?.on('message', (event) => {
  if (event.data?.type === 'shutdown') void shutdown();
});
