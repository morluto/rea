import { z } from 'zod';
import { validate } from './product.mjs';
import { fail, id } from './store.mjs';

const value = z.string().max(4000);
const Fields = {
  login: z.object({ origin: z.url(), username: value, password: value.optional() }).strict(),
  contact: z.object({ name: value, email: value, phone: value, address: value }).strict(),
  card: z
    .object({
      holder: value,
      number: z
        .string()
        .regex(/^[\d -]{12,32}$/)
        .optional(),
      expiry: z.string().max(20),
      cvc: z
        .string()
        .regex(/^\d{3,4}$/)
        .optional(),
    })
    .strict(),
};
export class PersonalVault {
  constructor(store, vault) {
    Object.assign(this, { store, vault, computers: null });
  }
  public(row) {
    const { secretRef, ...metadata } = row;
    return metadata;
  }
  owned(ownerId, key) {
    const row = this.store.get(key, 'vault_item');
    if (row.ownerId !== ownerId || row.state !== 'active')
      fail('not_authorized', 'Vault item is not available to this account', 403);
    return row;
  }
  list(ownerId) {
    return this.store
      .list('vault_item')
      .filter((row) => row.ownerId === ownerId && row.state === 'active')
      .map((row) => this.public(row));
  }
  save(ownerId, input, key = null) {
    const value = validate(
      z
        .object({
          kind: z.enum(['login', 'contact', 'card']),
          label: z.string().trim().min(1).max(120),
          fields: z.record(z.string(), z.unknown()).optional(),
          revision: z.number().int().optional(),
        })
        .strict(),
      input,
    );
    const previous = key ? this.owned(ownerId, key) : null;
    if (previous && (previous.kind !== value.kind || previous.revision !== value.revision))
      fail('stale_revision', 'Vault item changed; refresh before saving', 409);
    if (!value.fields && previous) {
      const row = this.store.put('vault_item', { ...previous, label: value.label }, value.revision);
      this.store.event(null, null, 'vault.renamed', { ownerId, itemId: row.id });
      return this.public(row);
    }
    const fields = validate(Fields[value.kind], value.fields);
    if (value.kind === 'login') {
      const origin = new URL(fields.origin);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password)
        fail('invalid_input', 'Login origin must be HTTP(S) without embedded credentials');
      fields.origin = origin.origin;
    }
    const oldFields = previous ? JSON.parse(this.vault.read(previous.secretRef)) : {};
    for (const key of value.kind === 'login'
      ? ['password']
      : value.kind === 'card'
        ? ['number', 'cvc']
        : [])
      if (!fields[key]) fields[key] = oldFields[key];
    if (value.kind === 'login' && !fields.password)
      fail('invalid_input', 'Enter the login password privately');
    if (value.kind === 'card' && !fields.number)
      fail('invalid_input', 'Enter the card number privately');
    return this.store.tx(() => {
      const secretRef = this.vault.save(JSON.stringify(fields), previous?.secretRef);
      const row = this.store.put(
        'vault_item',
        {
          id: key ?? id(),
          ownerId,
          kind: value.kind,
          label: value.label,
          state: 'active',
          secretRef,
          ...(value.kind === 'login' ? { origin: fields.origin } : {}),
          ...(value.kind === 'card' ? { last4: fields.number.replace(/\D/g, '').slice(-4) } : {}),
        },
        previous?.revision,
      );
      this.store.event(null, null, 'vault.saved', { ownerId, itemId: row.id, kind: row.kind });
      return this.public(row);
    });
  }
  reveal(ownerId, key) {
    const row = this.owned(ownerId, key);
    this.store.event(null, null, 'vault.revealed', { ownerId, itemId: row.id });
    return { ...this.public(row), fields: JSON.parse(this.vault.read(row.secretRef)) };
  }
  async resolveFill(ownerId, approvalId, decision, revision) {
    const approval = this.store.get(approvalId, 'approval');
    if (approval.tool !== 'vault_fill')
      fail('invalid_input', 'This approval is not a credential fill', 400);
    const bot = this.store.get(approval.botId, 'bot');
    if (bot.ownerId !== ownerId)
      fail('not_authorized', 'Bot owner required for credential approval', 403);
    if (approval.state !== 'pending' || approval.expiresAt < Date.now())
      fail('stale_revision', 'Approval is no longer pending', 409);
    if (approval.revision !== revision)
      fail('stale_revision', 'Approval changed; refresh before deciding', 409);
    if (decision === 'denied') {
      return this.store.tx(() => {
        const next = this.store.put(
          'approval',
          { ...approval, state: 'denied', decidedBy: ownerId },
          revision,
        );
        const fill = this.store.get(approval.args.fillId, 'vault_fill');
        this.store.put('vault_fill', { ...fill, state: 'denied' });
        this.store.event(bot.id, null, 'vault.fill_denied', { fillId: fill.id });
        return next;
      });
    }
    const next = this.store.put(
      'approval',
      { ...approval, state: 'approved', decidedBy: ownerId },
      revision,
    );
    const fill = this.store.get(approval.args.fillId, 'vault_fill');
    try {
      if (!this.computers) fail('unavailable', 'Computer access is not attached', 503);
      const row = this.owned(ownerId, fill.itemId);
      const fields = JSON.parse(this.vault.read(row.secretRef));
      if (!fields.password) fail('invalid_input', 'Saved login has no password to fill', 400);
      if (fields.username)
        await this.computers.input(fill.botId, { action: 'type', text: fields.username });
      await this.computers.input(fill.botId, { action: 'key', key: 'Tab' });
      await this.computers.input(fill.botId, { action: 'type', text: fields.password });
      this.store.put('vault_fill', { ...fill, state: 'completed' });
      this.store.event(bot.id, null, 'vault.fill_completed', { fillId: fill.id });
      return next;
    } catch (e) {
      this.store.put('vault_fill', {
        ...this.store.get(fill.id, 'vault_fill'),
        state: 'failed',
        error: e?.tag ?? 'computer_unavailable',
      });
      this.store.event(bot.id, null, 'vault.fill_failed', {
        fillId: fill.id,
        error: e?.tag ?? 'computer_unavailable',
      });
      throw e;
    }
  }
  fillRequest(ownerId, key, botId) {
    const row = this.owned(ownerId, key);
    if (row.kind !== 'login')
      fail('invalid_input', 'Only saved logins can fill into a Bot computer', 400);
    const bot = this.store.get(botId, 'bot');
    if (bot.ownerId !== ownerId || bot.retired)
      fail('not_authorized', 'An active Bot owner is required to fill credentials', 403);
    if (!bot.capabilities.includes('computer'))
      fail(
        'invalid_input',
        'Enable the computer capability on this Bot before filling credentials',
        400,
      );
    return this.store.tx(() => {
      const fill = this.store.put('vault_fill', {
        id: id(),
        ownerId,
        itemId: row.id,
        botId,
        label: row.label,
        origin: row.origin,
        state: 'pending',
      });
      const approval = this.store.put('approval', {
        id: id(),
        botId,
        runId: null,
        tool: 'vault_fill',
        args: { fillId: fill.id, label: row.label, origin: row.origin ?? null },
        description: `Type the saved password for "${row.label}" into this Bot’s Linux computer. The secret is never shown to you, the Bot, or the model.`,
        state: 'pending',
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
      this.store.event(botId, null, 'vault.fill_requested', {
        fillId: fill.id,
        approvalId: approval.id,
        itemId: row.id,
      });
      return { fill, approval };
    });
  }
  remove(ownerId, key, input) {
    const value = validate(z.object({ revision: z.number().int() }).strict(), input);
    const row = this.owned(ownerId, key);
    return this.store.tx(() => {
      const removed = this.store.put(
        'vault_item',
        { ...row, state: 'removed', secretRef: null },
        value.revision,
      );
      this.store.db.prepare('DELETE FROM secrets WHERE id=?').run(row.secretRef);
      this.store.event(null, null, 'vault.removed', { ownerId, itemId: row.id });
      return this.public(removed);
    });
  }
}
