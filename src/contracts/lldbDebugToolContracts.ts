import { z } from "zod";

import { localPathStringSchema } from "../domain/localPath.js";
import { coverageStatusSchema } from "../domain/coverage.js";
import type { ToolContract } from "./toolContractTypes.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata, toolEffects } from "./toolEffects.js";

const sessionId = z.string().uuid();
const lldbCommandResult = z.strictObject({
  command: z.string(),
  output: z.string(),
  process_state: z.string().optional(),
  output_truncated: z.boolean(),
  output_invalid_utf8: z.literal(true).optional(),
  completion_status: coverageStatusSchema,
});

/**
 * Persistent LLDB debugger session contracts for macOS Apple Silicon.
 * Contributed by Hardik Shah <hardik05@gmail.com> (https://fuzzing.in, @hardik05).
 */
export const LLDB_DEBUG_TOOL_CONTRACTS = [
  {
    name: "start_lldb_session",
    availability: { host: "lldbDebugger" },
    ...toolContractMetadata(
      "start_lldb_session",
      toolEffects({
        launchesProcess: true,
        mutatesSession: true,
        mutatesTarget: true,
        executesForeignCode: true,
        idempotent: false,
      }),
    ),
    kind: "native-provider",
    description:
      "Start a persistent Apple Silicon LLDB debugger session using native SBDebugger on macOS. Optionally launch an owned target binary or attach to a live process by PID. Disables ASLR by default to ensure deterministic memory addresses across turns. Persistent LLDB sessions are hosted within this REA MCP server process and receive an explicit session ID. In a shared MCP server, starting this session retires any active binary-analysis session; after target effects have settled, call open_binary before further analysis.",
    inputSchema: z.strictObject({
      path: localPathStringSchema
        .optional()
        .describe(
          "Local Mach-O executable path to launch under LLDB. Cannot be combined with pid.",
        ),
      args: z
        .array(z.string())
        .optional()
        .describe("Command line arguments for the target binary."),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe("Environment variables for the target process."),
      pid: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Process ID to attach to instead of launching a new target. Cannot be combined with path.",
        ),
      stop_at_entry: z
        .boolean()
        .optional()
        .describe("Whether to halt at the binary entry point (default: true)."),
      disable_aslr: z
        .boolean()
        .optional()
        .describe(
          "Whether to disable ASLR for reproducible addresses (default: true).",
        ),
      breakpoints: z
        .array(z.string())
        .optional()
        .describe(
          "Initial symbol names, Objective-C selectors, or hex addresses to break on before run.",
        ),
    }),
    outputSchema: z.strictObject({
      session_id: sessionId,
      state: z.enum([
        "ready",
        "launched",
        "attached",
        "stopped",
        "running",
        "failed",
      ]),
      pid: z.number().int().nullable().optional(),
      target: z.string().nullable().optional(),
    }),
    examples: [
      {
        title: "Start LLDB session with binary",
        input: { path: "/tmp/my_target", stop_at_entry: true },
      },
    ],
  },
  {
    name: "lldb_command",
    ...toolContractMetadata(
      "lldb_command",
      toolEffects({
        mutatesTarget: true,
        mutatesSession: true,
        writesFilesystem: true,
        launchesProcess: true,
        accessesNetwork: true,
        executesForeignCode: true,
        idempotent: false,
      }),
    ),
    kind: "native-provider",
    description:
      "Execute one unrestricted LLDB console command (e.g. `po $x0`, `register read`, `thread backtrace`, `x/16gx $sp`, `c`, `b -[Class selector]`, `memory read`) in an active LLDB session and return output inline with Evidence. A command timeout preserves collected records with completion_status unknown. Commands can alter target memory, execute expressions, access files, and resume execution. In a shared MCP server, this admitted command closes any active binary-analysis session; after its effects have settled, call open_binary before further analysis.",
    inputSchema: z.strictObject({
      session_id: sessionId,
      command: z
        .string()
        .min(1)
        .describe("The LLDB CLI command string to execute."),
    }),
    outputSchema: evidenceResultOf(lldbCommandResult),
    examples: [
      {
        title: "Read ARM64 registers",
        input: {
          session_id: "00000000-0000-4000-8000-000000000001",
          command: "register read",
        },
      },
    ],
  },
  {
    name: "lldb_session_status",
    ...toolContractMetadata("lldb_session_status", toolEffects()),
    kind: "native-provider",
    description:
      "Return the observed lifecycle state, inferior PID, target path, and process state for one persistent REA LLDB session.",
    inputSchema: z.strictObject({ session_id: sessionId }),
    outputSchema: z.strictObject({
      session_id: sessionId,
      state: z.enum(["ready", "closed"]),
      process_state: z.string(),
      pid: z.number().int().nullable(),
      target: z.string().nullable(),
    }),
    examples: [
      {
        title: "Check LLDB session status",
        input: { session_id: "00000000-0000-4000-8000-000000000001" },
      },
    ],
  },
  {
    name: "close_lldb_session",
    ...toolContractMetadata(
      "close_lldb_session",
      toolEffects({
        launchesProcess: true,
        mutatesSession: true,
        mutatesTarget: true,
        executesForeignCode: true,
        idempotent: false,
      }),
    ),
    kind: "native-provider",
    description:
      "Close the owned LLDB session, terminate or detach the debugged inferior process, and destroy the underlying SBDebugger instance. In a shared MCP server, this admitted close retires any active binary-analysis session; after target effects have settled, call open_binary before further analysis.",
    inputSchema: z.strictObject({ session_id: sessionId }),
    outputSchema: z.strictObject({
      target_state: z.enum([
        "terminated",
        "detached",
        "exited",
        "none_observed",
        "unknown",
      ]),
    }),
    examples: [
      {
        title: "Close LLDB session",
        input: { session_id: "00000000-0000-4000-8000-000000000001" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
