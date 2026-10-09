import { z } from "zod";

import {
  objdumpInputSchema,
  rizinInputSchema,
} from "../domain/reverseEngineering.js";
import type { ToolContract } from "./toolContractTypes.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";

const commandObservationSchema = z.strictObject({
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.union([z.string(), z.number(), z.null()]),
  signal: z.string().nullable(),
  output_truncated: z.boolean(),
  completion_status: z.enum(["complete", "unknown"]),
  artifact_sha256_after: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  artifact_changed: z.boolean().nullable(),
});

/** Caller-selected GNU objdump and Rizin observations. */
export const REVERSE_ENGINEERING_TOOL_CONTRACTS = [
  {
    name: "inspect_with_objdump",
    ...toolContractMetadata("inspect_with_objdump"),
    kind: "native-provider",
    description:
      "Run caller-selected GNU objdump inspection against a local artifact. Preserves captured stdout and stderr inline with SHA-256 Evidence, up to 16 MiB per stream (32 MiB combined); output_truncated reports output beyond a stream limit and completion_status is unknown if buffer enforcement terminated the process. The raw output is authoritative and REA does not claim a stable normalized format. DWARF mode follows local debug links by default; follow_debug_links selects whether links are followed. REA clears DEBUGINFOD_URLS for objdump so DWARF processing does not make debuginfod network requests. BFD targets are those compiled into the installed binary.",
    inputSchema: objdumpInputSchema,
    outputSchema: evidenceResultOf(commandObservationSchema),
    examples: [
      {
        title: "Disassemble code sections",
        input: { path: "/tmp/program", operation: "disassemble" },
      },
    ],
  },
  {
    name: "execute_rizin_command",
    ...toolContractMetadata("execute_rizin_command"),
    kind: "native-provider",
    description:
      "Execute one caller-selected Rizin command against a local artifact using the Rizin CLI profile that suppresses user settings and scripts while retaining plugins. Preserves captured stdout and stderr inline with SHA-256 Evidence, up to 16 MiB per stream (32 MiB combined); output_truncated reports output beyond a stream limit and completion_status is unknown if buffer enforcement terminated the process. Command effects depend on the Rizin command and loaded plugins; JSON is command-specific and raw output remains authoritative.",
    inputSchema: rizinInputSchema,
    outputSchema: evidenceResultOf(commandObservationSchema),
    examples: [
      {
        title: "Inspect binary information",
        input: { path: "/tmp/program", command: "iI" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
