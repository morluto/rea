import { z } from "zod";
import { nativeCallObservationInputSchema } from "../../domain/native/nativeCallObservation.js";
import {
  nativeUiObservationInputSchema,
  nativeUiScenarioInputSchema,
} from "../../domain/native/nativeUiObservation.js";

import type { ToolContract } from "../toolContracts.js";
import { nativeOutputSchemas } from "../toolOutputSchemas.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import { localPathStringSchema } from "../../domain/localPath.js";
import { toolContractMetadata } from "../toolEffects.js";
import { requireOutputSchema } from "../toolOutputSchemaPrimitives.js";

const examples: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  inspect_macho: {},
  inspect_signature: {},
  inspect_plist: { path: "/Applications/Example.app/Contents/Info.plist" },
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

const native = <Name extends string, Schema extends z.ZodObject>(
  name: Name,
  description: string,
  inputSchema: Schema,
) => {
  const outputSchema = requireOutputSchema(nativeOutputSchemas, name);
  const strictInputSchema = inputSchema.strict();
  return {
    name,
    ...toolContractMetadata(name),
    description,
    kind: "native-provider",
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
export const swiftSymbolsSchema = z
  .array(
    z
      .string()
      .min(1)
      .regex(/^[^\n]*$/u, "Each Swift symbol must be one line.")
      .regex(/^[^\0]*$/u, "Swift symbols cannot contain NUL."),
  )
  .min(1);

/** Provider-neutral semantic operations backed initially by macOS utilities. */
export const NATIVE_TOOL_CONTRACTS = [
  native(
    "observe_native_ui",
    "Observe an already-running native app by PID and window ID, bound to the active Mach-O target. Captures a bounded accessibility tree and selected-window screenshot; OS permission denial fails without broad capture or target launch.",
    nativeUiObservationInputSchema,
  ),
  native(
    "capture_native_ui_scenario",
    "Run selected-element press, increment/decrement scroll, AXValue text entry and bounded wait steps in one exact native app window. Returns ordered before/after captures and action/capture failures. Actions can change app data, network activity and persistent state; application state is left as-is and restoration is not attempted.",
    nativeUiScenarioInputSchema,
  ),
  native(
    "observe_native_calls",
    "Launch the active Mach-O as an owned process under LLDB and record each entry into caller-selected functions or Objective-C methods: thread, module, symbol, load and file address, raw argument registers, selector, receiver class and optional caller frames. Every hit auto-continues. No expression is evaluated and no other process is attached. The process is killed when max_events or duration_ms is reached; exit status, captured stdout/stderr, unresolved breakpoints and limitations are returned inline. The process runs with the current user's permissions and may change files, show UI or use the network. A hardened-runtime target needs the get-task-allow entitlement.",
    nativeCallObservationInputSchema,
  ),
  native(
    "inspect_macho",
    "Inspect Mach-O slices, load commands, imports, exports, dependencies, build metadata, segments, sections, permissions, and exact command provenance without launching Hopper.",
    z.object({}),
  ),
  native(
    "inspect_signature",
    "Inspect the active artifact's code-signing identity, hashes, authorities, requirements, entitlements, hardened-runtime state, and exact command provenance.",
    z.object({}),
  ),
  native(
    "inspect_plist",
    "Parse Info.plist from the active artifact by default, or pass any local plist path. Returns normalized JSON rather than plutil text.",
    z.object({
      path: localPathStringSchema.optional(),
    }),
  ),
  native(
    "list_architectures",
    "List thin or universal Mach-O slices with offsets, sizes, alignment, explicit coverage, and native-tool provenance.",
    z.object({}),
  ),
  native(
    "demangle_swift",
    "Demangle an ordered list of single-line Swift symbols without requiring Hopper. Each input returns demangled, unchanged, or invalid status.",
    z.object({
      symbols: swiftSymbolsSchema,
    }),
  ),
] as const satisfies readonly ToolContract[];

export type NativeToolName = (typeof NATIVE_TOOL_CONTRACTS)[number]["name"];
