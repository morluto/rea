import type { z } from "zod";
import {
  producerResourceLimitsSchema,
  resolveProducerLimits,
} from "../producerResourceLimits.js";

/** Defaults for complete offline Rust input and report admission. */
export const RUST_PRODUCER_DEFAULTS = {
  input_bytes: 256 * 1024 * 1024,
  output_bytes: 8 * 1024 * 1024,
} as const;
export const rustProducerLimitsSchema = producerResourceLimitsSchema.pick({
  input_bytes: true,
  output_bytes: true,
});
export const rustProducerLimitsField = rustProducerLimitsSchema
  .optional()
  .describe(
    "Per-call input_bytes and output_bytes admission for the same complete Rust artifact/report, default 268435456 and 8388608 bytes. Positive safe integers; applies on the next call without restart. Compressed dependency section 1 MiB, inflated JSON 8 MiB/64x, parser nesting and transport limits remain independent.",
  );
export type RustProducerLimitsInput = z.output<typeof rustProducerLimitsSchema>;
export const resolveRustProducerLimits = (selected?: RustProducerLimitsInput) =>
  resolveProducerLimits(RUST_PRODUCER_DEFAULTS, selected);
export type RustProducerLimits = ReturnType<typeof resolveRustProducerLimits>;
