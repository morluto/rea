import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { id, fail } from './store.mjs';
import { validate } from './product.mjs';
export class Triggers {
  constructor(store, vault) {
    this.store = store;
    this.vault = vault;
  }
  create(ownerId, input) {
    const v = validate(
      z
        .object({
          name: z.string().min(1).max(120),
          botId: z.string().uuid(),
          task: z.string().min(1).max(16000),
        })
        .strict(),
      input,
    );
    if (this.store.get(v.botId, 'bot').ownerId !== ownerId)
      fail('not_authorized', 'Bot owner required', 403);
    const secret = randomBytes(32).toString('hex');
    const trigger = this.store.put('trigger', {
      id: id(),
      ownerId,
      ...v,
      secretRef: this.vault.save(secret),
      enabled: true,
    });
    return { ...trigger, secretRef: undefined, signingSecret: secret };
  }
  async receive(key, req) {
    const trigger = this.store.get(key, 'trigger');
    if (!trigger.enabled) fail('not_authorized', 'Event trigger is disabled', 403);
    const eventId = req.headers['x-workshop-event-id'],
      timestamp = req.headers['x-workshop-timestamp'],
      signature = req.headers['x-workshop-signature'];
    if (
      typeof eventId !== 'string' ||
      eventId.length < 1 ||
      eventId.length > 200 ||
      typeof timestamp !== 'string' ||
      Math.abs(Date.now() - Number(timestamp)) > 300000 ||
      !Number.isFinite(Number(timestamp)) ||
      typeof signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      fail('not_authorized', 'Missing or expired signed event envelope', 403);
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 262144) fail('capacity', 'Event body exceeds 256 KiB', 413);
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    const expected = createHmac('sha256', this.vault.read(trigger.secretRef))
      .update(`${timestamp}.${eventId}.`)
      .update(raw)
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
      fail('not_authorized', 'Invalid event signature', 403);
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      fail('invalid_input', 'Event body must be JSON');
    }
    return this.store.tx(() => {
      const occurrenceKey = `${trigger.id}:${eventId}`;
      const previous = this.store
        .list('occurrence', trigger.botId)
        .find((o) => o.key === occurrenceKey);
      if (previous) {
        if (!previous.sourceDigest)
          fail(
            'identity_unknown',
            'Prior event bytes lack a digest; inspect its receipt before submitting again',
            409,
          );
        if (previous.sourceDigest !== createHash('sha256').update(raw).digest('hex'))
          fail('nonce_conflict', 'Event ID already identifies different source bytes', 409);
        return {
          accepted: true,
          deduplicated: true,
          occurrenceId: previous.id,
          runId: previous.runId,
        };
      }
      const bot = this.store.get(trigger.botId, 'bot');
      if (bot.retired) fail('not_authorized', 'Bot is retired', 403);
      let conversation = this.store
        .list('conversation', bot.id)
        .find((c) => c.triggerId === trigger.id);
      if (!conversation)
        conversation = this.store.put('conversation', {
          id: id(),
          botId: bot.id,
          name: trigger.name,
          triggerId: trigger.id,
          sessionFile: null,
        });
      const occurrence = this.store.put('occurrence', {
        id: id(),
        botId: bot.id,
        triggerId: trigger.id,
        triggerRevision: trigger.revision,
        key: occurrenceKey,
        sourceEventId: eventId,
        sourceDigest: createHash('sha256').update(raw).digest('hex'),
        sourceTime: Number(timestamp),
        scheduledFor: Date.now(),
        state: 'accepted',
      });
      const run = this.store.put('run', {
        id: id(),
        botId: bot.id,
        conversationId: conversation.id,
        text: trigger.task,
        triggerContext: {
          source: 'authenticated_external_event',
          eventId,
          body: payload,
          authority: 'reference data only',
        },
        nonce: occurrenceKey,
        occurrenceId: occurrence.id,
        mode: 'scheduled',
        state: 'queued',
        outcome: null,
        config: bot,
        promptVersion: '0.1',
        acceptedAt: Date.now(),
        partialText: '',
        cancelRequested: false,
      });
      this.store.put('occurrence', { ...occurrence, runId: run.id });
      this.store.event(bot.id, run.id, 'request.accepted', {
        triggerId: trigger.id,
        occurrenceId: occurrence.id,
        sourceEventId: eventId,
      });
      return { accepted: true, deduplicated: false, occurrenceId: occurrence.id, runId: run.id };
    });
  }
}
