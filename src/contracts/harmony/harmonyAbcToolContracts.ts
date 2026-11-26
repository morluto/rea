import {
  harmonyAbcInputSchemas,
  harmonyAbcResultSchemas,
} from "../../domain/harmony/harmonyAbcAnalysis.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata, toolEffects } from "../toolEffects.js";

const ENGINE_FACTS =
  "Requires an absolute REA_XPANDA_ROOT pointing at a caller-supplied xpanda checkout (pure TypeScript, verified with 3.6.0; 2.x admitted for the original operations); REA never installs or updates it. Linux and macOS. Adjust analysis_timeout_ms for the analysis wall-clock budget (default 120000); whole-file decompilation and decompiled-source searches are the slowest operations. No target execution: the bytecode is parsed and rendered, never run.";

const XPANDA_EFFECTS = toolEffects({
  mutatesSession: true,
  launchesProcess: true,
  writesFilesystem: true,
});
const XPANDA_EXPORT_EFFECTS = toolEffects({
  mutatesSession: true,
  launchesProcess: true,
  writesFilesystem: true,
  idempotent: false,
});

/** Explicit HarmonyOS Ark bytecode analysis, backed by a caller-supplied xpanda checkout. */
export const HARMONY_ABC_TOOL_CONTRACTS = [
  {
    name: "inspect_harmony_abc",
    cli: true,
    availability: { host: "harmonyAbc" },
    ...toolContractMetadata("inspect_harmony_abc", XPANDA_EFFECTS),
    kind: "harmony-provider",
    description:
      "Inspect a local HarmonyOS Ark bytecode (.abc) file header with xpanda: bytecode version, checksum, file size, class count, foreign class count, line-number-program count and a class-name preview. Header facts only; no decompilation. " +
      ENGINE_FACTS,
    inputSchema: harmonyAbcInputSchemas.inspect_harmony_abc,
    outputSchema: evidenceResultOf(harmonyAbcResultSchemas.inspect_harmony_abc),
    examples: [
      {
        title: "Inspect an Ark bytecode file",
        input: { path: "/tmp/modules.abc" },
      },
    ],
  },
  {
    name: "list_harmony_abc_classes",
    cli: true,
    availability: { host: "harmonyAbc" },
    ...toolContractMetadata("list_harmony_abc_classes", XPANDA_EFFECTS),
    kind: "harmony-provider",
    description:
      "List the demangled classes of a local HarmonyOS Ark bytecode (.abc) file with xpanda: one page of class rows (name, method count, field count, external flag) with an optional case-insensitive substring filter, offset and limit. Report totals, filtering and truncation explicitly. " +
      ENGINE_FACTS,
    inputSchema: harmonyAbcInputSchemas.list_harmony_abc_classes,
    outputSchema: evidenceResultOf(
      harmonyAbcResultSchemas.list_harmony_abc_classes,
    ),
    examples: [
      {
        title: "List classes filtered by package",
        input: {
          path: "/tmp/modules.abc",
          filter: "com.example",
          limit: 100,
        },
      },
    ],
  },
  {
    name: "decompile_harmony_abc_class",
    cli: true,
    availability: { host: "harmonyAbc" },
    ...toolContractMetadata("decompile_harmony_abc_class", XPANDA_EFFECTS),
    kind: "harmony-provider",
    description:
      "Decompile one class of a local HarmonyOS Ark bytecode (.abc) file to producer-generated JavaScript with xpanda and return it inline with explicit degraded and truncation flags. Degraded output is linearized (decompiler_goto labels) when the producer's structural analysis gives up, including methods using unimplemented conditional jumps. Single-class transfers cap at 50,000 characters; use whole-file decompilation for the rest. " +
      ENGINE_FACTS,
    inputSchema: harmonyAbcInputSchemas.decompile_harmony_abc_class,
    outputSchema: evidenceResultOf(
      harmonyAbcResultSchemas.decompile_harmony_abc_class,
    ),
    examples: [
      {
        title: "Decompile a single class",
        input: {
          path: "/tmp/modules.abc",
          class_name: "com.example.MainAbility",
        },
      },
    ],
  },
  {
    name: "decompile_harmony_abc",
    cli: true,
    availability: { host: "harmonyAbc" },
    ...toolContractMetadata("decompile_harmony_abc", XPANDA_EXPORT_EFFECTS),
    kind: "harmony-provider",
    description:
      "Decompile every class of a local HarmonyOS Ark bytecode (.abc) file with xpanda into an absent output directory, one JavaScript file per demangled class name. Returns written/skipped/failed counts, the degraded class list and up to 200 written file names. Per-class producer failures do not abort the export; they are reported and make coverage partial. Never executes decompiled output. " +
      ENGINE_FACTS,
    inputSchema: harmonyAbcInputSchemas.decompile_harmony_abc,
    outputSchema: evidenceResultOf(
      harmonyAbcResultSchemas.decompile_harmony_abc,
    ),
    examples: [
      {
        title: "Decompile a whole module",
        input: {
          path: "/tmp/modules.abc",
          output_directory: "/tmp/modules-decompiled",
        },
      },
    ],
  },
  {
    name: "disassemble_harmony_abc_method",
    cli: true,
    availability: { host: "harmonyAbc" },
    ...toolContractMetadata("disassemble_harmony_abc_method", XPANDA_EFFECTS),
    kind: "harmony-provider",
    description:
      "Disassemble one method of a local HarmonyOS Ark bytecode (.abc) file with xpanda: basic-block grouped bytecode listing with pc, operands, jump targets and try/catch attribution. The method header (virtual registers, arguments, block count) is parsed; the listing is preserved verbatim from the producer. Methods using unimplemented conditional-jump instructions cannot be disassembled and are reported as a producer capability boundary. " +
      ENGINE_FACTS,
    inputSchema: harmonyAbcInputSchemas.disassemble_harmony_abc_method,
    outputSchema: evidenceResultOf(
      harmonyAbcResultSchemas.disassemble_harmony_abc_method,
    ),
    examples: [
      {
        title: "Disassemble a method",
        input: {
          path: "/tmp/modules.abc",
          class_name: "com.example.MainAbility",
          method_name: "onCreate",
        },
      },
    ],
  },
  {
    name: "search_harmony_abc_strings",
    cli: true,
    availability: { host: "harmonyAbc" },
    ...toolContractMetadata("search_harmony_abc_strings", XPANDA_EFFECTS),
    kind: "harmony-provider",
    description:
      "Search the string pool of a local HarmonyOS Ark bytecode (.abc) file with xpanda: case-insensitive substring or regular-expression pattern, paged matches with file offsets. The producer builds the pool with a full disassembly pass per query; methods that fail disassembly are absent from the pool without being listed individually, so pool coverage is producer-owned. " +
      ENGINE_FACTS,
    inputSchema: harmonyAbcInputSchemas.search_harmony_abc_strings,
    outputSchema: evidenceResultOf(
      harmonyAbcResultSchemas.search_harmony_abc_strings,
    ),
    examples: [
      {
        title: "Search for URL-like strings",
        input: {
          path: "/tmp/modules.abc",
          pattern: "https://",
          limit: 50,
        },
      },
    ],
  },
  {
    name: "inspect_harmony_abc_class",
    cli: true,
    availability: { host: "harmonyAbc" },
    ...toolContractMetadata("inspect_harmony_abc_class", XPANDA_EFFECTS),
    kind: "harmony-provider",
    description:
      "Inspect one class of a local HarmonyOS Ark bytecode (.abc) file with xpanda: superclass, access flags, the field table with types, the method table with shorty prototypes, and import/export module bindings. Metadata only; no decompilation. " +
      ENGINE_FACTS,
    inputSchema: harmonyAbcInputSchemas.inspect_harmony_abc_class,
    outputSchema: evidenceResultOf(
      harmonyAbcResultSchemas.inspect_harmony_abc_class,
    ),
    examples: [
      {
        title: "Inspect a class declaration",
        input: {
          path: "/tmp/modules.abc",
          class_name: "com.example.MainAbility",
        },
      },
    ],
  },
  {
    name: "decompile_harmony_abc_method",
    cli: true,
    availability: { host: "harmonyAbc" },
    ...toolContractMetadata("decompile_harmony_abc_method", XPANDA_EFFECTS),
    kind: "harmony-provider",
    description:
      "Decompile one method of a local HarmonyOS Ark bytecode (.abc) file to producer-generated JavaScript with xpanda, returning only that method's source instead of the whole class. Degraded and truncation flags match class decompilation; the producer caps a transfer at 50,000 characters. " +
      ENGINE_FACTS,
    inputSchema: harmonyAbcInputSchemas.decompile_harmony_abc_method,
    outputSchema: evidenceResultOf(
      harmonyAbcResultSchemas.decompile_harmony_abc_method,
    ),
    examples: [
      {
        title: "Decompile one method",
        input: {
          path: "/tmp/modules.abc",
          class_name: "com.example.MainAbility",
          method_name: "onCreate",
        },
      },
    ],
  },
  {
    name: "search_harmony_abc_symbols",
    cli: true,
    availability: { host: "harmonyAbc" },
    ...toolContractMetadata("search_harmony_abc_symbols", XPANDA_EFFECTS),
    kind: "harmony-provider",
    description:
      "Search class, method and field names of a local HarmonyOS Ark bytecode (.abc) file with xpanda without decompiling. Supports substring or regular-expression queries, a symbol kind, a class filter, external symbols and paging. Use it to locate a class or method before inspecting or decompiling. " +
      ENGINE_FACTS,
    inputSchema: harmonyAbcInputSchemas.search_harmony_abc_symbols,
    outputSchema: evidenceResultOf(
      harmonyAbcResultSchemas.search_harmony_abc_symbols,
    ),
    examples: [
      {
        title: "Find entry-point methods",
        input: { path: "/tmp/modules.abc", query: "onCreate", kind: "method" },
      },
      {
        title: "List classes in a package",
        input: {
          path: "/tmp/modules.abc",
          query: "",
          kind: "class",
          class_filter: "com.example",
        },
      },
    ],
  },
  {
    name: "search_harmony_abc_code",
    cli: true,
    availability: { host: "harmonyAbc" },
    ...toolContractMetadata("search_harmony_abc_code", XPANDA_EFFECTS),
    kind: "harmony-provider",
    description:
      "Search decompiled JavaScript of a local HarmonyOS Ark bytecode (.abc) file with xpanda: substring or regular expression, optional class filter, context lines, and paging. Matching classes are decompiled on demand, so report scanned, skipped and failed classes and make truncation explicit; use whole-file decompilation for exhaustive searches. " +
      ENGINE_FACTS,
    inputSchema: harmonyAbcInputSchemas.search_harmony_abc_code,
    outputSchema: evidenceResultOf(
      harmonyAbcResultSchemas.search_harmony_abc_code,
    ),
    examples: [
      {
        title: "Find URL construction",
        input: {
          path: "/tmp/modules.abc",
          pattern: "https://",
          class_filter: "com.example",
        },
      },
    ],
  },
  {
    name: "trace_harmony_abc_references",
    cli: true,
    availability: { host: "harmonyAbc" },
    ...toolContractMetadata("trace_harmony_abc_references", XPANDA_EFFECTS),
    kind: "harmony-provider",
    description:
      "Find references to a class, method, field or string in a local HarmonyOS Ark bytecode (.abc) file with xpanda: bytecode cross-references and, for dynamic bytecode, optional decompiled-source call sites. Dynamic call targets live in the accumulator, so source scanning can find indirect calls the bytecode index cannot; report scanned classes, disassembly failures and truncation. " +
      ENGINE_FACTS,
    inputSchema: harmonyAbcInputSchemas.trace_harmony_abc_references,
    outputSchema: evidenceResultOf(
      harmonyAbcResultSchemas.trace_harmony_abc_references,
    ),
    examples: [
      {
        title: "Find callers of a method",
        input: {
          path: "/tmp/modules.abc",
          target_type: "method",
          target: "onCreate",
          owner_class: "com.example.MainAbility",
          source: true,
        },
      },
    ],
  },
  {
    name: "build_harmony_abc_call_graph",
    cli: true,
    availability: { host: "harmonyAbc" },
    ...toolContractMetadata("build_harmony_abc_call_graph", XPANDA_EFFECTS),
    kind: "harmony-provider",
    description:
      "Build a call graph around one method of a local HarmonyOS Ark bytecode (.abc) file with xpanda: callers, callees or both, bounded depth and node count, with an optional Mermaid rendering. Static bytecode uses exact instructions; dynamic bytecode derives call edges from decompiled source and reports truncation and disassembly failures. " +
      ENGINE_FACTS,
    inputSchema: harmonyAbcInputSchemas.build_harmony_abc_call_graph,
    outputSchema: evidenceResultOf(
      harmonyAbcResultSchemas.build_harmony_abc_call_graph,
    ),
    examples: [
      {
        title: "Map callers two levels up",
        input: {
          path: "/tmp/modules.abc",
          class_name: "com.example.MainAbility",
          method_name: "onCreate",
          direction: "callers",
          depth: 2,
          format: "mermaid",
        },
      },
    ],
  },
  {
    name: "inspect_harmony_hap_abc",
    cli: true,
    availability: { host: "harmonyAbc" },
    ...toolContractMetadata("inspect_harmony_hap_abc", XPANDA_EFFECTS),
    kind: "harmony-provider",
    description:
      "Extract one .abc entry from a local HarmonyOS application package (.hap) with xpanda and report its header facts: runtime (dynamic or static), bytecode version and a class-name preview. Select the entry when the package holds more than one; use the other HarmonyOS tools on an extracted .abc file. " +
      ENGINE_FACTS,
    inputSchema: harmonyAbcInputSchemas.inspect_harmony_hap_abc,
    outputSchema: evidenceResultOf(
      harmonyAbcResultSchemas.inspect_harmony_hap_abc,
    ),
    examples: [
      {
        title: "Inspect the main module bytecode",
        input: { path: "/tmp/app.hap", entry: "ets/modules.abc" },
      },
    ],
  },
  {
    name: "inspect_harmony_hap_resources",
    cli: true,
    availability: { host: "harmonyAbc" },
    ...toolContractMetadata("inspect_harmony_hap_resources", XPANDA_EFFECTS),
    kind: "harmony-provider",
    description:
      "Inspect the resource table of a local HarmonyOS application package (.hap) with xpanda: parse resources.index (Restool or RestoolV2), filter by name, type, qualifier or ID, and page the rows with type and qualifier totals. Report totals and truncation; this reads declarations, not resolved runtime values. " +
      ENGINE_FACTS,
    inputSchema: harmonyAbcInputSchemas.inspect_harmony_hap_resources,
    outputSchema: evidenceResultOf(
      harmonyAbcResultSchemas.inspect_harmony_hap_resources,
    ),
    examples: [
      {
        title: "Find a string resource",
        input: { path: "/tmp/app.hap", name: "app_name", type: "string" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
