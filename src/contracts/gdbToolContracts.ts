import { z } from "zod";

import { localPathStringSchema } from "../domain/localPath.js";
import {
  commandEvidenceDetailSchema,
  gdbCommandResultSchema,
} from "../domain/commandObservation.js";
import { gdbCommandSummaryViewResultSchema } from "../domain/analysisView/analysisViewResult.js";
import type { ToolContract } from "./toolContractTypes.js";
import { analysisDetailOutputSchemaOf } from "./analysisDetail.js";
import { toolContractMetadata } from "./toolEffects.js";

const sessionId = z.string().uuid();

/** Persistent GDB/MI session contracts hosted by the existing REA MCP server. */
export const GDB_TOOL_CONTRACTS = [
  {
    name: "start_gdb_session",
    ...toolContractMetadata("start_gdb_session"),
    kind: "native-provider",
    description:
      "Start a persistent caller-supplied GDB session and return its session ID. Linux only; detaching a live inferior during close requires a verified durable output TTY. Startup suppresses init files and auto-loading, preferring MI3. Optional inferior_tty selects a verified terminal for later inferior runs; keep it available after GDB exits so close can detach a live inferior safely. The session belongs to this REA server process.",
    inputSchema: z.strictObject({
      inferior_tty: localPathStringSchema
        .optional()
        .describe(
          "Caller-selected terminal path for future inferior runs. GDB must report the exact configured path before the session is ready.",
        ),
    }),
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
      "Run one unrestricted command in a persistent GDB session; commands can run shell, change target state, access files and network. Returns ordered MI/console/target/log Evidence. A timeout retains collected records with completion_status unknown and stops the owned debugger; closing does not imply target termination. Default complete preserves full Evidence; summary retains it and omits duplicate stream/raw mirrors for inspect_analysis_view summary queries. In a shared server this command retires active binary analysis: close Ghidra explicitly first, then reopen the binary after command effects settle.",
    inputSchema: z.strictObject({
      session_id: sessionId,
      command: z.string().min(1),
      detail: commandEvidenceDetailSchema,
    }),
    outputSchema: analysisDetailOutputSchemaOf(
      gdbCommandResultSchema,
      gdbCommandSummaryViewResultSchema,
    ),
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
      "Return the observed lifecycle state and bounded recent MI records and process diagnostics for one persistent REA GDB session; closed_reason says why a closed session stopped, and truncation and invalid-UTF-8 fields report discarded or lossy data.",
    inputSchema: z.strictObject({ session_id: sessionId }),
    outputSchema: z.strictObject({
      session_id: sessionId,
      mi_version: z.enum(["mi3", "mi2"]),
      state: z.enum(["ready", "closed"]),
      recent_mi_records: z.array(z.string()),
      recent_mi_records_truncated: z.boolean(),
      mi_invalid_utf8: z.boolean(),
      stderr: z.string(),
      stderr_observed_bytes: z.int().nonnegative(),
      stderr_truncated: z.boolean(),
      stderr_invalid_utf8: z.boolean(),
      diagnostics_truncated: z.boolean(),
      inferior_tty: z.string().nullable(),
      inferior_tty_verified: z.boolean(),
      closed_reason: z
        .string()
        .exactOptional()
        .describe(
          "Present when state is closed: why the session stopped accepting commands. Close it and start a new session to continue.",
        ),
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
      "Close the owned GDB process after verifying the inferior state. When one live thread group has a verified durable output TTY, REA automatically detaches it, which may resume target execution; otherwise close reports that a disposition is required. REA never kills attached or remote targets as part of debugger cleanup. In a shared MCP server, this admitted close retires any active binary-analysis session; after target effects have settled, call open_binary before further analysis. Close an active Ghidra session explicitly first.",
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
