import https from 'node:https';
import { createSecureContext } from 'node:tls';
import { randomBytes, X509Certificate } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import selfsigned from 'selfsigned';
import { z } from 'zod';
import { id, fail } from './store.mjs';
import { hash } from './security.mjs';
import { validate } from './product.mjs';

// One opt-in gateway serves the existing workspace. Remote clients never own a
// scheduler, Pi history, computer, or copy of the product database.
const pairingHTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair with your primary host · Orbit</title><link rel="stylesheet" href="/remote/pair.css"></head><body><main><div class="orb" aria-hidden="true">··</div><p>Orbit</p><h1>Bring your<br>workspace along.</h1><p>Enter the one-use pairing code from your primary Windows host. Your Bots, sessions and computers keep running there.</p><form><label for="name">This device’s name</label><input id="name" maxlength="120" required autocomplete="off" placeholder="My MacBook"><label for="code">Pairing code</label><input id="code" required autocomplete="off" spellcheck="false" autocapitalize="none"><button>Pair this device</button><p id="error" role="alert"></p></form></main><script src="/remote/pair.js"></script></body></html>`;
const pairingCSS = `*{box-sizing:border-box}body{margin:0;background:#f4f6f3;color:#293b2e;font:15px/1.55 system-ui}main{max-width:470px;padding:48px 28px;margin:auto}h1{font:54px/1 Georgia,serif;letter-spacing:-2px;margin:24px 0}p{color:#69766b}.orb{width:74px;height:74px;border-radius:50%;background:radial-gradient(circle at 32% 24%,#c9d8bd,#7c976d);font:bold 44px/60px system-ui;text-align:center;color:#2d422b;letter-spacing:4px}form{margin-top:28px}label{display:block;font-size:13px;margin:14px 0 6px}input,button{width:100%;padding:12px;border:1px solid #cdd8c9;border-radius:9px;font:inherit;background:#fff}button{margin-top:20px;border:0;background:#344f39;color:#fff;cursor:pointer}button:disabled{opacity:.5}#error{color:#a34030;font-size:13px}`;
const pairingJS = `document.querySelector('form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;const error=document.querySelector('#error');error.textContent='';try{const r=await fetch('/remote/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:document.querySelector('#name').value,code:document.querySelector('#code').value.trim()})});const v=await r.json();if(!r.ok)throw Error(v.error.message);location.replace('/');}catch(e){error.textContent=e.message;}finally{b.disabled=false;}};`;
const cookie = (req, name) =>
  req.headers.cookie
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + '='))
    ?.slice(name.length + 1);
