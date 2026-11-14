import { z } from "zod";

import type { ToolContract } from "./toolContractTypes.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";

const sessionId = z.string().uuid();

const commandResult = z.strictObject({
  completion_status: z.enum(["complete", "unknown"]),
  output_truncated: z.boolean(),
  command_error: z.boolean(),
});

/** Persistent Radare2 analysis session contracts. */
export const RADARE2_SESSION_TOOL_CONTRACTS = [
  {
    name: "start_radare2_session",
    ...toolContractMetadata("start_radare2_session"),
    kind: "native-provider",
    description:
      "Start a persistent Radare2 analysis session with `-N -q0` on one local artifact. Optional caller-selected `initial_commands` (at most 16, single-line, unrestricted like any session command) run once inside the same admission before the session is reported ready; if one fails, the session is closed and the start fails. REA runs no analysis automatically — running `aaa` is the caller's choice via `initial_commands` or a later command; analysis coverage is whatever commands ran. Commands and loaded plugins can execute foreign code, mutate files, access the network, and read files outside the selected artifact; identities and contents of those external inputs are not bound to Evidence. In a shared MCP server, starting this session retires any active binary-analysis session; after session effects have settled, call open_binary before further analysis. Close an active Ghidra session explicitly first. The session lives in this REA MCP process and is not tied to an inferior or TTY.",
    inputSchema: z.strictObject({
      path: z.string().min(1),
      initial_commands: z
        .array(
          z
            .string()
            .min(1)
            .refine(
              (value) => !/[\r\n\u0000]/u.test(value),
              "A single command line is required",
            ),
        )
        .max(16)
        .optional(),
    }),
    outputSchema: z.strictObject({ session_id: sessionId }),
    examples: [
      {
        title: "Start Radare2 analysis session",
        input: { path: "/tmp/program" },
      },
    ],
  },
  {
    name: "radare2_command",
    ...toolContractMetadata("radare2_command"),
    kind: "native-provider",
    description:
      "Execute one caller-selected command in a persistent Radare2 session. Returns raw NUL-frame output inline with Evidence; `parsed` carries a best-effort JSON projection when the output parses, and the raw output remains authoritative when it does not. For `aflj` and `izzj` listings, `summary` additionally carries a field-reduced projection (name/addr/size for `aflj`; string/vaddr/paddr/length for `izzj`) that saves tokens; the complete fields stay in `parsed` and the raw output. If the command exceeds the output or frame limit, `output_truncated` is true and `completion_status` is `unknown`; retained partial output is returned and the owned session is stopped. Commands can access local files, shell, network, plugins, and target state; effects depend on the command and loaded plugins. In a shared MCP server, this admitted command closes any active binary-analysis session; after its effects have settled, call open_binary before further analysis. Close an active Ghidra session explicitly first.",
    inputSchema: z.strictObject({
      session_id: sessionId,
      command: z
        .string()
        .min(1)
        .refine(
          (value) => !/[\r\n\u0000]/u.test(value),
          "A single command line is required",
        ),
    }),
    outputSchema: evidenceResultOf(commandResult),
    examples: [
      {
        title: "Analyze and list functions as JSON",
        input: {
          session_id: "00000000-4000-4000-8000-000000000001",
          command: "aaa",
        },
      },
    ],
  },
  {
    name: "radare2_session_status",
    ...toolContractMetadata("radare2_session_status"),
    kind: "native-provider",
    description:
      "Return observed lifecycle state, launch provenance, and bounded recent NUL-framed output for one Radare2 session; output_invalid_utf8 reports whether invalid UTF-8 has been observed in session frame bytes; recent output may contain replacement characters.",
    inputSchema: z.strictObject({ session_id: sessionId }),
    outputSchema: z.strictObject({
      session_id: sessionId,
      state: z.enum(["ready", "closed"]),
      caller_selected_path: z.string(),
      resolved_path: z.string(),
      recent_output: z.array(z.string()),
      recent_stderr: z.string(),
      output_invalid_utf8: z.boolean(),
      protocol_error: z.string().nullable(),
    }),
    examples: [
      {
        title: "Check Radare2 session",
        input: { session_id: "00000000-4000-4000-8000-000000000001" },
      },
    ],
  },
  {
    name: "close_radare2_session",
    ...toolContractMetadata("close_radare2_session"),
    kind: "native-provider",
    description:
      "Close one Radare2 session by asking it to quit and stopping the owned process; if the stop cannot be verified the session is retained for retry. In a shared MCP server, this admitted close retires any active binary-analysis session; after session effects have settled, call open_binary before further analysis. Close an active Ghidra session explicitly first.",
    inputSchema: z.strictObject({ session_id: sessionId }),
    outputSchema: z.strictObject({ closed: z.literal(true) }),
    examples: [
      {
        title: "Close Radare2 session",
        input: { session_id: "00000000-4000-4000-8000-000000000001" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
