import { z } from 'zod';
import { validate } from './product.mjs';
import { fail, id } from './store.mjs';

const Subscription = z
  .object({
    endpoint: z.url(),
    // Browsers always emit expirationTime via subscription.toJSON() (usually null);
    // accept and drop it rather than rejecting browser-shaped payloads.
    expirationTime: z.number().nullable().optional(),
    keys: z
      .object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) })
      .strict(),
    userAgent: z.string().max(500).optional(),
  })
  .strict();

async function webpush() {
  try {
    const module = await import('web-push');
    return module.default ?? module;
  } catch {
    fail('unavailable', 'Push delivery dependency is not installed', 503);
  }
}

export class Push {
  constructor(store, vault) {
    Object.assign(this, { store, vault });
  }
  status(ownerId) {
    let config = null;
    try {
      config = this.store.get('push', 'push_config');
    } catch {
      config = null;
    }
    return {
      supported: true,
      configured: !!config,
      publicKey: config?.publicKey ?? null,
      subscriptions: this.store
        .list('push_subscription')
        .filter((s) => s.ownerId === ownerId)
        .map((s) => ({ id: s.id, endpoint: s.endpoint, createdAt: s.createdAt })),
    };
  }
  async configure(ownerId) {
    const push = await webpush();
    let config = null;
    try {
      config = this.store.get('push', 'push_config');
    } catch {
      config = null;
    }
    if (!config) {
      const keys = push.generateVAPIDKeys();
      const secretRef = this.vault.save(
        JSON.stringify({ publicKey: keys.publicKey, privateKey: keys.privateKey }),
      );
      config = this.store.put('push_config', {
        id: 'push',
        publicKey: keys.publicKey,
        secretRef,
      });
      this.store.event(null, null, 'push.configured', { ownerId });
    }
    return { publicKey: config.publicKey, subject: 'mailto:orbit@localhost' };
  }
  subscribe(ownerId, input) {
    const { expirationTime: _dropped, ...value } = validate(Subscription, input);
    if (!value.endpoint.startsWith('https://'))
      fail('invalid_input', 'Push endpoints must be HTTPS');
    const existing = this.store
      .list('push_subscription')
      .find((s) => s.ownerId === ownerId && s.endpoint === value.endpoint);
    const record = this.store.put('push_subscription', {
      id: existing?.id ?? id(),
      ownerId,
      ...value,
      state: 'active',
    });
    this.store.event(null, null, 'push.subscribed', { id: record.id, ownerId });
    return { id: record.id, endpoint: record.endpoint };
  }
  unsubscribe(ownerId, subscriptionId) {
    const record = this.store.get(subscriptionId, 'push_subscription');
    if (record.ownerId !== ownerId) fail('not_authorized', 'Subscription belongs elsewhere', 403);
    this.store.db.prepare('DELETE FROM records WHERE id=?').run(record.id);
    this.store.event(null, null, 'push.unsubscribed', { id: record.id, ownerId });
    return { removed: true };
  }
  async deliver(ownerId, { title, body, url }) {
    const config = this.status(ownerId);
    if (!config.configured) return { delivered: 0, removed: 0, state: 'unconfigured' };
    const push = await webpush();
    const keys = JSON.parse(this.vault.read(this.store.get('push', 'push_config').secretRef));
    push.setVapidDetails('mailto:orbit@localhost', keys.publicKey, keys.privateKey);
    let delivered = 0,
      removed = 0;
    for (const sub of this.store
      .list('push_subscription')
      .filter((s) => s.ownerId === ownerId && s.state === 'active')) {
      try {
        await push.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify({ title, body, url }),
          { TTL: 86400 },
        );
        delivered++;
      } catch (e) {
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          this.store.db.prepare('DELETE FROM records WHERE id=?').run(sub.id);
          removed++;
        }
      }
    }
    this.store.event(null, null, 'push.delivered', { ownerId, delivered, removed });
    return { delivered, removed, state: 'sent' };
  }
}
