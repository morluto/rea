import { z } from 'zod';
import { accentValues, languageValues, microphoneValues } from './preference-values.mjs';
const text = z.string().trim().min(1).max(32000);
export const BotInput = z
  .object({
    name: text.max(120),
    purpose: text.max(2000),
    role: text,
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default('#adbbff'),
    shape: z
      .enum(['circle', 'squircle', 'star', 'hex', 'square', 'blob', 'diamond', 'drop'])
      .nullable()
      .default(null),
    modelId: z.string().nullable().default(null),
    capabilities: z
      .array(
        z.enum([
          'memory',
          'library',
          'routines',
          'computer',
          'delegation',
          'extensions',
          'knowledge',
          'devices',
          'coding',
        ]),
      )
      .default(['memory', 'library', 'routines']),
    maxTurns: z.number().int().min(1).max(100).default(20),
    maxDurationSeconds: z.number().int().min(10).max(86400).default(1800),
    tokenBudget: z.number().int().min(100).max(10000000).default(200000),
    tokenQuota: z.number().int().min(1000).max(1000000000).nullable().default(null),
  })
  .strict();
export const ModelInput = z
  .object({
    name: text.max(120),
    endpoint: z
      .url()
      .refine(
        (v) =>
          ['http:', 'https:'].includes(new URL(v).protocol) &&
          !new URL(v).username &&
          !new URL(v).password,
        'Use an HTTP(S) URL without embedded credentials',
      ),
    model: text.max(256),
    api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']),
    apiKey: z.string().max(4096).optional(),
    contextWindow: z.number().int().positive().default(128000),
    maxTokens: z.number().int().positive().default(4096),
    vision: z.boolean().default(false),
    reasoning: z.boolean().default(false),
    costInputPerM: z.number().min(0).max(100000).nullable().default(null),
    costOutputPerM: z.number().min(0).max(100000).nullable().default(null),
  })
  .strict();
export const TaskInput = z
  .object({
    text,
    nonce: z.string().uuid(),
    conversationId: z.string().uuid(),
    artifactRevisionIds: z.array(z.string().uuid()).max(16).default([]),
  })
  .strict();
export const MemoryInput = z
  .object({
    subject: text.max(256),
    content: text,
    scope: z.enum(['bot', 'conversation']),
    conversationId: z.string().uuid().optional(),
    source: text.max(1000),
    certainty: z.enum(['user_confirmed', 'observed', 'inferred']).default('user_confirmed'),
  })
  .strict()
  .refine(
    (v) => v.scope !== 'conversation' || !!v.conversationId,
    'Conversation scope requires a conversation',
  );
export const RoutineInput = z
  .object({
    name: text.max(120),
    task: text,
    cron: text.max(120),
    timezone: text.max(100),
    enabled: z.boolean().default(true),
  })
  .strict();
export const ArtifactInput = z
  .object({
    name: text.max(256),
    mediaType: text.max(128),
    content: z.string().max(8 * 1024 * 1024),
    encoding: z.enum(['utf8', 'base64']).default('utf8'),
    artifactId: z.string().uuid().optional(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict();
export const ArtifactMetadataInput = z
  .object({ pinned: z.boolean(), revision: z.number().int().positive() })
  .strict();
const allowed = (values) => (value) => values.includes(value);
export const SettingsInput = z
  .object({
    theme: z.enum(['system', 'dark', 'light']),
    showAdvanced: z.boolean().optional(),
    spellcheck: z.boolean().optional(),
    accent: z.string().refine(allowed(accentValues), 'Unsupported accent').optional(),
    language: z.string().refine(allowed(languageValues), 'Unsupported language').optional(),
    microphone: z.string().refine(allowed(microphoneValues), 'Unsupported microphone').optional(),
    hardwareAcceleration: z.boolean().optional(),
    timezoneAuto: z.boolean().optional(),
    feedbackUrl: z
      .string()
      .max(2048)
      .refine((value) => {
        if (value === '') return true;
        try {
          const url = new URL(value);
          return url.protocol === 'https:' && !url.username && !url.password;
        } catch {
          return false;
        }
      }, 'Use a public HTTPS feedback page without embedded credentials.')
      .optional(),
    timezone: z.string().refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }),
  })
  .strict();
export function parse(schema, value) {
  const result = schema.safeParse(value);
  return result.success
    ? { ok: true, value: result.data }
    : {
        ok: false,
        error: {
          tag: 'invalid_input',
          message: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      };
}
