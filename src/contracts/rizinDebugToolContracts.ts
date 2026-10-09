import { z } from "zod";

import type { ToolContract } from "./toolContractTypes.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";

const sessionId = z.string().uuid();
const commandResult = z.strictObject({
  command: z.string(),
  output: z.string(),
  output_scope: z.literal("command_and_interleaved_session_output"),
  output_truncated: z.boolean(),
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
      "Start a persistent Rizin debugger session using `-N` to suppress user settings and scripts while retaining plugins, `-0` for NUL framing, and `-d` with an optional caller-selected IO debugger backend. Backend and target capabilities depend on the installed build. The session lives in this REA MCP process. Persistent sessions are unavailable on Windows because the owned Job Object cleanup cannot safely distinguish the debugger from its inferior processes.",
    inputSchema: z.strictObject({
      path: z.string().min(1),
      backend: z.string().min(1).optional(),
    }),
    outputSchema: z.strictObject({
      session_id: sessionId,
      backend: z.string().nullable(),
    }),
    examples: [
      { title: "Start Rizin debugger", input: { path: "/tmp/program" } },
    ],
  },
  {
    name: "rizin_debug_command",
    ...toolContractMetadata("rizin_debug_command"),
    kind: "native-provider",
    description:
      "Execute one unrestricted command in a persistent Rizin debugger session. Returns raw output inline with Evidence, including backend output interleaved before the completion marker. If the command exceeds the output or frame limit, `output_truncated` is true and `completion_status` is `unknown`; retained partial output is returned and the owned debugger session is stopped. Unsolicited frames already queued before the command make the session unavailable because correlation is ambiguous. Commands can access local files, shell, network, plugins, and target state; effects depend on the active backend and target.",
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
      "Return observed lifecycle state and bounded recent NUL-framed output and process diagnostics for one Rizin debugger session; truncation fields report discarded data.",
    inputSchema: z.strictObject({ session_id: sessionId }),
    outputSchema: z.strictObject({
      session_id: sessionId,
      state: z.enum(["ready", "closed"]),
      recent_output: z.array(z.string()),
      recent_output_truncated: z.boolean(),
      diagnostics_truncated: z.boolean(),
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
      "Stop only the REA-owned Rizin debugger process. The target state is reported as unknown; REA does not infer that the target stopped or kill a process based on its PID or path.",
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
