import { z } from "zod";
import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import type { JsonValue } from "../jsonValue.js";
import { knownCoverageStatusSchema } from "../coverage.js";
import { MAX_NODE_TIMER_DELAY_MS } from "../analysisResourceLimits.js";

const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Default analysis budget for one xpanda operation, including bridge startup. */
export const DEFAULT_HARMONY_ABC_ANALYSIS_TIMEOUT_MS = 120_000;
/** Largest delay supported without overflowing Node timers. */
export const MAX_HARMONY_ABC_TIMEOUT_MS = MAX_NODE_TIMER_DELAY_MS;
const timeout = z.number().int().min(1).max(MAX_HARMONY_ABC_TIMEOUT_MS);
const className = z
  .string()
  .min(1)
  .max(1024)
  .describe(
    'HarmonyOS class name, mangled "Lpkg/Name;" or demangled "pkg/Name"',
  );
const target = {
  path: absoluteLocalPathStringSchema.describe(
    "Absolute local HarmonyOS Ark bytecode (.abc) file; parsed, never executed. Relative paths are rejected.",
  ),
  analysis_timeout_ms: timeout
    .optional()
    .describe(
      "Analysis wall-clock budget in milliseconds (default 120000), from bridge startup through the producer call; excludes queue admission. Whole-file decompilation of large applications can exceed the default.",
    ),
};

/** Explicit HarmonyOS Ark bytecode analysis intent, independent of engines. */
export const harmonyAbcInputSchemas = {
  inspect_harmony_abc: z.strictObject(target),
  list_harmony_abc_classes: z.strictObject({
    ...target,
    filter: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("Case-insensitive substring filter on demangled class names"),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "Index into the filtered class list; combine with limit to page",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe("Maximum classes per page"),
  }),
  decompile_harmony_abc_class: z.strictObject({
    ...target,
    class_name: className,
    simplify: z
      .boolean()
      .default(true)
      .describe(
        "Run the producer optimizer pipeline; false returns raw linear output and ignores nothing else",
      ),
  }),
  decompile_harmony_abc: z.strictObject({
    ...target,
    output_directory: absoluteLocalPathStringSchema.describe(
      "Absolute, absent output directory; the producer creates it and writes one JavaScript file per class",
    ),
    simplify: z
      .boolean()
      .default(true)
      .describe("Run the producer optimizer pipeline"),
  }),
  disassemble_harmony_abc_method: z.strictObject({
    ...target,
    class_name: className,
    method_name: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe('Method name; omit for the class entry "func_main_0"'),
    max_instructions: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .default(1500)
      .describe("Maximum rendered instructions; the result reports truncation"),
  }),
  search_harmony_abc_strings: z.strictObject({
    ...target,
    pattern: z
      .string()
      .min(1)
      .max(1024)
      .describe(
        "Substring to find, or a regular expression when regex is true",
      ),
    regex: z
      .boolean()
      .default(false)
      .describe("Interpret pattern as a regular expression"),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Index into the matches; combine with limit to page"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum matches per page"),
  }),
} as const;

/** Supported HarmonyOS Ark bytecode operations. */
export type HarmonyAbcOperation = keyof typeof harmonyAbcInputSchemas;
/** Correlated, validated HarmonyOS Ark bytecode request. */
export type HarmonyAbcRequest = {
  [Name in HarmonyAbcOperation]: {
    operation: Name;
    input: z.infer<(typeof harmonyAbcInputSchemas)[Name]>;
  };
}[HarmonyAbcOperation];
/** Validate the operation with its exact input contract. */
export const harmonyAbcRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("inspect_harmony_abc"),
    input: harmonyAbcInputSchemas.inspect_harmony_abc,
  }),
  z.strictObject({
    operation: z.literal("list_harmony_abc_classes"),
    input: harmonyAbcInputSchemas.list_harmony_abc_classes,
  }),
  z.strictObject({
    operation: z.literal("decompile_harmony_abc_class"),
    input: harmonyAbcInputSchemas.decompile_harmony_abc_class,
  }),
  z.strictObject({
    operation: z.literal("decompile_harmony_abc"),
    input: harmonyAbcInputSchemas.decompile_harmony_abc,
  }),
  z.strictObject({
    operation: z.literal("disassemble_harmony_abc_method"),
    input: harmonyAbcInputSchemas.disassemble_harmony_abc_method,
  }),
  z.strictObject({
    operation: z.literal("search_harmony_abc_strings"),
    input: harmonyAbcInputSchemas.search_harmony_abc_strings,
  }),
]);

