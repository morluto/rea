import type { ParameterBudget } from "../parameterBudget.js";

/**
 * Single owner of `inspect_apk_signature` admission and decoded-record budgets.
 * Keeps zero runtime dependencies so domain parsers and schemas share the same
 * defaults without coupling binary parsers to schema validation.
 */
export const APK_SIGNATURE_BUDGETS = {
  max_file_bytes: {
    minimum: 22,
    maximum: 2 * 1024 * 1024 * 1024,
    default_value: 512 * 1024 * 1024,
    unit: "bytes",
  },
  max_output_bytes: {
    minimum: 1024,
    maximum: 64 * 1024 * 1024,
    default_value: 8 * 1024 * 1024,
    unit: "bytes",
  },
  max_signing_block_pairs: {
    minimum: 1,
    maximum: 65536,
    default_value: 4096,
    unit: "count",
  },
  max_signers: {
    minimum: 1,
    maximum: 1024,
    default_value: 32,
    unit: "count",
  },
  max_lineage_nodes: {
    minimum: 1,
    maximum: 1024,
    default_value: 32,
    unit: "count",
  },
  max_signer_elements: {
    minimum: 1,
    maximum: 65536,
    default_value: 4096,
    unit: "count",
  },
  max_v1_signature_entries: {
    minimum: 1,
    maximum: 65536,
    default_value: 4096,
    unit: "count",
  },
} as const satisfies Record<string, ParameterBudget>;

export type ApkSignatureBudget = keyof typeof APK_SIGNATURE_BUDGETS;
