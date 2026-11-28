import { z } from "zod";

import { analysisParameterLimitSchema } from "./analysisSettingDefinitions.js";

/**
 * A completed provider's own refusal of the command, read from the exact
 * diagnostic line it logged. Present only with completion_status rejected.
 */
export const commandRefusalSchema = z
  .strictObject({
    reason: z
      .enum([
        "unknown_command",
        "wrong_argument_count",
        "invalid_statement",
        "parse_failure",
      ])
      .describe(
        "unknown_command: the named command does not exist. wrong_argument_count: the named command received the wrong number of arguments. invalid_statement: the provider could not execute a statement. parse_failure: the provider could not parse the input.",
      ),
    command: z
      .string()
      .nullable()
      .describe(
        "The command the refusal line names; null when the line names none.",
      ),
    line: z.string().describe("The provider's refusal line from stderr."),
  })
  .describe(
    "The provider refused the command after starting it; statements after the refused one did not run.",
  );
export type CommandRefusal = z.infer<typeof commandRefusalSchema>;

/** A completed command's refusal and the limitation it places on the capture. */
export interface CommandRejection {
  readonly refusal: CommandRefusal;
  readonly limitation: string;
}

/** Opaque producer text and the command capture's explicit completion facts. */
export const commandObservationSchema = z.strictObject({
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.union([z.string(), z.number(), z.null()]),
  signal: z.string().nullable(),
  output_budget_bytes: z.int().positive().exactOptional(),
  output_budget_source: z.enum(["default", "request"]).exactOptional(),
  output_truncated: z.boolean(),
  /**
   * The request parameter whose budget stopped output collection, present
   * only when the capture reached it.
   */
  output_limit: analysisParameterLimitSchema.exactOptional(),
  // lifecycle-state: whether the provider process finished the command.
  completion_status: z
    .enum(["complete", "rejected", "unknown"])
    .describe(
      "complete: the provider process completed. rejected: it completed, but the provider reported that it refused the command; refusal and limitations say what ran. unknown: the capture or process ended early.",
    ),
  refusal: commandRefusalSchema.exactOptional(),
  artifact_sha256_after: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  artifact_changed: z.boolean().nullable(),
});

/** Exact producer admission that omitted command output; kinds define the unit. */
export const gdbOutputLimitSchema = z.strictObject({
  kind: z.enum(["command_bytes", "command_records", "mi_line_bytes"]),
  maximum: z.int().positive(),
});
export type GdbOutputLimit = z.infer<typeof gdbOutputLimitSchema>;

/** The MI stream record prefix of each GDB console, target and log record. */
const GDB_STREAM_RECORD_PREFIXES = {
  console: "~",
  target: "@",
  log: "&",
} as const;

/** Whether one ordered MI record belongs to the named stream grouping. */
export const isGdbStreamRecord = (
  record: string,
  stream?: keyof typeof GDB_STREAM_RECORD_PREFIXES,
): boolean =>
  stream === undefined
    ? Object.values(GDB_STREAM_RECORD_PREFIXES).some((prefix) =>
        record.startsWith(prefix),
      )
    : record.startsWith(GDB_STREAM_RECORD_PREFIXES[stream]);

/** The GDB owner retains ordered records and derives its stream groupings. */
export const gdbCommandResultSchema = z.strictObject({
  command: z.string(),
  mi: z
    .string()
    .describe(
      "The console command's independently framed MI result record; empty when a separate read-only query proves completion but raw stdout prevents identifying the original result class.",
    ),
  records: z.array(z.string()),
  console: z.string(),
  target: z.string(),
  log: z.string(),
  process_exit_observed: z.boolean().exactOptional(),
  process_exit_code: z.number().int().nullable().exactOptional(),
  process_exit_signal: z.string().nullable().exactOptional(),
  output_truncated: z.boolean(),
  output_limits: z.array(gdbOutputLimitSchema).min(1).exactOptional(),
  output_invalid_utf8: z.literal(true).exactOptional(),
  // lifecycle-state: whether GDB finished the command.
  completion_status: z.enum(["complete", "unknown"]),
});

/** Read-only capture facts; protocol interpretation stays with the provider. */
export type GdbCommandResult = Readonly<
  Omit<z.infer<typeof gdbCommandResultSchema>, "records">
> & { readonly records: readonly string[] };

export const commandEvidenceDetailSchema = z
  .enum(["complete", "summary"])
  .optional()
  .describe(
    "Omitted: the original Evidence when it fits the agent result budget, otherwise the retained summary. complete returns the original Evidence; summary retains that complete parent and returns command output once with completion and source context.",
  );
