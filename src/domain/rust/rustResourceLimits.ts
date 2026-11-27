import type { z } from "zod";
import {
  producerResourceLimitsSchema,
  resolveProducerLimits,
} from "../producerResourceLimits.js";

/** Defaults for complete offline Rust input and report admission. */
export const RUST_PRODUCER_DEFAULTS = {
  input_bytes: 2 * 1024 * 1024 * 1024,
  output_bytes: 8 * 1024 * 1024,
} as const;
export const rustProducerLimitsSchema = producerResourceLimitsSchema.pick({
  input_bytes: true,
  output_bytes: true,
});
export const rustProducerLimitsField = rustProducerLimitsSchema
  .optional()
  .describe(
    `Per-call input_bytes and output_bytes admission for the same complete Rust artifact/report, default ${String(RUST_PRODUCER_DEFAULTS.input_bytes)} and ${String(RUST_PRODUCER_DEFAULTS.output_bytes)} bytes. Positive safe integers; applies on the next call without restart. max_compressed_dependency_bytes, max_inflated_dependency_bytes, max_dependency_inflate_ratio, parser nesting and transport limits remain independent.`,
  );
export type RustProducerLimitsInput = z.output<typeof rustProducerLimitsSchema>;
export const resolveRustProducerLimits = (selected?: RustProducerLimitsInput) =>
  resolveProducerLimits(RUST_PRODUCER_DEFAULTS, selected);
export type RustProducerLimits = ReturnType<typeof resolveRustProducerLimits>;
