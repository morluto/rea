import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { id, fail } from './store.mjs';
import { DOCUMENT_MEDIA } from './documents.mjs';
import {
  parse,
  MemoryInput,
  RoutineInput,
  ArtifactInput,
  ArtifactMetadataInput,
} from './contracts.mjs';

export function validate(schema, input) {
  const r = parse(schema, input);
  if (!r.ok) fail(r.error.tag, r.error.message);
  return r.value;
}
export function artifactCapabilities(revision) {
  return {
    inlineImage: /^image\/(png|jpeg|gif|webp|avif)$/.test(revision.mediaType),
    attachable:
      /^(text\/|application\/json)/.test(revision.mediaType) ||
      !!DOCUMENT_MEDIA[revision.mediaType]?.kind,
  };
}
export const nextOccurrence = (cron, timezone, date = Date.now()) => {
  try {
    return CronExpressionParser.parse(cron, { tz: timezone, currentDate: new Date(date) })
      .next()
      .getTime();
  } catch {
    fail('invalid_schedule', 'Enter a valid five-field cron expression and IANA timezone.');
  }
};
export class Product {
  constructor(store) {
    this.store = store;
    mkdirSync(join(store.root, 'artifacts'), { recursive: true });
  }
  memory(botId, input, sourceRun) {
    const value = validate(MemoryInput, input);
    if (
      value.conversationId &&
      this.store.get(value.conversationId, 'conversation').botId !== botId
    )
      fail('not_authorized', 'Conversation belongs to another Bot', 403);
    return this.store.tx(() => {
      const m = this.store.put('memory', { id: id(), botId, ...value, sourceRun, state: 'active' });
      this.store.event(botId, sourceRun, 'memory.created', { id: m.id, revision: m.revision });
      return m;
    });
  }
  artifact(botId, input, sourceRun, publisherAccountId = null) {
    const value = validate(ArtifactInput, input);
    const old = value.artifactId ? this.store.get(value.artifactId, 'artifact') : null;
    if (old && old.botId !== botId) fail('not_authorized', 'Artifact belongs to another Bot', 403);
    if (old && value.expectedRevision !== old.revision)
      fail('stale_revision', 'Supply the current artifact revision', 409);
    if (
      value.encoding === 'base64' &&
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.content)
    )
      fail('invalid_input', 'Malformed base64 bytes');
    const bytes = Buffer.from(value.content, value.encoding === 'base64' ? 'base64' : 'utf8');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const path = join(this.store.root, 'artifacts', digest);
    if (!existsSync(path)) writeFileSync(path, bytes, { flag: 'wx' });
    return this.store.tx(() => {
      const artifactId = old?.id ?? id();
      const revision = this.store.put('artifact_revision', {
        id: id(),
        botId,
        artifactId,
        name: value.name,
        mediaType: value.mediaType,
        size: bytes.length,
        digest,
        sourceRun: sourceRun ?? null,
        publisherAccountId: sourceRun ? null : publisherAccountId,
        provenance: sourceRun ? 'model_tool' : 'user_upload',
      });
      const artifact = this.store.put(
        'artifact',
        {
          ...old,
          id: artifactId,
          botId,
          name: value.name,
          currentRevisionId: revision.id,
          state: 'available',
        },
        old?.revision,
      );
      this.store.event(botId, sourceRun, 'artifact.published', {
        artifactId,
        revisionId: revision.id,
        digest,
      });
      return { artifact, revision };
    });
  }
  bytes(revision) {
    return readFileSync(join(this.store.root, 'artifacts', revision.digest));
  }
  artifactMetadata(botId, artifactId, input) {
    const value = validate(ArtifactMetadataInput, input);
    const old = this.store.get(artifactId, 'artifact');
    if (old.botId !== botId) fail('not_authorized', 'Artifact belongs to another Bot', 403);
    return this.store.tx(() => {
      const next = this.store.put('artifact', { ...old, pinned: value.pinned }, value.revision);
      this.store.event(botId, null, 'artifact.metadata_changed', {
        artifactId,
        pinned: next.pinned,
        revision: next.revision,
      });
      return next;
    });
  }
  routine(botId, input) {
    const value = validate(RoutineInput, input);
    if (value.cron.trim().split(/\s+/).length !== 5)
      fail('invalid_schedule', 'Use five fields: minute hour day month weekday.');
    const nextAt = nextOccurrence(value.cron, value.timezone);
    return this.store.tx(() => {
      const routine = this.store.put('routine', {
        id: id(),
        botId,
        ...value,
        nextAt,
        overlap: 'skip',
        catchUp: 'one',
        state: value.enabled ? 'enabled' : 'paused',
      });
      this.store.put('routine_revision', {
        ...routine,
        id: id(),
        routineId: routine.id,
        definitionRevision: routine.revision,
      });
      this.store.event(botId, null, 'routine.created', { id: routine.id, nextAt });
      return routine;
    });
  }
  accept(
    botId,
    conversationId,
    text,
    nonce,
    mode = 'interactive',
    occurrenceId = null,
    artifactRevisionIds = [],
    hostAction = null,
  ) {
    return this.store.tx(() => {
      const scope = `${botId}:${conversationId}`;
      const duplicate = this.store.db
        .prepare('SELECT run FROM nonces WHERE scope=? AND nonce=?')
        .get(scope, nonce);
      if (duplicate) {
        const prior = this.store.get(duplicate.run, 'run');
        if (
          prior.text !== text ||
          prior.mode !== mode ||
          JSON.stringify(prior.artifactRevisionIds ?? []) !== JSON.stringify(artifactRevisionIds) ||
          JSON.stringify(prior.hostAction ?? null) !== JSON.stringify(hostAction)
        )
          fail('nonce_conflict', 'This request nonce was already used for different input', 409);
        return prior;
      }
      const bot = this.store.get(botId, 'bot');
      if (bot.retired) fail('not_authorized', 'Bot is retired', 409);
      if (bot.tokenQuota != null) {
        const reported = this.store
          .list('run', botId)
          .reduce((sum, r) => sum + (r.usage?.totalTokens ?? 0), 0);
        if (reported >= bot.tokenQuota)
          fail(
            'quota_exceeded',
            `This Bot reported ${reported} tokens against its ${bot.tokenQuota} token quota. Raise the quota in Bot settings or start a new Bot.`,
            409,
          );
      }
      if (this.store.get(conversationId, 'conversation').botId !== botId)
        fail('not_authorized', 'Conversation belongs to another Bot', 403);
      let contextBytes = 0;
      for (const key of artifactRevisionIds) {
        const a = this.store.get(key, 'artifact_revision');
        if (a.botId !== botId)
          fail('not_authorized', 'Attached artifact belongs to another Bot', 403);
        const documentKind = DOCUMENT_MEDIA[a.mediaType]?.kind;
        if (!artifactCapabilities(a).attachable)
          fail(
            'unsupported',
            'Only text, JSON and PDF/Office document attachments are supported in conversation context; other original binary files remain downloadable.',
          );
        contextBytes += documentKind ? Math.min(a.size, 60000) : a.size;
      }
      if (contextBytes > 200000)
        fail(
          'capacity',
          'Selected text attachments exceed the 200 KB context limit. Select fewer revisions.',
        );
      const run = this.store.put('run', {
        id: id(),
        botId,
        conversationId,
        text,
        nonce,
        mode,
        occurrenceId,
        artifactRevisionIds,
        ...(hostAction ? { hostAction } : {}),
        state: hostAction?.notBefore > Date.now() ? 'scheduled' : 'queued',
        outcome: null,
        config: bot,
        promptVersion: '0.1',
        acceptedAt: Date.now(),
        partialText: '',
        cancelRequested: false,
      });
      this.store.db.prepare('INSERT INTO nonces VALUES(?,?,?)').run(scope, nonce, run.id);
      this.store.event(botId, run.id, 'request.accepted', {
        conversationId,
        text,
        runId: run.id,
        artifactRevisionIds,
      });
      return run;
    });
  }
  tick(now = Date.now()) {
    for (const r of this.store.list('routine').filter((r) => r.enabled && r.nextAt <= now)) {
      this.store.tx(() => {
        const key = `${r.id}:${r.nextAt}`;
        const exists = this.store.list('occurrence', r.botId).find((o) => o.key === key);
        const active = this.store
          .list('run', r.botId)
          .some(
            (run) =>
              run.occurrenceId &&
              !['settled', 'cancelled', 'failed', 'interrupted'].includes(run.state),
          );
        if (!exists) {
          let conversation = this.store
            .list('conversation', r.botId)
            .find((c) => c.routineId === r.id);
          if (!conversation)
            conversation = this.store.put('conversation', {
              id: id(),
              botId: r.botId,
              name: r.name,
              routineId: r.id,
              sessionFile: null,
            });
          const occurrence = this.store.put('occurrence', {
            id: id(),
            botId: r.botId,
            routineId: r.id,
            routineRevision: r.revision,
            key,
            scheduledFor: r.nextAt,
            state: active ? 'skipped_overlap' : 'accepted',
          });
          if (!active) {
            // Inline admission in the scheduler transaction; never nest SQLite transactions.
            const bot = this.store.get(r.botId, 'bot');
            const run = this.store.put('run', {
              id: id(),
              botId: r.botId,
              conversationId: conversation.id,
              text: r.task,
              nonce: key,
              mode: 'scheduled',
              occurrenceId: occurrence.id,
              state: 'queued',
              outcome: null,
              config: bot,
              promptVersion: '0.1',
              acceptedAt: now,
              partialText: '',
              cancelRequested: false,
            });
            this.store.put('occurrence', { ...occurrence, runId: run.id });
            this.store.event(r.botId, run.id, 'request.accepted', {
              conversationId: conversation.id,
              text: r.task,
              occurrenceId: occurrence.id,
            });
          }
        }
        this.store.put('routine', { ...r, nextAt: nextOccurrence(r.cron, r.timezone, now) });
      });
    }
  }
}
