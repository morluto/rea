import { z } from 'zod';
import { validate } from './product.mjs';
import { id, fail } from './store.mjs';
import { connectionFingerprint, connectionToolName } from './connections.mjs';
export class Actions {
  constructor(store, product, connections) {
    this.store = store;
    this.product = product;
    this.connections = connections;
  }
  create(ownerId, botId, input) {
    const v = validate(
      z
        .object({
          connectionId: z.string().uuid(),
          operation: z.string().min(1).max(100),
          args: z.record(z.string(), z.unknown()),
          nonce: z.string().min(1).max(200),
          notBefore: z.number().int().nonnegative().default(0),
        })
        .strict(),
      input,
    );
    const bot = this.store.get(botId, 'bot'),
      c = this.store.get(v.connectionId, 'connection');
    if (
      bot.ownerId !== ownerId ||
      c.ownerId !== ownerId ||
      !c.botIds.includes(botId) ||
      !c.enabled ||
      !['ready', 'configured'].includes(c.state) ||
      !bot.capabilities.includes('extensions')
    )
      fail(
        'not_authorized',
        'Own the Bot and enable its current connection grant before dispatch',
        403,
      );
    this.connections.validateOperation(c, v.operation, v.args, botId);
    let conversation = this.store.list('conversation', botId).find((c) => c.hostActions);
    if (!conversation)
      conversation = this.store.put('conversation', {
        id: id(),
        botId,
        name: 'Connected actions',
        hostActions: true,
        sessionFile: null,
      });
    return this.product.accept(
      botId,
      conversation.id,
      `${v.operation} · ${c.name}`,
      v.nonce,
      v.notBefore ? 'scheduled' : 'interactive',
      null,
      [],
      {
        connectionId: c.id,
        operation: v.operation,
        args: v.args,
        fingerprint: connectionFingerprint(c),
        toolName: connectionToolName(c.id, v.operation),
        notBefore: v.notBefore,
      },
    );
  }
  tick() {
    for (const r of this.store
      .list('run')
      .filter((r) => r.state === 'scheduled' && r.hostAction?.notBefore <= Date.now())) {
      this.store.put('run', { ...r, state: 'queued' });
      this.store.event(r.botId, r.id, 'action.due', { notBefore: r.hostAction.notBefore });
    }
  }
  async execute(harness, run) {
    const a = run.hostAction,
      c = this.store.get(a.connectionId, 'connection');
    if (connectionFingerprint(c) !== a.fingerprint)
      fail(
        'stale_revision',
        'Scheduled action’s account, policy or schema changed; review it before resubmission',
        409,
      );
    const controller = new AbortController();
    harness.active.set(run.id, { botId: run.botId, controller });
    const deadline = setTimeout(
      () => controller.abort(),
      (run.config.maxDurationSeconds ?? 1800) * 1000,
    );
    try {
      if (harness.cancelled(run.id)) fail('cancelled', 'Action cancelled before dispatch', 409);
      const tool = (await harness.tools(run)).find((t) => t.name === a.toolName);
      if (!tool) fail('not_authorized', 'Named action is no longer available', 403);
      harness.update(run.id, { state: 'running', toolNames: [tool.name] });
      this.store.event(run.botId, run.id, 'run.started', { kind: 'host_action' });
      const result = await tool.execute(id(), a.args, controller.signal);
      const receipt = result.details;
      harness.update(run.id, {
        state: receipt.outcome === 'provider_error' ? 'failed' : 'settled',
        outcome: receipt.outcome,
        result: receipt,
        finishedAt: Date.now(),
        reason:
          receipt.outcome === 'provider_error'
            ? 'The selected provider returned an error. Inspect its action receipt.'
            : null,
      });
      this.store.event(run.botId, run.id, 'run.finished', {
        kind: 'host_action',
        outcome: receipt.outcome,
      });
    } finally {
      clearTimeout(deadline);
    }
  }
}
