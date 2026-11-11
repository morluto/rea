import { z } from "zod";
import { processArgumentSchema } from "../domain/process/processArgument.js";

/** REA-owned registration options; commands are launch data, never helper acquisition. */
export const mcpRegistrationOptionsSchema = z.object({
  agent: z
    .array(z.string())
    .optional()
    .describe(
      "Select client IDs or documented aliases; repeat --agent to select more than one.",
    ),
  command: processArgumentSchema
    .min(1)
    .optional()
    .describe(
      "Stdio launcher text: space-separated words, single/double quote fragments, literal backslashes. Empty quoted arguments are preserved; NUL is rejected. HTTP(S) URL sources are unsupported; configure remote transports in client settings.",
    ),
  noGlobal: z
    .boolean()
    .optional()
    .describe(
      "Write only project-scoped client settings; reject selections requiring global writes.",
    ),
});
const permissionsSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("verified_posix_modes"),
    directoryMode: z.literal(0o700),
    fileMode: z.literal(0o600),
  }),
  z.object({
    kind: z.literal("requested_windows_modes"),
    requestedDirectoryMode: z.literal(0o700),
    requestedFileMode: z.literal(0o600),
    aclVerification: z.literal("unavailable"),
  }),
]);
const labels = {
  client: z.string(),
  config_path: z.string(),
  scope: z.enum(["global", "project"]),
  permissions: permissionsSchema.optional(),
};
const clientOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    ...labels,
    status: z.literal("configured"),
    backup_path: z.string().optional(),
  }),
  z.object({ ...labels, status: z.literal("unchanged") }),
  z.object({
    ...labels,
    status: z.literal("failed"),
    error: z.looseObject({
      code: z.string(),
      message: z.string(),
      reason: z.string(),
    }),
  }),
  z.object({ ...labels, status: z.literal("not_started") }),
]);
/** Exact selected argv and every selected client's completion, including partial work. */
export const mcpRegistrationReportSchema = z.object({
  name: z.literal("rea"),
  command: z.string().min(1),
  args: z.array(z.string()),
  ok: z.boolean(),
  clients: z.array(clientOutcomeSchema),
});
export type McpRegistrationReport = z.infer<typeof mcpRegistrationReportSchema>;
