import { z } from "zod";

import { localPathStringSchema } from "../domain/localPath.js";
import type { ToolContract } from "./toolContractTypes.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";

const sessionId = z.string().uuid();
const commandResult = z.strictObject({
  command: z.string(),
  output: z.string(),
  output_scope: z.literal("command_and_interleaved_session_output"),
  output_truncated: z.boolean(),
  output_invalid_utf8: z.literal(true).optional(),
  completion_status: z.enum(["complete", "unknown"]),
  backend: z.string().nullable(),
});

/** Persistent Rizin debugger session contracts. */
export const RIZIN_DEBUG_TOOL_CONTRACTS = [
  {
    name: "start_rizin_debug_session",
    ...toolContractMetadata("start_rizin_debug_session"),
    kind: "native-provider",
    description:
      "Start a persistent Rizin debugger for one selected target/backend. Linux and a caller-selected TTY for inferior stdin/stdout/stderr are required; the target may use that terminal after detach. Startup suppresses user settings/scripts while retaining plugins. Detach requires verified output sinks, no target access to the debugger command stream, and dbg.exitkills=false. Capabilities depend on the installed backend. This shared-server operation retires binary analysis: close Ghidra explicitly first, then reopen the binary after effects settle.",
    inputSchema: z.strictObject({
      path: localPathStringSchema,
      inferior_tty: localPathStringSchema,
      backend: z.string().min(1).optional(),
    }),
    outputSchema: z.strictObject({
      session_id: sessionId,
      backend: z.string().nullable(),
    }),
    examples: [
      {
        title: "Start Rizin debugger",
        input: { path: "/tmp/program", inferior_tty: "/dev/pts/7" },
      },
    ],
  },
  {
    name: "rizin_debug_command",
    ...toolContractMetadata("rizin_debug_command"),
    kind: "native-provider",
    description:
      "Run one unrestricted command in a persistent Rizin debugger; it can access target state, plugins, shell, files and network. Returns raw/interleaved session output as Evidence. Output/frame limits stop the owned debugger and retain partial output with output_truncated and unknown completion. Prequeued unsolicited frames refuse the call because correlation is ambiguous. This shared-server operation retires binary analysis: close Ghidra explicitly first, then reopen the binary after effects settle.",
    inputSchema: z.strictObject({
      session_id: sessionId,
      command: z
        .string()
        .min(1)
        .refine(
          (value) => !/[\r\n]/u.test(value),
          "A single command line is required",
        ),
    }),
    outputSchema: evidenceResultOf(commandResult),
    examples: [
      {
        title: "Inspect debugger state",
        input: {
          session_id: "00000000-0000-4000-8000-000000000001",
          command: "dr",
        },
      },
    ],
  },
  {
    name: "rizin_debug_session_status",
    ...toolContractMetadata("rizin_debug_session_status"),
    kind: "native-provider",
    description:
      "Return observed lifecycle state and bounded recent NUL-framed output and process diagnostics for one Rizin debugger session; truncation fields report discarded data, and output_invalid_utf8 reports whether invalid UTF-8 has been observed in session frame bytes; recent output may contain replacement characters.",
    inputSchema: z.strictObject({ session_id: sessionId }),
    outputSchema: z.strictObject({
      session_id: sessionId,
      state: z.enum(["ready", "closed"]),
      inferior_tty: z.string(),
      recent_output: z.array(z.string()),
      recent_output_truncated: z.boolean(),
      diagnostics_truncated: z.boolean(),
      output_invalid_utf8: z.boolean(),
    }),
    examples: [
      {
        title: "Check Rizin session",
        input: { session_id: "00000000-0000-4000-8000-000000000001" },
      },
    ],
  },
  {
    name: "close_rizin_debug_session",
    ...toolContractMetadata("close_rizin_debug_session"),
    kind: "native-provider",
    description:
      "Close the REA-owned Rizin debugger only after verifying no inferior remains or detaching one with a verified caller-selected TTY output sink. A detached target may continue running, read from and write to that TTY; target state is otherwise reported as unknown. REA never signals an inferior based on PID or path. In a shared MCP server, this admitted close retires any active binary-analysis session; after target effects have settled, call open_binary before further analysis. Close an active Ghidra session explicitly first.",
    inputSchema: z.strictObject({ session_id: sessionId }),
    outputSchema: z.strictObject({ target_state: z.literal("unknown") }),
    examples: [
      {
        title: "Close Rizin debugger",
        input: { session_id: "00000000-0000-4000-8000-000000000001" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