/** Producer facts retained with every observation; identity stays caller-owned. */
export const harmonyAbcEngineSchema = z.strictObject({
  name: z.literal("xpanda"),
  version: z.string(),
  /** Absolute path of the caller-supplied xpanda checkout. */
  root_path: z.string(),
  /** Digest over the engine source tree that answered this operation. */
  engine_sha256: digestSchema,
  source_revision: z.null(),
  /** Producer ISA table compatibility reported at load time. */
  bytecode_version_support: z.string(),
});

/** Completed observations retained when bridge cleanup cannot be confirmed. */
export interface HarmonyAbcPartialObservation {
  readonly kind: "harmony-abc";
  readonly result: JsonValue;
  readonly provenance?: JsonValue;
}

const executionBudget = z.object({
  analysis_timeout_ms: timeout
    .exactOptional()
    .describe(
      "Actual analysis budget in milliseconds; absent in historical Evidence means unknown",
    ),
});

const demangledClassRow = z.strictObject({
  name: z.string(),
  methods: bytes,
  fields: bytes,
  external: z.boolean(),
});

/** Portable results retain producer-reported facts, truncation and unknowns. */
export const harmonyAbcResultSchemas = {
  inspect_harmony_abc: z.strictObject({
    ...executionBudget.shape,
    engine: harmonyAbcEngineSchema,
    input_size: bytes,
    bytecode_version: z.string(),
    checksum: z.string(),
    class_count: bytes,
    foreign_class_count: bytes,
    lnp_count: bytes,
    class_name_preview: z.array(z.string().max(4096)).max(100),
    preview_truncated: z.boolean(),
    coverage: z.literal("header"),
  }),
  list_harmony_abc_classes: z.strictObject({
    ...executionBudget.shape,
    engine: harmonyAbcEngineSchema,
    total_classes: bytes,
    filtered_classes: bytes,
    offset: bytes,
    returned: bytes,
    truncated: z.boolean(),
    classes: z.array(demangledClassRow),
    coverage: z.literal("class_inventory"),
  }),
  decompile_harmony_abc_class: z.strictObject({
    ...executionBudget.shape,
    engine: harmonyAbcEngineSchema,
    class_name: z.string(),
    simplified: z.boolean(),
    degraded: z.boolean(),
    empty_result: z.boolean(),
    truncated: z.boolean(),
    characters: bytes,
    content: z.string(),
    coverage: z.literal("single_class"),
  }),
  decompile_harmony_abc: z.strictObject({
    ...executionBudget.shape,
    engine: harmonyAbcEngineSchema,
    output_directory: z.string(),
    written: bytes,
    skipped: bytes,
    failed: bytes,
    degraded_classes: z.array(z.string()),
    files: z.array(z.string()).max(200),
    files_truncated: z.boolean(),
    coverage: knownCoverageStatusSchema,
  }),
  disassemble_harmony_abc_method: z.strictObject({
    ...executionBudget.shape,
    engine: harmonyAbcEngineSchema,
    class_name: z.string(),
    method_name: z.string(),
    virtual_registers: bytes,
    arguments: bytes,
    blocks: bytes,
    truncated: z.boolean(),
    text: z.string(),
    coverage: z.literal("single_method"),
  }),
  search_harmony_abc_strings: z.strictObject({
    ...executionBudget.shape,
    engine: harmonyAbcEngineSchema,
    pool_size: bytes,
    matched: bytes,
    offset: bytes,
    returned: bytes,
    truncated: z.boolean(),
    strings: z.array(
      z.strictObject({ offset: z.string(), content: z.string() }),
    ),
    coverage: z.literal("string_pool"),
  }),
} as const;
