import { z } from 'zod';
import { validate } from './product.mjs';
import { fail } from './store.mjs';

const Policy = z
  .object({
    eventDays: z.number().int().min(7).max(3650).default(90),
    snapshotDays: z.number().int().min(1).max(365).default(30),
    partialDays: z.number().int().min(1).max(365).default(14),
    notificationDays: z.number().int().min(1).max(365).default(30),
    revision: z.number().int().optional(),
  })
  .strict();

export class Retention {
  constructor(store) {
    this.store = store;
  }
  config() {
    try {
      return this.store.get('retention', 'retention_policy');
    } catch {
      return {
        id: 'retention',
        eventDays: 90,
        snapshotDays: 30,
        partialDays: 14,
        notificationDays: 30,
        revision: 0,
      };
    }
  }
  save(input) {
    const value = validate(Policy, input);
    const previous = this.config();
    if (previous.revision !== (value.revision ?? 0))
      fail('stale_revision', 'Retention policy changed; refresh before saving', 409);
    const record = this.store.put(
      'retention_policy',
      { id: 'retention', ...value },
      previous.revision || undefined,
    );
    this.store.event(null, null, 'retention.configured', {
      eventDays: record.eventDays,
      snapshotDays: record.snapshotDays,
      partialDays: record.partialDays,
      notificationDays: record.notificationDays,
    });
    return record;
  }
  prune(now = Date.now()) {
    const policy = this.config();
    const cutoff = (days) => now - days * 86400000;
    const deletedEvents = this.store.db
      .prepare('DELETE FROM events WHERE at<?')
      .run(cutoff(policy.eventDays)).changes;
    let deletedSnapshots = 0;
    for (const snapshot of this.store.list('library_search_snapshot')) {
      if (snapshot.expiresAt <= now || snapshot.createdAt < cutoff(policy.snapshotDays)) {
        this.store.db.prepare('DELETE FROM records WHERE id=?').run(snapshot.id);
        deletedSnapshots++;
      }
    }
    let clearedPartials = 0;
    for (const run of this.store.list('run')) {
      if (
        run.partialText &&
        ['settled', 'failed', 'cancelled', 'interrupted'].includes(run.state) &&
        (run.finishedAt ?? run.updatedAt) < cutoff(policy.partialDays)
      ) {
        this.store.put('run', { ...run, partialText: '', partialHasTools: false });
        clearedPartials++;
      }
    }
    let deletedNotifications = 0;
    for (const note of this.store.list('notification')) {
      if (note.read && (note.updatedAt ?? note.createdAt) < cutoff(policy.notificationDays)) {
        this.store.db.prepare('DELETE FROM records WHERE id=?').run(note.id);
        deletedNotifications++;
      }
    }
    const result = {
      deletedEvents,
      deletedSnapshots,
      clearedPartials,
      deletedNotifications,
      at: now,
    };
    this.store.event(null, null, 'retention.pruned', result);
    return result;
  }
}
