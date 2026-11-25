import {
  harmonyAbcInputSchemas,
  harmonyAbcResultSchemas,
} from "../../domain/harmony/harmonyAbcAnalysis.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata, toolEffects } from "../toolEffects.js";

const ENGINE_FACTS =
  "Requires an absolute REA_XPANDA_ROOT pointing at a caller-supplied xpanda checkout (pure TypeScript, verified with 2.1.0); REA never installs or updates it. Linux and macOS. Adjust analysis_timeout_ms for the analysis wall-clock budget (default 120000); whole-file decompilation of large applications is the slowest operation. No target execution: the bytecode is parsed and rendered, never run.";

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
] as const satisfies readonly ToolContract[];
