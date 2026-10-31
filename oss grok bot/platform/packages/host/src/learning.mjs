import { z } from 'zod';
import { validate } from './product.mjs';
import { fail, id } from './store.mjs';

const Recipe = z
  .object({
    title: z.string().trim().min(1).max(120),
    whenToUse: z.string().trim().min(1).max(2000),
    instructions: z.string().trim().min(1).max(16000),
    enabled: z.boolean().default(true),
    exampleRunId: z.string().uuid().nullable().default(null),
    revision: z.number().int().optional(),
  })
  .strict();
export class Learning {
  constructor(store, product) {
    Object.assign(this, { store, product });
  }
  owned(ownerId, botId) {
    const bot = this.store.get(botId, 'bot');
    if (bot.ownerId !== ownerId || bot.retired)
      fail('not_authorized', 'An active Bot owner is required to teach tasks', 403);
  }
  list(botId) {
    return this.store.list('task_recipe', botId);
  }
  save(ownerId, botId, input, key = null) {
    this.owned(ownerId, botId);
    const value = validate(Recipe, input);
    const previous = key ? this.store.get(key, 'task_recipe') : null;
    if (previous && previous.botId !== botId)
      fail('not_authorized', 'Recipe belongs to another Bot', 403);
    if (previous && previous.revision !== value.revision)
      fail('stale_revision', 'Refresh the task before editing', 409);
    let example = null;
    if (value.exampleRunId) {
      const run = this.store.get(value.exampleRunId, 'run');
      if (run.botId !== botId || run.state !== 'settled')
        fail('invalid_input', 'Select a completed task owned by this Bot');
      example = {
        runId: run.id,
        milestones: (run.milestones ?? []).map((entry) => entry.text).slice(-8),
      };
    }
    return this.store.tx(() => {
      if (previous)
        this.store.put('task_recipe_revision', { ...previous, id: id(), recipeId: previous.id });
      const recipe = this.store.put(
        'task_recipe',
        { id: key ?? id(), botId, ownerId, ...value, example },
        previous?.revision,
      );
      this.store.event(botId, null, 'learning.saved', {
        recipeId: recipe.id,
        revision: recipe.revision,
      });
      return recipe;
    });
  }
  remove(ownerId, botId, key, input) {
    const previous = this.store.get(key, 'task_recipe');
    return this.save(
      ownerId,
      botId,
      {
        title: previous.title,
        whenToUse: previous.whenToUse,
        instructions: previous.instructions,
        exampleRunId: previous.exampleRunId,
        enabled: false,
        revision: validate(z.object({ revision: z.number().int() }).strict(), input).revision,
      },
      key,
    );
  }
  run(botId, key, input) {
    const value = validate(
      z
        .object({
          conversationId: z.string().uuid(),
          nonce: z.string().uuid(),
          revision: z.number().int(),
          input: z.string().max(8000).default(''),
        })
        .strict(),
      input,
    );
    const recipe = this.store.get(key, 'task_recipe');
    if (recipe.botId !== botId || !recipe.enabled)
      fail('not_authorized', 'Taught task is unavailable for this Bot', 403);
    if (recipe.revision !== value.revision)
      fail('stale_revision', 'The taught task changed; review it before running', 409);
    return this.product.accept(
      botId,
      value.conversationId,
      'Run taught task: ' +
        recipe.title +
        ' (revision ' +
        recipe.revision +
        ')\nWhen to use: ' +
        recipe.whenToUse +
        '\nInstructions:\n' +
        recipe.instructions +
        '\nUser input:\n' +
        value.input +
        '\nExisting permissions and approvals still apply. Do not infer that a demonstrated effect occurred in this run.',
      value.nonce,
    );
  }
  publishTemplate(ownerId, botId, input) {
    this.owned(ownerId, botId);
    const value = validate(
      z
        .object({
          version: z.string().trim().min(1).max(32).default('1.0.0'),
          notes: z.string().trim().max(2000).default(''),
        })
        .strict(),
      input,
    );
    const bot = this.store.get(botId, 'bot');
    const listing = this.store.put('template_listing', {
      id: id(),
      ownerId,
      sourceBotId: bot.id,
      sourceRevision: bot.revision,
      name: bot.name,
      purpose: bot.purpose,
      role: bot.role,
      color: bot.color,
      capabilities: bot.capabilities,
      maxTurns: bot.maxTurns,
      maxDurationSeconds: bot.maxDurationSeconds,
      tokenBudget: bot.tokenBudget,
      version: value.version,
      notes: value.notes,
      installs: 0,
    });
    this.store.event(botId, null, 'template.published', {
      listingId: listing.id,
      version: listing.version,
    });
    return listing;
  }
  listTemplates(ownerId) {
    return this.store.list('template_listing').filter((t) => t.ownerId === ownerId);
  }
  installTemplate(ownerId, listingId, input) {
    const listing = this.store.get(listingId, 'template_listing');
    if (listing.ownerId !== ownerId)
      fail('not_authorized', 'Template belongs to another workspace', 403);
    const value = validate(z.object({ name: z.string().trim().min(1).max(120) }).strict(), input);
    return {
      name: value.name,
      purpose: listing.purpose,
      role: listing.role,
      color: listing.color,
      capabilities: listing.capabilities,
      maxTurns: listing.maxTurns,
      maxDurationSeconds: listing.maxDurationSeconds,
      tokenBudget: listing.tokenBudget,
      tokenQuota: null,
      modelId: null,
    };
  }
}
