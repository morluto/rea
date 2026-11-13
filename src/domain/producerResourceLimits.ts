import { z } from "zod";
import { MAX_NODE_TIMER_DELAY_MS } from "./analysisResourceLimits.js";

/** Per-call owned producer budgets. Each adapter advertises only consumed fields. */
export const producerResourceLimitsSchema = z.strictObject({
  input_bytes: z.int().positive().optional(),
  output_bytes: z.int().positive().optional(),
  diagnostic_bytes: z.int().positive().optional(),
  command_timeout_ms: z.int().min(1).max(MAX_NODE_TIMER_DELAY_MS).optional(),
  address_space_bytes: z.int().positive().optional(),
  file_bytes: z.int().positive().optional(),
  cpu_seconds: z.int().positive().optional(),
});

/** Bound the resident input copy and retained text before allocation/collection. */
export const BOUNDED_PRODUCER_LIMITS = {
  input_bytes: 32 * 1024 * 1024,
  output_bytes: 4 * 1024 * 1024,
  command_timeout_ms: 30_000,
  address_space_bytes: 1024 * 1024 * 1024,
  file_bytes: 64 * 1024 * 1024,
  cpu_seconds: 30,
} as const;

export type ProducerResourceLimits = z.output<
  typeof producerResourceLimitsSchema
>;

/** Explicit per-call fields override defaults; tighter inherited OS limits still win. */
export const resolveProducerLimits = <
  Defaults extends Partial<Record<keyof ProducerResourceLimits, number>>,
>(
  defaults: Defaults,
  selected: ProducerResourceLimits | undefined,
): { readonly [Key in keyof Defaults]: number } =>
  Object.fromEntries(
    Object.entries(defaults).map(([key, value]) => [
      key,
      selected?.[key as keyof ProducerResourceLimits] ?? value,
    ]),
  ) as { readonly [Key in keyof Defaults]: number };

/** Combined-output producers have no separate diagnostic capture control. */
export const boundedProducerLimitsSchema = producerResourceLimitsSchema
  .omit({ diagnostic_bytes: true })
  .optional()
  .describe(
    "Per-call producer limits in bytes, CPU seconds and wall-clock milliseconds. Omitted fields preserve defaults (32 MiB input, 4 MiB combined output, 30000 ms command, 1 GiB address space, 64 MiB per file, 30 CPU seconds); changes apply on the next call without restart. Tighter inherited OS limits remain enforced. These controls do not raise parser, protocol or transport limits.",
  );

/** Accepted collection policy plus effective native ceilings; inherited limits may be zero. */
export const boundedProducerLimitsResultSchema = producerResourceLimitsSchema
  .omit({ diagnostic_bytes: true })
  .required()
  .extend({
    address_space_bytes: z.int().nonnegative(),
    file_bytes: z.int().nonnegative(),
    cpu_seconds: z.int().nonnegative(),
  });
