import { randomBytes } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { id, fail } from './store.mjs';
import { hash } from './security.mjs';
import { validate } from './product.mjs';
export class Devices {
  constructor(store, vault) {
    this.store = store;
    this.vault = vault;
  }
  public(d) {
    return { ...d, pairHash: undefined, secretRef: undefined };
  }
  begin(ownerId, input) {
    const v = validate(
      z
        .object({
          name: z.string().min(1).max(120),
          botIds: z.array(z.string().uuid()),
          files: z.boolean().default(false),
          routing: z.boolean().default(false),
        })
        .strict(),
      input,
    );
    for (const key of v.botIds)
      if (this.store.get(key, 'bot').ownerId !== ownerId)
        fail('not_authorized', 'Bot owner required', 403);
    const code = randomBytes(24).toString('hex');
    const device = this.store.put('device', {
      id: id(),
      ownerId,
      ...v,
      pairHash: hash(code),
      pairExpiresAt: Date.now() + 600000,
      state: 'pending',
      generation: null,
      endpoint: null,
      secretRef: null,
    });
    return { ...this.public(device), pairCode: code };
  }
  pair(input) {
    const v = validate(
      z
        .object({
          code: z.string().min(32).max(100),
          endpoint: z.url(),
          generation: z.string().uuid(),
          token: z.string().min(32).max(200),
          os: z.string().min(1).max(120),
          rootLabel: z.string().max(1000),
          capabilities: z.array(z.enum(['files', 'http-routing'])).max(2),
        })
        .strict(),
      input,
    );
    const endpoint = new URL(v.endpoint);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password
    )
      fail('not_authorized', 'This local deployment only pairs loopback companions', 403);
    const d = this.store
      .list('device')
      .find(
        (d) => d.state === 'pending' && d.pairHash === hash(v.code) && d.pairExpiresAt > Date.now(),
      );
    if (!d) fail('not_authorized', 'Pairing code expired or already used', 403);
    const next = this.store.put('device', {
      ...d,
      endpoint: v.endpoint,
      generation: v.generation,
      os: v.os,
      rootLabel: v.rootLabel,
      capabilities: v.capabilities,
      secretRef: this.vault.save(v.token),
      pairHash: null,
      state: 'paired',
      lastSeen: Date.now(),
    });
    return this.public(next);
  }
  async request(d, path, input, signal) {
    if (d.state === 'revoked' || !d.endpoint)
      fail('device_unavailable', 'Device is not paired', 409);
    let response;
    try {
      response = await fetch(new URL(path, d.endpoint), {
        method: input === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${this.vault.read(d.secretRef)}`,
          'content-type': 'application/json',
          'x-workshop-generation': d.generation,
        },
        body: input === undefined ? undefined : JSON.stringify(input),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
      });
    } catch {
      this.store.put('device', { ...this.store.get(d.id, 'device'), state: 'unreachable' });
      fail(
        'device_unavailable',
        'Paired companion is unreachable; no replacement was allocated',
        409,
      );
    }
    let bytes = 0;
    const chunks = [];
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length;
      if (bytes > 1500000) fail('capacity', 'Device response exceeds the inline byte limit');
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok)
      fail(value.tag ?? 'device_failure', value.message ?? 'Device refused the operation', 409);
    return value;
  }
  async check(key) {
    const d = this.store.get(key, 'device');
    const health = await this.request(d, '/health');
    if (health.generation !== d.generation)
      fail('identity_unknown', 'Companion generation changed; pair again before using it', 409);
    const next = this.store.put('device', { ...d, state: 'paired', lastSeen: Date.now(), health });
    return this.public(next);
  }
  update(key, ownerId, input) {
    const d = this.store.get(key, 'device');
    if (d.ownerId !== ownerId) fail('not_authorized', 'Device owner required', 403);
    const v = validate(
      z
        .object({
          revision: z.number().int(),
          name: z.string().min(1).max(120),
          botIds: z.array(z.string().uuid()),
          files: z.boolean(),
          routing: z.boolean(),
          state: z.enum(['paired', 'revoked']),
        })
        .strict(),
      input,
    );
    if (['pending', 'revoked'].includes(d.state) && v.state === 'paired')
      fail(
        'not_authorized',
        'Complete a new pairing rather than relabelling an unpaired/revoked device',
        403,
      );
    for (const b of v.botIds)
      if (this.store.get(b, 'bot').ownerId !== ownerId)
        fail('not_authorized', 'Bot owner required', 403);
    return this.public(this.store.put('device', { ...d, ...v }, v.revision));
  }
  async operation(run, deviceId, kind, input, signal) {
    const d = this.store.get(deviceId, 'device');
    if (
      !d.botIds.includes(run.botId) ||
      d.state === 'revoked' ||
      !d[kind === 'fetch' ? 'routing' : 'files']
    )
      fail('not_authorized', 'The selected device capability is not granted to this Bot', 403);
    await this.check(d.id);
    return this.request(
      this.store.get(d.id, 'device'),
      kind === 'fetch' ? '/fetch' : '/files/' + kind,
      input,
      signal,
    );
  }
  tools(run, wrap) {
    return [
      wrap(
        'device_inventory',
        'devices',
        'List explicitly paired targets and current known presence. A paired record is not a live health check.',
        Type.Object({}),
        () =>
          this.store
            .list('device')
            .filter((d) => d.botIds.includes(run.botId) && d.state !== 'revoked')
            .map((d) => this.public(d)),
      ),
      wrap(
        'device_read',
        'devices',
        'Read a relative UTF-8 file under the selected companion’s explicit workspace root. Requires approval.',
        Type.Object({ deviceId: Type.String(), path: Type.String() }),
        (a, s) => this.operation(run, a.deviceId, 'read', { path: a.path }, s),
        true,
      ),
      wrap(
        'device_write',
        'devices',
        'Write a UTF-8 file inside the selected companion’s explicit workspace root. Requires approval; cannot access other roots.',
        Type.Object({ deviceId: Type.String(), path: Type.String(), content: Type.String() }),
        (a, s) => this.operation(run, a.deviceId, 'write', { path: a.path, content: a.content }, s),
        true,
      ),
    ];
  }
}
