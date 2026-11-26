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
  inspect_harmony_abc_class: z.strictObject({
    ...target,
    class_name: className,
  }),
  decompile_harmony_abc_method: z.strictObject({
    ...target,
    class_name: className,
    method_name: z
      .string()
      .min(1)
      .max(1024)
      .describe(
        'Method name as rendered in source, or "constructor" / "%%get-name" / "%%set-name"',
      ),
    simplify: z
      .boolean()
      .default(true)
      .describe(
        "Run the producer optimizer pipeline; false returns raw linear output",
      ),
  }),
  search_harmony_abc_symbols: z.strictObject({
    ...target,
    query: z
      .string()
      .max(1024)
      .describe(
        "Class, method or field name text; an empty string lists every symbol",
      ),
    kind: z
      .enum(["all", "class", "method", "field"])
      .default("all")
      .describe("Symbol kind to search"),
    regex: z
      .boolean()
      .default(false)
      .describe("Interpret query as a regular expression"),
    case_sensitive: z
      .boolean()
      .default(false)
      .describe("Match query case-sensitively"),
    class_filter: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "Class-name substring filter, matching mangled or demangled names",
      ),
    include_external: z
      .boolean()
      .default(true)
      .describe("Include external symbols"),
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
      .default(50)
      .describe("Maximum matches per page"),
  }),
  search_harmony_abc_code: z.strictObject({
    ...target,
    pattern: z
      .string()
      .min(1)
      .max(1024)
      .describe(
        "Substring to find in decompiled JavaScript, or a regular expression when regex is true",
      ),
    regex: z
      .boolean()
      .default(false)
      .describe("Interpret pattern as a regular expression"),
    case_sensitive: z
      .boolean()
      .default(false)
      .describe("Match pattern case-sensitively"),
    class_filter: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "Only scan classes whose mangled or demangled name contains this text",
      ),
    simplify: z.boolean().default(true).describe("Search optimized output"),
    max_classes: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(100)
      .describe("Maximum classes to decompile for this search"),
    context_lines: z
      .number()
      .int()
      .min(0)
      .max(3)
      .default(0)
      .describe("Context lines to return beside each match"),
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
      .default(50)
      .describe("Maximum matches per page"),
  }),
  trace_harmony_abc_references: z.strictObject({
    ...target,
    target_type: z
      .enum(["class", "method", "field", "string"])
      .describe("What the references point at"),
    target: z
      .string()
      .min(1)
      .max(1024)
      .describe(
        "Target name; class names may be mangled or demangled, strings match exactly",
      ),
    owner_class: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe("Owning class for a method or field target"),
    source: z
      .boolean()
      .default(false)
      .describe(
        "Also scan decompiled source call sites (dynamic bytecode only); slower",
      ),
    max_classes: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(200)
      .describe("Maximum classes to scan when source is true"),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Index into the references; combine with limit to page"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe("Maximum references per page"),
  }),
  build_harmony_abc_call_graph: z.strictObject({
    ...target,
    class_name: className,
    method_name: z
      .string()
      .min(1)
      .max(1024)
      .describe('Root method name, or "constructor"'),
    direction: z
      .enum(["callers", "callees", "both"])
      .default("both")
      .describe("Graph direction to expand"),
    depth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(2)
      .describe("Expansion depth from the root method"),
    max_nodes: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(200)
      .describe("Maximum nodes in the graph"),
    max_classes: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(200)
      .describe("Maximum classes scanned for dynamic call sites"),
    simplify: z
      .boolean()
      .default(true)
      .describe("Scan optimized source for dynamic call sites"),
    format: z
      .enum(["json", "mermaid"])
      .default("json")
      .describe(
        "Return the graph as JSON, optionally with a Mermaid rendering",
      ),
  }),
  inspect_harmony_hap_abc: z.strictObject({
    path: absoluteLocalPathStringSchema.describe(
      "Absolute local HarmonyOS application package (.hap); parsed, never executed",
    ),
    entry: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe(
        '.abc entry inside the package, such as "ets/modules.abc"; omit when the package has exactly one',
      ),
    analysis_timeout_ms: timeout
      .optional()
      .describe(
        "Analysis wall-clock budget in milliseconds (default 120000), from bridge startup through the producer call; excludes queue admission.",
      ),
  }),
  inspect_harmony_hap_resources: z.strictObject({
    path: absoluteLocalPathStringSchema.describe(
      "Absolute local HarmonyOS application package (.hap); parsed, never executed",
    ),
    name: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("Resource-name substring filter, case-insensitive"),
    type: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('Resource type, such as "string", "color" or "media"'),
    limit_key: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('Qualifier, such as "base", "dark" or "en_US"'),
    id: z
      .string()
      .min(1)
      .max(32)
      .optional()
      .describe('Resource ID, such as "0x03000003" or a decimal number'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Index into the resources; combine with limit to page"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe("Maximum resources per page"),
    analysis_timeout_ms: timeout
      .optional()
      .describe(
        "Analysis wall-clock budget in milliseconds (default 120000), from bridge startup through the producer call; excludes queue admission.",
      ),
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
  z.strictObject({
    operation: z.literal("inspect_harmony_abc_class"),
    input: harmonyAbcInputSchemas.inspect_harmony_abc_class,
  }),
  z.strictObject({
    operation: z.literal("decompile_harmony_abc_method"),
    input: harmonyAbcInputSchemas.decompile_harmony_abc_method,
  }),
  z.strictObject({
    operation: z.literal("search_harmony_abc_symbols"),
    input: harmonyAbcInputSchemas.search_harmony_abc_symbols,
  }),
  z.strictObject({
    operation: z.literal("search_harmony_abc_code"),
    input: harmonyAbcInputSchemas.search_harmony_abc_code,
  }),
  z.strictObject({
    operation: z.literal("trace_harmony_abc_references"),
    input: harmonyAbcInputSchemas.trace_harmony_abc_references,
  }),
  z.strictObject({
    operation: z.literal("build_harmony_abc_call_graph"),
    input: harmonyAbcInputSchemas.build_harmony_abc_call_graph,
  }),
  z.strictObject({
    operation: z.literal("inspect_harmony_hap_abc"),
    input: harmonyAbcInputSchemas.inspect_harmony_hap_abc,
  }),
  z.strictObject({
    operation: z.literal("inspect_harmony_hap_resources"),
    input: harmonyAbcInputSchemas.inspect_harmony_hap_resources,
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
  inspect_harmony_abc_class: z.strictObject({
    ...executionBudget.shape,
    engine: harmonyAbcEngineSchema,
    class_name: z.string(),
    raw_name: z.string(),
    super_class: z.string().nullable(),
    external: z.boolean(),
    access_flags: z.string(),
    fields: z
      .array(
        z.strictObject({
          name: z.string(),
          field_type: z.string().nullable(),
          external: z.boolean(),
        }),
      )
      .max(100_000),
    methods: z
      .array(
        z.strictObject({
          name: z.string(),
          access_flags: z.string(),
          external: z.boolean(),
          has_code: z.boolean(),
          has_try_catch: z.boolean(),
          shorty: z.string().nullable(),
        }),
      )
      .max(100_000),
    imports: z
      .array(
        z.strictObject({
          local_name: z.string(),
          import_name: z.string(),
          path: z.string(),
          kind: z.union([z.string(), z.number()]).nullable(),
        }),
      )
      .max(100_000),
    exports: z
      .array(
        z.strictObject({
          local_name: z.string(),
          export_name: z.string(),
          path: z.string(),
          kind: z.union([z.string(), z.number()]).nullable(),
        }),
      )
      .max(100_000),
    coverage: z.literal("class_metadata"),
  }),
  decompile_harmony_abc_method: z.strictObject({
    ...executionBudget.shape,
    engine: harmonyAbcEngineSchema,
    class_name: z.string(),
    method_name: z.string(),
    simplified: z.boolean(),
    degraded: z.boolean(),
    empty_result: z.boolean(),
    truncated: z.boolean(),
    characters: bytes,
    content: z.string(),
    coverage: z.literal("method_source"),
  }),
  search_harmony_abc_symbols: z.strictObject({
    ...executionBudget.shape,
    engine: harmonyAbcEngineSchema,
    total: bytes,
    offset: bytes,
    limit: bytes,
    returned: bytes,
    truncated: z.boolean(),
    matches: z
      .array(
        z.strictObject({
          kind: z.enum(["class", "method", "field"]),
          raw_name: z.string(),
          name: z.string(),
          owner_class: z.string().optional(),
          owner_class_name: z.string().optional(),
          field_type: z.string().optional(),
          method_count: bytes.optional(),
          field_count: bytes.optional(),
          external: z.boolean().optional(),
          has_code: z.boolean().optional(),
        }),
      )
      .max(500),
    coverage: z.literal("symbol_index"),
  }),
  search_harmony_abc_code: z.strictObject({
    ...executionBudget.shape,
    engine: harmonyAbcEngineSchema,
    pattern: z.string(),
    simplified: z.boolean(),
    scanned_classes: bytes,
    skipped_classes: bytes,
    failed_classes: z.array(z.string()).max(20),
    failed_class_count: bytes,
    candidate_classes: bytes,
    truncated_classes: z.boolean(),
    total: bytes,
    offset: bytes,
    limit: bytes,
    returned: bytes,
    truncated: z.boolean(),
    matches: z
      .array(
        z.strictObject({
          class_name: z.string(),
          line: bytes,
          text: z.string(),
          method: z.string().optional(),
          method_kind: z.string().optional(),
          context: z
            .array(z.strictObject({ line: bytes, text: z.string() }))
            .optional(),
        }),
      )
      .max(500),
    coverage: z.literal("decompiled_source"),
  }),
  trace_harmony_abc_references: z.strictObject({
    ...executionBudget.shape,
    engine: harmonyAbcEngineSchema,
    target_type: z.enum(["class", "method", "field", "string"]),
    target: z.string(),
    target_owner: z.string().nullable(),
    total: bytes,
    offset: bytes,
    limit: bytes,
    returned: bytes,
    truncated: z.boolean(),
    source_scanned_classes: bytes,
    source_truncated_classes: z.boolean(),
    xref_count: bytes,
    disassembly_failures: bytes,
    matches: z
      .array(
        z.strictObject({
          from_class: z.string(),
          from_class_raw: z.string(),
          from_method: z.string(),
          pc: z.number().int().nullable(),
          line: z.number().int().nullable(),
          opcode: z.string().nullable(),
          kind: z.string(),
          target_type: z.enum(["class", "method", "field", "string"]),
          target_name: z.string(),
          target_class: z.string().nullable(),
          target_class_raw: z.string().nullable(),
          origin: z.enum(["bytecode", "source"]),
        }),
      )
      .max(500),
    coverage: z.literal("bytecode_references"),
  }),
  build_harmony_abc_call_graph: z.strictObject({
    ...executionBudget.shape,
    engine: harmonyAbcEngineSchema,
    root_class: z.string(),
    root_method: z.string(),
    direction: z.enum(["callers", "callees", "both"]),
    depth: bytes,
    node_count: bytes,
    edge_count: bytes,
    truncated: z.boolean(),
    disassembly_failures: bytes,
    source_truncated_classes: z.boolean(),
    nodes: z
      .array(
        z.strictObject({
          id: z.string(),
          class_name: z.string(),
          class_raw: z.string(),
          method: z.string(),
          depth: bytes,
          via: z.array(z.enum(["callers", "callees", "root"])),
        }),
      )
      .max(1000),
    edges: z
      .array(
        z.strictObject({
          from: z.string(),
          to: z.string(),
          kind: z.string(),
        }),
      )
      .max(10_000),
    mermaid: z.string().optional(),
    coverage: z.literal("call_graph"),
  }),
  inspect_harmony_hap_abc: z.strictObject({
    ...executionBudget.shape,
    engine: harmonyAbcEngineSchema,
    entry: z.string(),
    cached: z.boolean(),
    runtime: z.enum(["dynamic", "static"]),
    bytecode_version: z.string(),
    class_count: bytes,
    class_name_preview: z.array(z.string().max(4096)).max(50),
    preview_truncated: z.boolean(),
    coverage: z.literal("hap_entry"),
  }),
  inspect_harmony_hap_resources: z.strictObject({
    ...executionBudget.shape,
    engine: harmonyAbcEngineSchema,
    format: z.enum(["Restool", "RestoolV2"]),
    version: z.union([z.string(), z.number()]),
    total: bytes,
    matched: bytes,
    by_type: z.record(z.string(), bytes),
    by_limit_key: z.record(z.string(), bytes),
    offset: bytes,
    limit: bytes,
    returned: bytes,
    truncated: z.boolean(),
    resources: z
      .array(
        z.strictObject({
          id: z.string(),
          name: z.string(),
          resource_type: z.string(),
          limit_key: z.string(),
          value: z.string(),
        }),
      )
      .max(200),
    coverage: z.literal("hap_resources"),
  }),
} as const;
