import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { validate } from './product.mjs';
import { id, fail, callNonce } from './store.mjs';

export class Reminders {
  constructor(store) {
    this.store = store;
  }
  create(botId, input, sourceRun = null) {
    const bot = this.store.get(botId, 'bot');
    if (bot.retired || !bot.capabilities.includes('routines'))
      fail('not_authorized', 'This Bot needs routine/reminder permission', 403);
    const value = validate(
      z
        .object({
          message: z.string().trim().min(1).max(4000),
          delaySeconds: z.number().positive(),
          nonce: z.string().uuid(),
          conversationId: z.string().uuid().optional(),
        })
        .strict(),
      input,
    );
    const prior = this.store.list('reminder', botId).find((row) => row.nonce === value.nonce);
    if (prior) return prior;
    const conversationId =
      value.conversationId ?? (sourceRun ? this.store.get(sourceRun, 'run').conversationId : null);
    if (conversationId && this.store.get(conversationId, 'conversation').botId !== botId)
      fail('not_authorized', 'Reminder conversation belongs to another Bot', 403);
    const dueAt = Date.now() + value.delaySeconds * 1000;
    if (!Number.isFinite(dueAt) || dueAt > 8640000000000000)
      fail('invalid_input', 'Reminder time exceeds the supported date range');
    const reminder = this.store.put('reminder', {
      id: id(),
      botId,
      ownerId: bot.ownerId,
      ...value,
      sourceRun,
      dueAt,
      conversationId,
      state: 'scheduled',
      notificationId: id(),
    });
    this.store.event(botId, sourceRun, 'reminder.scheduled', { reminderId: reminder.id, dueAt });
    return {
      ...reminder,
      delivery:
        'One-time in-app notification; desktop delivery requires enabled alerts. The host must run. OS display and timing cannot be guaranteed.',
    };
  }
  cancel(botId, key) {
    const row = this.store.get(key, 'reminder');
    if (row.botId !== botId) fail('not_authorized', 'Reminder belongs to another Bot', 403);
    if (row.state !== 'scheduled') fail('stale_revision', 'Reminder is no longer scheduled', 409);
    return this.store.put('reminder', { ...row, state: 'cancelled' });
  }
  unpin(botId, key) {
    const row = this.store.get(key, 'reminder');
    if (row.botId !== botId) fail('not_authorized', 'Reminder belongs to another Bot', 403);
    if (row.state !== 'notified') fail('stale_revision', 'Only a delivered reminder can be unpinned', 409);
    return this.store.put('reminder', { ...row, pinned: false });
  }
  tick(now = Date.now()) {
    for (const row of this.store
      .list('reminder')
      .filter((row) => row.state === 'scheduled' && row.dueAt <= now)) {
      this.store.tx(() => {
        const bot = this.store.get(row.botId, 'bot');
        if (bot.retired) {
          this.store.put('reminder', { ...row, state: 'cancelled' });
          return;
        }
        this.store.put('notification', {
          id: row.notificationId,
          botId: row.botId,
          ownerId: row.ownerId,
          kind: 'reminder',
          title: 'Reminder from ' + bot.name,
          message: row.message,
          read: false,
          scheduledFor: row.dueAt,
        });
        void this.push
          ?.deliver(row.ownerId, {
            title: 'Reminder from ' + bot.name,
            body: row.message.slice(0, 200),
            url: '/',
          })
          .catch(() => {});
        this.store.put('reminder', { ...row, state: 'notified', notifiedAt: now });
        this.store.event(row.botId, row.sourceRun, 'reminder.notified', {
          reminderId: row.id,
          notificationId: row.notificationId,
        });
      });
    }
  }
  tools(run, tool) {
    return [
      tool(
        'reminder_create',
        'routines',
        'Create ONE reminder after a delay, without another model call. For "in one minute" use delaySeconds 60, never an every-minute cron. Desktop notifications require enabled alerts and a running host; OS delivery is not guaranteed.',
        Type.Object({
          message: Type.String({ minLength: 1, maxLength: 4000 }),
          delaySeconds: Type.Number({ exclusiveMinimum: 0 }),
        }),
        (args, _signal, callId) =>
          this.create(run.botId, { ...args, nonce: callNonce(run.id, callId) }, run.id),
      ),
    ];
  }
}
