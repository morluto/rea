import { z } from "zod";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { ToolContract } from "./toolContractTypes.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";

/** List live Cutter plugin bridge sessions. */
export const cutterListInputSchema = z.strictObject({});

/** Execute a command in a selected live Cutter instance and observed document generation. */
export const cutterCommandInputSchema = z.strictObject({
  session_id: z.string().uuid(),
  expected_generation: z.number().int().nonnegative(),
  command: z
    .string()
    .min(1)
    .refine(
      (value) => !/[\r\n]/u.test(value),
      "A single Rizin command line is required",
    ),
  json: z.boolean().default(false),
});

export const cutterSessionSchema = z.strictObject({
  session_id: z.string().uuid(),
  pid: z.number().int().positive(),
  document_generation: z.number().int().nonnegative(),
  current_file: z.string().nullable(),
  cutter_version: z.string().nullable(),
  identity_status: z.literal("partial"),
});

export const cutterCommandResultSchema = z.strictObject({
  command: z.string(),
  output: jsonValueSchema.nullable(),
  execution_state: z.enum(["complete", "failed", "unknown"]),
  error: z.string().nullable(),
  message: z.string().nullable(),
  output_truncated: z.boolean(),
  cutter_version: z.string().nullable(),
  current_file: z.string().nullable(),
  document_generation: z.number().int().nonnegative(),
  identity_status: z.literal("partial"),
});

export const cutterDiscoverySchema = z.strictObject({
  sessions: z.array(cutterSessionSchema),
  bridge_directory: z.string(),
  discovery_status: z.enum([
    "sessions_found",
    "no_live_bridge_found",
    "bridge_directory_unavailable",
    "bridge_directory_insecure",
  ]),
  bridge_directory_security: z.enum([
    "private_verified",
    "not_private",
    "unverified_platform_acl",
    "not_checked",
  ]),
});

/** Live Cutter discovery and arbitrary Rizin command contracts. */
export const CUTTER_TOOL_CONTRACTS = [
  {
    name: "list_cutter_sessions",
    ...toolContractMetadata("list_cutter_sessions"),
    kind: "native-provider",
    description:
      "List live REA bridge sessions hosted by upstream Cutter instances, including observed document identity and bridge-directory security status.",
    inputSchema: cutterListInputSchema,
    outputSchema: cutterDiscoverySchema,
    examples: [{ title: "List open Cutter instances", input: {} }],
  },
  {
    name: "cutter_command",
    ...toolContractMetadata("cutter_command"),
    kind: "native-provider",
    description:
      "Run one arbitrary Rizin command in a selected live Cutter session. Commands may edit and persist analysis state or execute plugin-provided effects; completion uncertainty is returned as Evidence and must not be retried automatically.",
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
