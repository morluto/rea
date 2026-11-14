import { requireOutputSchema } from "../toolOutputSchemaPrimitives.js";
import { z } from "zod";
import { nativeCallObservationInputSchema } from "../../domain/native/nativeCallObservation.js";
import {
  nativeUiObservationInputSchema,
  nativeUiScenarioInputSchema,
} from "../../domain/native/nativeUiObservation.js";

import type { ToolContract } from "../toolContractTypes.js";
import { nativeOutputSchemas } from "../toolOutputSchemaGroups.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import { localPathStringSchema } from "../../domain/localPath.js";
import { toolContractMetadata } from "../toolEffects.js";
import { analysisDetailSchema } from "../analysisDetail.js";
import { nativeCommandTimeoutField } from "../../domain/native/nativeDeadlines.js";

const examples: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  inspect_macho: {},
  inspect_signature: {},
  inspect_plist: {},
  list_architectures: {},
  observe_native_ui: { pid: 123, window_id: 456 },
  capture_native_ui_scenario: {
    pid: 123,
    window_id: 456,
    steps: [{ kind: "wait", milliseconds: 100 }],
  },
  demangle_swift: { symbols: ["$s4Test3fooyyF"] },
  observe_native_calls: {
    breakpoints: [
      {
        kind: "objc-method",
        class_name: "NSURLSession",
        selector: "dataTaskWithRequest:completionHandler:",
      },
      { kind: "function", name: "open", module: "libsystem_kernel.dylib" },
    ],
    arguments: ["--help"],
    duration_ms: 5000,
    backtrace_frames: 4,
  },
};

const native = <
  Name extends keyof typeof nativeOutputSchemas,
  Schema extends z.ZodObject,
>(
  name: Name,
  description: string,
  inputSchema: Schema,
  retainedSummary?: ToolContract["retainedSummary"],
) => {
  const outputSchema = requireOutputSchema(nativeOutputSchemas, name);
  const strictInputSchema = inputSchema.strict();
  return {
    name,
    ...toolContractMetadata(name),
    description,
    kind: "native-provider",
    requiresActiveTarget: true,
    ...(retainedSummary === undefined ? {} : { retainedSummary }),
    inputSchema: strictInputSchema,
    outputSchema,
    examples: [
      {
        title: `Example ${name.replaceAll("_", " ")} request`,
        input: z
          .record(z.string(), jsonValueSchema)
          .parse(examples[name] ?? {}),
      },
    ],
  } satisfies ToolContract<Name, typeof strictInputSchema, typeof outputSchema>;
};

/** Ordered single-line symbols; `swift-demangle` ends each result with LF. */
export const swiftSymbolsSchema = z.array(
  z
    .string()
    .min(1)
    .regex(/^[^\n]*$/u, "Each Swift symbol must be one line.")
    .regex(/^[^\x00]*$/u, "Swift symbols cannot contain NUL."),
);

/** Provider-neutral semantic operations backed initially by macOS utilities. */
export const NATIVE_TOOL_CONTRACTS = [
  native(
    "observe_native_ui",
    "Observe one already-running native app window by PID/window ID, bound to the active Mach-O target. Returns a bounded accessibility tree and window screenshot; screenshot or accessibility must be enabled. Permission denial does not broaden capture or launch the target. native_ui_deadline_ms sets this call's deadline independently of output and wait-step limits. Use capture_native_ui_scenario to interact.",
    nativeUiObservationInputSchema,
  ),
  native(
    "capture_native_ui_scenario",
    "Interact with one exact native app window through selected-element press, scroll, AXValue text entry and bounded waits. Returns ordered before/after captures and per-step failures; screenshot or accessibility must be enabled. Actions may change app data, network activity and persistent state; REA leaves that state in place. native_ui_deadline_ms controls the scenario deadline, independently of output allowance and wait-step caps. Use observe_native_ui for observation only.",
    nativeUiScenarioInputSchema,
  ),
  native(
    "observe_native_calls",
    "Launch the active Mach-O under LLDB and record selected function/Objective-C method entries; the owned process is killed at max_events or duration_ms. Target execution uses the caller's permissions and may write files, show UI or use network. Hits auto-continue; REA evaluates no expressions and attaches to no other process. Returns addresses, thread/module/symbol, raw argument registers, selector/receiver facts, optional frames, stdout/stderr and limitations. Hardened-runtime targets need get-task-allow. Set capture_limits before launch; later changes cannot recover omitted observations.",
    nativeCallObservationInputSchema,
  ),
  native(
    "inspect_macho",
    "Inspect Mach-O slices, load commands, linkage, build metadata, segments/sections and permissions without launching Hopper. Returns command provenance and explicit coverage; segment and section file offsets are slice-relative, so add selected_architecture.container_file_offset for an input-file offset. detail summary retains complete Evidence for inspect_analysis_view kind macho rather than delivering large symbol lists inline. native_command_timeout_ms bounds each Xcode command, independently of output admission.",
    z.object({
      detail: analysisDetailSchema
        .unwrap()
        .optional()
        .describe(
          "Omitted or complete returns the complete inspection Evidence. summary retains that complete Evidence in this session and returns its inspect_analysis_view summary; use normalized_result.parent_evidence_id for macho pages.",
        ),
      native_command_timeout_ms: nativeCommandTimeoutField,
    }),
    { evidenceParameters: "omit-detail" },
  ),
  native(
    "inspect_signature",
    "Inspect the selected Mach-O slice's signing identity, hashes, authorities, requirement, entitlements and hardened-runtime state from a digest-verified snapshot. Other slices are checked for unsigned state with separate metadata coverage. Returns command provenance; native_command_timeout_ms bounds each codesign command independently of output admission.",
    z.object({
      native_command_timeout_ms: nativeCommandTimeoutField,
    }),
  ),
  native(
    "inspect_plist",
    "Parse Info.plist from an open binary or bundle-resource session, or select path within that session. Use open_binary or open_bundle_resources first; path alone does not open one. Returns normalized JSON. native_command_timeout_ms bounds each file/plutil command, not fixed input/decode/nesting allowances. XML also requires plutil validation and may be refused at a shallower depth; errors name the applicable limit.",
    z.object({
      path: localPathStringSchema
        .optional()
        .describe(
          "Optional plist selection for an already open binary or bundle-resource session; this does not open a session.",
        ),
      native_command_timeout_ms: nativeCommandTimeoutField,
    }),
  ),
  native(
    "list_architectures",
    "List thin/universal Mach-O slices with file offsets, sizes, alignment, coverage and native-tool provenance. native_command_timeout_ms bounds lipo, independently of output admission.",
    z.object({
      native_command_timeout_ms: nativeCommandTimeoutField,
    }),
  ),
  native(
    "demangle_swift",
    "Demangle an ordered list of single-line Swift symbols without Hopper. Returns demangled, unchanged or invalid for every input; invalid entries do not discard valid companions. native_command_timeout_ms bounds swift-demangle, independently of output admission.",
    z.object({
      symbols: swiftSymbolsSchema,
      native_command_timeout_ms: nativeCommandTimeoutField,
    }),
  ),
] as const satisfies readonly ToolContract[];

export type NativeToolName = (typeof NATIVE_TOOL_CONTRACTS)[number]["name"];
