import { Type } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { id, fail } from './store.mjs';
import { validate } from './product.mjs';
const settled = (r) => ['settled', 'failed', 'cancelled', 'interrupted'].includes(r.state);
export class Workflows {
  constructor(store, product) {
    this.store = store;
    this.product = product;
    this.harness = null;
  }
  wait(run, args, callId) {
    const value = validate(
      z
        .object({
          question: z.string().min(1).max(4000),
          choices: z.array(z.string().min(1).max(200)).max(12).default([]),
        })
        .strict(),
      args,
    );
    const wait = this.store.put('input_wait', {
      id: id(),
      botId: run.botId,
      runId: run.id,
      conversationId: run.conversationId,
      callId,
      ...value,
      state: 'pending',
    });
    this.harness.update(run.id, { state: 'waiting_input' });
    this.needsYou(run.botId, {
      kind: 'input',
      runId: run.id,
      title: 'A Bot needs an answer',
      message: value.question,
    });
    this.store.event(run.botId, run.id, 'input.required', {
      id: wait.id,
      question: value.question,
      choices: value.choices,
    });
    return wait;
  }
  async ask(run, args, callId, signal) {
    const wait = this.wait(run, args, callId);
    while (true) {
      if (signal?.aborted || this.harness.cancelled(run.id))
        fail('cancelled', 'Input wait cancelled', 409);
      const current = this.store.get(wait.id, 'input_wait');
      if (current.state === 'answered') {
        this.harness.update(run.id, { state: 'running' });
        return { waitId: wait.id, answer: current.answer, source: 'authenticated_user' };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  answer(waitId, answer, revision, actorId) {
    const wait = this.store.get(waitId, 'input_wait');
    if (wait.state !== 'pending') fail('stale_revision', 'This question is no longer pending', 409);
    const run = this.store.get(wait.runId, 'run');
    if (settled(run)) fail('not_running', 'The task has ended', 409);
    const next = this.store.put(
      'input_wait',
      { ...wait, state: 'answered', answer, actorId },
      revision,
    );
    this.store.event(wait.botId, run.id, 'input.answered', { id: wait.id, answer, actorId });
    // After a restart, settle the recorded tool call through Pi's canonical owner,
    // then continue the same run. Earlier tools/effects are never replayed.
    if (!this.harness.active.has(run.id)) {
      const c = this.store.get(wait.conversationId, 'conversation');
      if (!c.sessionFile || !existsSync(c.sessionFile))
        fail('history_unavailable', 'Canonical history must be reconciled before resuming', 409);
      const manager = SessionManager.open(c.sessionFile);
      manager.appendMessage({
        role: 'toolResult',
        toolCallId: wait.callId,
        toolName: 'ask_user',
        content: [{ type: 'text', text: JSON.stringify({ answer, waitId }) }],
        details: { waitId, actorId },
        isError: false,
        timestamp: Date.now(),
      });
      this.harness.update(run.id, {
        state: 'queued',
        resumeText:
          'Continue the existing task after the authenticated answer recorded in the last tool result. Preserve all prior tool receipts; do not repeat completed actions.',
        cancelRequested: false,
      });
    }
    return next;
  }
  createChild(run, args) {
    const input = validate(
      z
        .object({
          targetBotId: z.string().uuid(),
          objective: z.string().min(1).max(16000),
          allowedCapabilities: z
            .array(z.enum(['memory', 'library', 'routines', 'computer', 'extensions', 'knowledge']))
            .default(['memory', 'library']),
          maxTurns: z.number().int().min(1).max(30).default(10),
        })
        .strict(),
      args,
    );
    if (run.childTaskId) fail('not_authorized', 'This bounded worker cannot delegate again', 403);
    if (input.targetBotId === run.botId)
      fail('invalid_input', 'Choose a different Bot; the current Bot already owns this task');
    const target = this.store.get(input.targetBotId, 'bot'),
      parent = this.store.get(run.botId, 'bot');
    if (target.ownerId !== parent.ownerId || target.retired)
      fail('not_authorized', 'Delegation target must be an active Bot owned by this account', 403);
    return this.store.tx(() => {
      const child = this.store.put('child_task', {
        id: id(),
        botId: run.botId,
        parentRunId: run.id,
        targetBotId: target.id,
        objective: input.objective,
        allowedCapabilities: input.allowedCapabilities,
        maxTurns: input.maxTurns,
        state: 'queued',
      });
      const c = this.store.put('conversation', {
        id: id(),
        botId: target.id,
        name: `Delegated: ${input.objective.slice(0, 60)}`,
        sessionFile: null,
        childTaskId: child.id,
      });
      const config = {
        ...target,
        capabilities: target.capabilities.filter((cap) => input.allowedCapabilities.includes(cap)),
        maxTurns: Math.min(input.maxTurns, target.maxTurns),
      };
      const childRun = this.store.put('run', {
        id: id(),
        botId: target.id,
        conversationId: c.id,
        text: input.objective,
        nonce: child.id,
        mode: 'delegated',
        childTaskId: child.id,
        parentRunId: run.id,
        state: 'queued',
        outcome: null,
        config,
        promptVersion: '0.1',
        acceptedAt: Date.now(),
        partialText: '',
        cancelRequested: false,
      });
      this.store.put('child_task', { ...child, runId: childRun.id });
      this.store.event(target.id, childRun.id, 'request.accepted', {
        conversationId: c.id,
        text: input.objective,
        parentRunId: run.id,
      });
      this.store.event(run.botId, run.id, 'child.created', {
        id: child.id,
        runId: childRun.id,
        targetBotId: target.id,
      });
      return this.store.get(child.id, 'child_task');
    });
  }
  async delegate(run, args, signal) {
    const child = this.createChild(run, args);
    this.harness.update(run.id, { state: 'waiting_child' });
    while (true) {
      if (signal?.aborted || this.harness.cancelled(run.id)) {
        await this.harness.cancel(child.runId);
        fail('cancelled', 'Delegation cancelled', 409);
      }
      const r = this.store.get(child.runId, 'run');
      if (settled(r)) {
        this.harness.update(run.id, { state: 'running' });
        const history = this.harness.history(this.store.get(r.conversationId, 'conversation'));
        const result =
          history
            .filter((m) => m.role === 'assistant')
            .flatMap((m) =>
              typeof m.content === 'string'
                ? [m.content]
                : m.content.filter((c) => c.type === 'text').map((c) => c.text),
            )
            .at(-1) ?? '';
        return {
          childTaskId: child.id,
          runId: r.id,
          targetBotId: r.botId,
          outcome: r.outcome,
          reportedResult: result.slice(0, 16000),
          verification: 'child report; inspect linked receipts for effects',
          artifactRevisions: this.store
            .list('artifact_revision', r.botId)
            .filter((a) => a.sourceRun === r.id)
            .map((a) => ({ id: a.id, name: a.name, digest: a.digest })),
        };
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  finish(run) {
    if (run.childTaskId) {
      const child = this.store.get(run.childTaskId, 'child_task');
      this.store.put('child_task', {
        ...child,
        state: run.state,
        outcome: run.outcome,
        finishedAt: Date.now(),
      });
      const parent = this.store.get(child.parentRunId, 'run');
      if (parent.config.capabilities.includes('library') && !settled(parent))
        for (const revision of this.store
          .list('artifact_revision', run.botId)
          .filter((a) => a.sourceRun === run.id)) {
          if (
            !this.store
              .list('artifact_handoff', parent.botId)
              .some((h) => h.runId === parent.id && h.revisionId === revision.id)
          )
            this.store.put('artifact_handoff', {
              id: id(),
              botId: parent.botId,
              runId: parent.id,
              childTaskId: child.id,
              sourceBotId: run.botId,
              sourceRunId: run.id,
              revisionId: revision.id,
              digest: revision.digest,
              scope: 'exact_revision_for_parent_run',
            });
        }
    }
    if (this.store.list('notification', run.botId).some((n) => n.runId === run.id)) return;
    if (run.mode === 'scheduled' && run.routineResult === 'no_change' && run.state === 'settled')
      return;
    const owner = this.store.get(run.botId, 'bot').ownerId;
    this.store.put('notification', {
      id: id(),
      botId: run.botId,
      ownerId: owner,
      runId: run.id,
      kind: run.state === 'settled' ? 'result' : 'attention',
      title: run.text.slice(0, 120),
      message: run.reason ?? `${run.state}: ${run.outcome}`,
      read: false,
    });
  }
  needsYou(botId, { kind, title, message, runId }) {
    if (
      this.store
        .list('notification', botId)
        .some((notice) => notice.runId === runId && notice.kind === kind && !notice.read)
    )
      return;
    const ownerId = this.store.get(botId, 'bot').ownerId;
    this.store.put('notification', {
      id: id(),
      botId,
      ownerId,
      runId,
      kind,
      title: title.slice(0, 120),
      message: message.slice(0, 1000),
      read: false,
    });
    void this.push
      ?.deliver(ownerId, { title: title.slice(0, 120), body: message.slice(0, 200), url: '/' })
      .catch(() => {});
  }
  tools(run, tool) {
    return [
      tool(
        'ask_user',
        'chat',
        'Ask a question or choice and durably wait for the authenticated user. The same task resumes after the answer.',
        Type.Object({ question: Type.String(), choices: Type.Optional(Type.Array(Type.String())) }),
        (a, s, c) => this.ask(run, a, c, s),
      ),
      tool(
        'delegate_task',
        'delegation',
        'Delegate one bounded objective to another active Bot owned by the same user. No private parent history is copied. One delegation depth only; requires approval.',
        Type.Object({
          targetBotId: Type.String(),
          objective: Type.String(),
          allowedCapabilities: Type.Optional(Type.Array(Type.String())),
          maxTurns: Type.Optional(Type.Number()),
        }),
        (a, s) => this.delegate(run, a, s),
        true,
      ),
      tool(
        'bot_inventory',
        'delegation',
        'List available delegation targets without private history.',
        Type.Object({}),
        () =>
          this.store
            .list('bot')
            .filter((b) => b.ownerId === run.config.ownerId && !b.retired && b.id !== run.botId)
            .map((b) => ({ id: b.id, name: b.name, purpose: b.purpose })),
      ),
      tool(
        'routine_outcome',
        'routines',
        'Record a structured scheduled result. no_change suppresses quiet-success notifications without parsing prose.',
        Type.Object({
          outcome: Type.Union([
            Type.Literal('changed'),
            Type.Literal('no_change'),
            Type.Literal('blocked'),
          ]),
          summary: Type.String(),
        }),
        (a) => {
          if (run.mode !== 'scheduled')
            fail('invalid_input', 'Only scheduled runs have routine outcomes');
          this.harness.update(run.id, { routineResult: a.outcome, routineSummary: a.summary });
          return { recorded: true, ...a };
        },
      ),
    ];
  }
  overview(botId) {
    return {
      waits: this.store.list('input_wait', botId),
      children: this.store.list('child_task', botId),
      notifications: this.store.list('notification', botId),
    };
  }
  activity(botId) {
    const runs = this.store.list('run', botId),
      waiting = runs.find((r) => ['waiting_approval', 'waiting_input'].includes(r.state)),
      working = runs.find((r) =>
        ['preparing', 'running', 'waiting_child', 'cancelling'].includes(r.state),
      ),
      queued = runs.filter((r) => r.state === 'queued');
    if (waiting)
      return {
        state: 'waiting',
        label: waiting.state === 'waiting_approval' ? 'Needs your approval' : 'Has a question',
        runId: waiting.id,
      };
    if (working)
      return {
        state: 'working',
        motion:
          working.state === 'preparing'
            ? 'thinking'
            : working.activeTools?.length
              ? working.activeTools.some((tool) => tool.name === 'library_publish')
                ? 'writing'
                : 'reading'
              : working.partialOpen && working.partialText
                ? 'writing'
                : 'thinking',
        label:
          working.state === 'cancelling'
            ? 'Stopping safely'
            : working.state === 'waiting_child'
              ? 'Working with a Bot'
              : working.activeTools?.length
                ? 'Using tools'
                : working.partialOpen && working.partialText
                  ? 'Writing response'
                  : 'Working',
        runId: working.id,
      };
    if (queued.length)
      return {
        state: 'queued',
        label: `${queued.length} ${queued.length === 1 ? 'task' : 'tasks'} queued`,
        runId: queued[0].id,
      };
    const last = runs
      .filter((run) => run.finishedAt)
      .sort((left, right) => right.finishedAt - left.finishedAt)[0];
    if (last && Date.now() - last.finishedAt < 8000)
      return {
        state: 'idle',
        motion: last.state === 'settled' ? 'celebrating' : 'attention',
        label:
          last.state === 'settled'
            ? 'Finished'
            : last.state === 'cancelled'
              ? 'Stopped'
              : 'Needs attention',
      };
    return { state: 'idle', motion: 'looking', label: 'Idle' };
  }
  analytics(ownerId, days = 30) {
    const bots = new Set(
        this.store
          .list('bot')
          .filter((b) => b.ownerId === ownerId)
          .map((b) => b.id),
      ),
      after = Date.now() - days * 86400000;
    const runs = this.store.list('run').filter((r) => bots.has(r.botId) && r.acceptedAt >= after);
    return {
      days,
      periodStart: after,
      runs: runs.length,
      completed: runs.filter((r) => r.state === 'settled').length,
      failed: runs.filter((r) => r.state === 'failed').length,
      cancelled: runs.filter((r) => r.state === 'cancelled').length,
      activeDays: new Set(runs.map((r) => new Date(r.acceptedAt).toISOString().slice(0, 10))).size,
      reportedTokens: runs.reduce((sum, r) => sum + (r.usage?.totalTokens ?? 0), 0),
      runsWithReportedUsage: runs.filter((r) => r.usage).length,
      estimatedCostUsd: Math.round(runs.reduce((sum, r) => sum + (r.cost?.usd ?? 0), 0) * 100) / 100,
      runsWithCostBasis: runs.filter((r) => r.cost?.basis === 'user_rates').length,
      minutesSaved: null,
    };
  }
}
