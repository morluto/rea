import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { id, fail } from './store.mjs';
import { hash, passwordHash } from './security.mjs';
import { validate } from './product.mjs';
export class Access {
  constructor(store) {
    this.store = store;
  }
  admin(accountId) {
    return this.store.list('account')[0]?.id === accountId;
  }
  bot(accountId, botId, write = false) {
    const bot = this.store.get(botId, 'bot');
    if (bot.ownerId === accountId) return true;
    return this.store
      .list('share', botId)
      .some(
        (s) =>
          s.state === 'active' &&
          (!write || s.role === 'operator') &&
          (s.accountId === accountId ||
            (s.teamId &&
              this.store
                .list('membership')
                .some(
                  (m) => m.teamId === s.teamId && m.accountId === accountId && m.state === 'active',
                ))),
      );
  }
  requireBot(accountId, botId, write = false) {
    if (!this.bot(accountId, botId, write))
      fail('not_authorized', 'This account lacks access to this Bot or operation', 403);
  }
  ownedModel(model, accountId) {
    return (model.ownerId ?? this.store.list('account')[0]?.id) === accountId;
  }
  invite(ownerId) {
    if (!this.admin(ownerId))
      fail('not_authorized', 'Workspace owner is required to invite accounts', 403);
    const token = randomBytes(32).toString('hex');
    const invite = this.store.put('invite', {
      id: id(),
      ownerId,
      tokenHash: hash(token),
      expiresAt: Date.now() + 86400000,
      state: 'pending',
    });
    return { id: invite.id, token, expiresAt: invite.expiresAt };
  }
  join(input) {
    const v = validate(
      z
        .object({
          token: z.string().min(32).max(200),
          name: z.string().min(1).max(120),
          password: z.string().min(12).max(512),
        })
        .strict(),
      input,
    );
    const invite = this.store
      .list('invite')
      .find(
        (i) => i.tokenHash === hash(v.token) && i.state === 'pending' && i.expiresAt > Date.now(),
      );
    if (!invite) fail('not_authorized', 'Invitation expired or already used', 403);
    if (this.store.list('account').some((a) => a.name === v.name))
      fail('conflict', 'Account name already exists', 409);
    return this.store.tx(() => {
      const account = this.store.put('account', {
        id: id(),
        name: v.name,
        password: passwordHash(v.password),
      });
      this.store.put('invite', { ...invite, state: 'used', accountId: account.id });
      return { id: account.id, name: account.name };
    });
  }
  share(ownerId, botId, input) {
    const bot = this.store.get(botId, 'bot');
    if (bot.ownerId !== ownerId) fail('not_authorized', 'Only the Bot owner may share it', 403);
    const v = validate(
      z
        .object({
          accountId: z.string().uuid().optional(),
          teamId: z.string().uuid().optional(),
          role: z.enum(['viewer', 'operator']),
          state: z.enum(['active', 'revoked']).default('active'),
        })
        .strict()
        .refine((v) => !!v.accountId !== !!v.teamId, 'Select one account or team'),
      input,
    );
    if (v.accountId) this.store.get(v.accountId, 'account');
    if (v.teamId && this.store.get(v.teamId, 'team').ownerId !== ownerId)
      fail('not_authorized', 'Team owner required', 403);
    const prior = this.store
      .list('share', botId)
      .find((s) => s.accountId === v.accountId && s.teamId === v.teamId);
    const row = this.store.put('share', { id: prior?.id ?? id(), botId, ownerId, ...v });
    this.store.event(botId, null, 'access.changed', {
      shareId: row.id,
      state: row.state,
      role: row.role,
    });
    return row;
  }
  team(ownerId, input) {
    const v = validate(
      z
        .object({
          name: z.string().min(1).max(120),
          accountIds: z.array(z.string().uuid()).max(100),
        })
        .strict(),
      input,
    );
    for (const key of v.accountIds) this.store.get(key, 'account');
    return this.store.tx(() => {
      const team = this.store.put('team', { id: id(), ownerId, name: v.name });
      for (const accountId of new Set([ownerId, ...v.accountIds]))
        this.store.put('membership', {
          id: id(),
          teamId: team.id,
          accountId,
          state: 'active',
          role: accountId === ownerId ? 'owner' : 'member',
        });
      return team;
    });
  }
  room(ownerId, input) {
    const v = validate(
      z
        .object({
          name: z.string().min(1).max(120),
          botId: z.string().uuid(),
          teamId: z.string().uuid().optional(),
        })
        .strict(),
      input,
    );
    this.requireBot(ownerId, v.botId, true);
    if (v.teamId && this.store.get(v.teamId, 'team').ownerId !== ownerId)
      fail('not_authorized', 'Team owner required', 403);
    return this.store.put('room', { id: id(), ownerId, ...v });
  }
  canRoom(accountId, room) {
    return (
      this.bot(accountId, room.botId) &&
      (!room.teamId ||
        room.ownerId === accountId ||
        this.store
          .list('membership')
          .some(
            (m) => m.teamId === room.teamId && m.accountId === accountId && m.state === 'active',
          ))
    );
  }
}
