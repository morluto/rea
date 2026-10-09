import { z } from "zod";

import type { ToolContract } from "./toolContractTypes.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";

const sessionId = z.string().uuid();
const gdbCommandResult = z.strictObject({
  command: z.string(),
  mi: z.string(),
  records: z.array(z.string()),
  console: z.string(),
  target: z.string(),
  log: z.string(),
  process_exit_observed: z.boolean().optional(),
  output_truncated: z.boolean(),
  completion_status: z.enum(["complete", "unknown"]),
});

/** Persistent GDB/MI session contracts hosted by the existing REA MCP server. */
export const GDB_TOOL_CONTRACTS = [
  {
    name: "start_gdb_session",
    ...toolContractMetadata("start_gdb_session"),
    kind: "native-provider",
    description:
      "Start a BYO GDB process in MI3 mode when available, suppress startup files, and disable auto-loading. The session persists in this REA MCP server process and receives an explicit session ID. Persistent sessions are unavailable on Windows because the owned Job Object cleanup cannot safely distinguish the debugger from its inferior processes.",
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({
      session_id: sessionId,
      mi_version: z.enum(["mi3", "mi2"]),
    }),
    examples: [{ title: "Start GDB", input: {} }],
  },
  {
    name: "gdb_console",
    ...toolContractMetadata("gdb_console"),
    kind: "native-provider",
    description:
      "Run one unrestricted GDB CLI command through MI interpreter-exec console and return raw MI, console, target, and log records inline with Evidence. A command timeout preserves collected records with completion_status unknown and stops the owned debugger session. Commands can execute shell, alter target state, access files, and use network. Closing the debugger never implies target termination.",
    inputSchema: z.strictObject({
      session_id: sessionId,
      command: z.string().min(1),
    }),
    outputSchema: evidenceResultOf(gdbCommandResult),
    examples: [
      {
        title: "Inspect loaded symbols",
        input: {
          session_id: "00000000-0000-4000-8000-000000000001",
          command: "info functions",
        },
      },
    ],
  },
  {
    name: "gdb_session_status",
    ...toolContractMetadata("gdb_session_status"),
    kind: "native-provider",
    description:
      "Return the observed lifecycle state and bounded recent MI records and process diagnostics for one persistent REA GDB session; truncation fields report discarded data.",
    inputSchema: z.strictObject({ session_id: sessionId }),
    outputSchema: z.strictObject({
      session_id: sessionId,
      mi_version: z.enum(["mi3", "mi2"]),
      state: z.enum(["ready", "closed"]),
      recent_mi_records: z.array(z.string()),
      recent_mi_records_truncated: z.boolean(),
      diagnostics_truncated: z.boolean(),
    }),
    examples: [
      {
        title: "Check GDB session",
        input: { session_id: "00000000-0000-4000-8000-000000000001" },
      },
    ],
  },
  {
    name: "close_gdb_session",
    ...toolContractMetadata("close_gdb_session"),
    kind: "native-provider",
    description:
      "Close the owned GDB process only after GDB reports no live thread groups. If groups remain, use the unrestricted console to choose a disposition for each one. REA never kills attached or remote targets as part of debugger cleanup.",
    inputSchema: z.strictObject({ session_id: sessionId }),
    outputSchema: z.strictObject({
      target_state: z.enum(["none_observed", "unknown"]),
    }),
    examples: [
      {
        title: "Close GDB session",
        input: { session_id: "00000000-0000-4000-8000-000000000001" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
