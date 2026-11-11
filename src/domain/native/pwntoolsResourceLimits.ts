import {
  BOUNDED_PRODUCER_LIMITS,
  producerResourceLimitsSchema,
  resolveProducerLimits,
} from "../producerResourceLimits.js";
import type { z } from "zod";
import { DEFAULT_PWNTOOLS_TIMEOUT_MS } from "./nativeDeadlines.js";

/** Owned Python defaults; the bridge consumes these accepted values from its request. */
export const PWNTOOLS_LIMITS = {
  input_bytes: BOUNDED_PRODUCER_LIMITS.input_bytes,
  output_bytes: 64 * 1024 * 1024,
  diagnostic_bytes: 1024 * 1024,
  command_timeout_ms: DEFAULT_PWNTOOLS_TIMEOUT_MS,
  address_space_bytes: 3 * 1024 * 1024 * 1024,
  cpu_seconds: 30,
} as const;

export const pwntoolsProducerLimitsSchema = producerResourceLimitsSchema.omit({
  command_timeout_ms: true,
});
export type PwntoolsProducerLimitsInput = z.output<
  typeof pwntoolsProducerLimitsSchema
>;

export const resolvePwntoolsLimits = (
  selected?: PwntoolsProducerLimitsInput,
  inputBytes: number = PWNTOOLS_LIMITS.input_bytes,
) =>
  resolveProducerLimits(
    {
      ...PWNTOOLS_LIMITS,
      input_bytes: inputBytes,
      file_bytes: selected?.output_bytes ?? PWNTOOLS_LIMITS.output_bytes,
    },
    selected,
  );
export type PwntoolsProducerLimits = ReturnType<typeof resolvePwntoolsLimits>;
export const pwntoolsProducerLimitsField = pwntoolsProducerLimitsSchema
  .optional()
  .describe(
    `Per-call owned Python input, output, diagnostic, address-space and file bytes, and CPU seconds. Defaults: input ${PWNTOOLS_LIMITS.input_bytes}, output ${PWNTOOLS_LIMITS.output_bytes}, diagnostics ${PWNTOOLS_LIMITS.diagnostic_bytes}, address space ${PWNTOOLS_LIMITS.address_space_bytes} bytes, CPU ${PWNTOOLS_LIMITS.cpu_seconds} seconds. File allowance follows selected output_bytes unless file_bytes is explicit. input_bytes overrides REA_PWNTOOLS_MAX_INPUT_BYTES. Positive safe integers; applies on the next call without restart. Tighter inherited OS limits are retained. pwntools_timeout_ms remains the independent wall deadline.`,
  );