export class Remote {
  constructor(store, vault, dispatch, upgrade) {
    this.store = store;
    this.vault = vault;
    this.dispatch = dispatch;
    this.upgrade = upgrade;
    this.server = null;
    this.sockets = new Set();
    this.lastError = null;
    this.localURL = null;
  }
  record() {
    return this.store.list('remote_config')[0];
  }
  addresses() {
    return Object.entries(networkInterfaces()).flatMap(([name, values]) =>
      values
        .filter((v) => v.family === 'IPv4' && !v.internal)
        .map((v) => ({ name, address: v.address })),
    );
  }
  status() {
    const c = this.record();
    return {
      enabled: !!c?.enabled,
      running: !!this.server?.listening,
      url: c?.url ?? null,
      port: this.server?.address()?.port ?? c?.port ?? null,
      bind: c?.bind ?? null,
      fingerprint: c?.fingerprint ?? null,
      lastError: this.lastError,
      addresses: this.addresses(),
      clients: this.store.list('remote_client').map(({ tokenHash, ...c }) => c),
    };
  }
  async quick(ownerId, input) {
    const v = validate(z.object({ address: z.string().min(1).max(100) }).strict(), input);
    if (!this.addresses().some((a) => a.address === v.address))
      fail('invalid_input', 'Choose a current address on this host');
    const tls = await selfsigned.generate([{ name: 'commonName', value: v.address }], {
      algorithm: 'sha256',
      keySize: 2048,
      notAfterDate: new Date(Date.now() + 365 * 86400000),
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
        { name: 'subjectAltName', altNames: [{ type: 7, ip: v.address }] },
      ],
    });
    return this.configure(ownerId, {
      enabled: true,
      url: `https://${v.address}:44317`,
      bind: v.address,
      port: 44317,
      certificate: tls.cert,
      privateKey: tls.private,
    });
  }
  async configure(ownerId, input) {
    const v = validate(
      z
        .object({
          enabled: z.boolean(),
          url: z.url(),
          bind: z.string().min(1).max(200),
          port: z.number().int().min(0).max(65535),
          certificate: z.string().min(100).max(65536).optional(),
          privateKey: z.string().min(100).max(65536).optional(),
        })
        .strict(),
      input,
    );
    const u = new URL(v.url);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.pathname !== '/' ||
      u.search ||
      u.hash
    )
      fail('invalid_input', 'Use an HTTPS origin without a path, credentials or query');
    const old = this.record();
    if (old && old.ownerId !== ownerId) fail('not_authorized', 'Primary host owner required', 403);
    let tlsRef = old?.tlsRef,
      fingerprint = old?.fingerprint;
    if (v.certificate || v.privateKey) {
      if (!v.certificate || !v.privateKey)
        fail('invalid_input', 'Select both certificate and private key');
      try {
        createSecureContext({ cert: v.certificate, key: v.privateKey });
        const cert = new X509Certificate(v.certificate);
        if (Date.parse(cert.validTo) < Date.now())
          fail('invalid_input', 'This certificate has expired');
        fingerprint = cert.fingerprint256;
      } catch (e) {
        if (e.tag) throw e;
        fail('invalid_input', 'Certificate and key must form a matching PEM TLS identity');
      }
      tlsRef = this.vault.save(JSON.stringify({ cert: v.certificate, key: v.privateKey }));
    }
    if (v.enabled && !tlsRef)
      fail('invalid_input', 'A trusted TLS certificate and matching private key are required');
    await this.stop();
    this.store.put('remote_config', {
      id: old?.id ?? id(),
      ownerId,
      enabled: v.enabled,
      url: u.origin,
      bind: v.bind,
      port: v.port,
      tlsRef,
      fingerprint,
    });
    if (v.enabled) await this.start(this.localURL);
    return this.status();
  }
  begin(ownerId, name) {
    if (!this.server?.listening)
      fail('unavailable', 'Enable remote access on the primary host first', 409);
    const code = randomBytes(24).toString('hex');
    const pair = this.store.put('remote_pair', {
      id: id(),
      ownerId,
      name: validate(z.string().min(1).max(120), name),
      codeHash: hash(code),
      expiresAt: Date.now() + 600000,
      state: 'pending',
    });
    return { code, expiresAt: pair.expiresAt, url: this.record().url };
  }
  revoke(key, ownerId) {
    const c = this.store.get(key, 'remote_client');
    if (c.ownerId !== ownerId) fail('not_authorized', 'Primary host owner required', 403);
    this.store.put('remote_client', { ...c, state: 'revoked' });
    for (const socket of this.sockets) if (socket.workshopClient === key) socket.destroy();
    return this.status();
  }
  client(req) {
    const token = cookie(req, 'workshop_device');
    const c =
      token &&
      this.store
        .list('remote_client')
        .find(
          (c) => c.tokenHash === hash(token) && c.state === 'paired' && c.expiresAt > Date.now(),
        );
    if (!c) fail('pairing_required', 'Pair this device on your primary host first', 401);
    req.socket.workshopClient = c.id;
    return c;
  }
  validateOrigin(req) {
    const c = this.record();
    if (req.headers.host !== new URL(c.url).host)
      fail('not_authorized', 'Selected primary host address required', 403);
    if (req.headers.origin && req.headers.origin !== c.url)
      fail('not_authorized', 'Same-origin request required', 403);
  }
  adapt(req) {
    req.workshopRemote = true;
    const local = new URL(this.localURL);
    req.headers.host = local.host;
    if (req.headers.origin) req.headers.origin = this.localURL;
  }
  async handle(req, res) {
    try {
      this.validateOrigin(req);
      const path = new URL(req.url, this.record().url).pathname;
      if (path === '/remote/pair.js' && req.method === 'GET')
        return this.static(res, pairingJS, 'application/javascript');
      if (path === '/remote/pair.css' && req.method === 'GET')
        return this.static(res, pairingCSS, 'text/css');
      if (path === '/remote/pair' && req.method === 'POST') {
        if (req.headers.origin !== this.record().url)
          fail('not_authorized', 'Same-origin pairing required', 403);
        const parts = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 2048) fail('capacity', 'Pairing request too large', 413);
          parts.push(chunk);
        }
        let input;
        try {
          input = JSON.parse(Buffer.concat(parts).toString('utf8'));
        } catch {
          fail('invalid_input', 'Malformed pairing request');
        }
        const v = validate(
          z.object({ code: z.string().length(48), name: z.string().min(1).max(120) }).strict(),
          input,
        );
        const pair = this.store
          .list('remote_pair')
          .find(
            (p) => p.codeHash === hash(v.code) && p.state === 'pending' && p.expiresAt > Date.now(),
          );
        if (!pair) fail('not_authorized', 'Pairing code expired or already used', 403);
        const token = randomBytes(32).toString('hex');
        this.store.tx(() => {
          this.store.put('remote_pair', { ...pair, state: 'consumed' });
          this.store.put('remote_client', {
            id: id(),
            ownerId: pair.ownerId,
            name: v.name,
            label: pair.name,
            state: 'paired',
            tokenHash: hash(token),
            expiresAt: Date.now() + 90 * 86400000,
          });
        });
        res.setHeader(
          'set-cookie',
          `workshop_device=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=7776000`,
        );
        return this.json(res, { paired: true });
      }
      try {
        this.client(req);
      } catch (error) {
        if (req.method === 'GET' && path === '/') return this.static(res, pairingHTML, 'text/html');
        throw error;
      }
      // Pairing grants transport access, not an account. The existing signed-in
      // account and all per-Bot permissions still apply inside the workspace.
      this.adapt(req);
      await this.dispatch(req, res);
    } catch (e) {
      this.json(
        res,
        {
          error: {
            tag: e.tag ?? 'operation_failed',
            message: e.tag ? e.message : 'Remote operation failed',
          },
        },
        e.status ?? 500,
      );
    }
  }
  static(res, value, type) {
    res.writeHead(200, {
      'content-type': type + '; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(value);
  }
  json(res, value, status = 200) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  async start(localURL) {
    this.localURL = localURL;
    const c = this.record();
    if (!c?.enabled || this.server) return;
    try {
      const server = https.createServer(
        { ...JSON.parse(this.vault.read(c.tlsRef)), minVersion: 'TLSv1.2' },
        (req, res) => void this.handle(req, res),
      );
      this.server = server;
      server.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
      });
      server.on('upgrade', (req, socket, head) => {
        try {
          this.validateOrigin(req);
          this.client(req);
          this.adapt(req);
          void this.upgrade(req, socket, head);
        } catch {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        }
      });
      await new Promise((yes, no) => {
        server.once('error', no);
        server.listen(c.port, c.bind, yes);
      });
      server.on(
        'error',
        () =>
          (this.lastError =
            'Remote listener failed; inspect the configured interface and TLS identity.'),
      );
      this.lastError = null;
    } catch {
      await this.stop();
      this.lastError =
        'Remote listener could not start. Check the TLS identity, interface and port.';
      fail('unavailable', this.lastError, 409);
    }
  }
  async stop() {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise((r) => server.close(r));
  }
}
