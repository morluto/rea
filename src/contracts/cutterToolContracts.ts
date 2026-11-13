import { z } from "zod";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { cutterDiscoverySchema } from "../domain/cutterDiscovery.js";
import type { ToolContract } from "./toolContractTypes.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";

/** List live Cutter plugin bridge sessions. */
export const cutterListInputSchema = z.strictObject({});

/** Execute a command in a selected live Cutter instance and observed document generation. */
export const cutterCommandInputSchema = z.strictObject({
  session_id: z.string().uuid(),
  expected_generation: z.int().nonnegative(),
  command: z
    .string()
    .min(1)
    .refine(
      (value) => !/[\r\n]/u.test(value),
      "A single Rizin command line is required",
    ),
  json: z.boolean().default(false),
});

export const cutterCommandResultSchema = z.strictObject({
  command: z.string(),
  output: jsonValueSchema.nullable(),
  execution_state: z.enum(["not_started", "complete", "failed", "unknown"]),
  error: z.string().nullable(),
  message: z.string().nullable(),
  output_truncated: z.boolean(),
  cutter_version: z.string().nullable(),
  current_file: z.string().nullable(),
  document_generation: z.int().nonnegative(),
  identity_status: z.literal("partial"),
});

/** Live Cutter discovery and arbitrary Rizin command contracts. */
export const CUTTER_TOOL_CONTRACTS = [
  {
    name: "list_cutter_sessions",
    ...toolContractMetadata("list_cutter_sessions"),
    kind: "native-provider",
    description:
      "Find live REA bridge sessions in Cutter and return document identity and bridge-directory security status. Examines at most 256 descriptors with up to eight concurrent probes; excess capacity returns bridge_directory_capacity_exceeded, not an empty session list. The fixed discovery budget is separate from REA_BRIDGE_MAX_REQUEST_BYTES and cannot be raised at runtime.",
    inputSchema: cutterListInputSchema,
    outputSchema: cutterDiscoverySchema,
    examples: [{ title: "List open Cutter instances", input: {} }],
  },
  {
    name: "cutter_command",
    ...toolContractMetadata("cutter_command"),
    kind: "native-provider",
    description:
      "Run one arbitrary Rizin command in a selected Cutter session; it may persist edits or execute plugin effects. Reports completion uncertainty as Evidence; do not retry automatically. An admitted command retires shared binary analysis: close active Ghidra explicitly first, then reopen with open_binary after command effects settle. Supply session_id and expected_generation from discovery. REA_BRIDGE_MAX_REQUEST_BYTES bounds authenticated request/response payloads excluding LF (default 16777216, range 7464..536870887); mismatched client/Cutter budgets refuse dispatch. An out-of-band Cutter without this setting uses the default.",
    inputSchema: cutterCommandInputSchema,
    outputSchema: evidenceResultOf(cutterCommandResultSchema),
    examples: [
      {
        title: "Inspect active binary metadata",
        input: {
          session_id: "00000000-0000-4000-8000-000000000001",
          expected_generation: 0,
          command: "ij",
          json: true,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
