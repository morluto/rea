import { z } from "zod";
import {
  commandObservationSchema,
  gdbCommandResultSchema,
  isGdbStreamRecord,
} from "../commandObservation.js";
import { digestSchema } from "../digests.js";
import { providerSchema, evidenceSubjectTarget } from "../evidence.js";
import { analysisInputErrorFromIssues } from "../inputIssueProjection.js";
import { jsonValueSchema } from "../jsonValue.js";
import { err, ok } from "../result.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  ownedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
} from "./analysisViewCoverage.js";
import {
  analysisViewInputError,
  invalidAnalysisView,
} from "./analysisViewErrors.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";
import { isRecord } from "../../kernel/isRecord.js";

export const commandSummaryContext = {
  source_provider: providerSchema.nullable(),
  source_analysis_profile_digest: digestSchema.nullable(),
  source_parameters: jsonValueSchema,
};

/**
 * Keep every ordered result, asynchronous and unrecognized record. Stream
 * records carry the console, target and log text, which the summary reports
 * only by size; the retained parent keeps them.
 */
export const gdbCommandSummarySchema = gdbCommandResultSchema
  .omit({ console: true, target: true, log: true })
  .extend({
    records: z
      .array(z.string())
      .describe(
        "Ordered MI records other than console, target and log stream records.",
      ),
    available_counts: z.strictObject({
      records: z.number().int().nonnegative(),
      stream_records: z.number().int().nonnegative(),
      console_utf16_units: z.number().int().nonnegative(),
      target_utf16_units: z.number().int().nonnegative(),
      log_utf16_units: z.number().int().nonnegative(),
    }),
  });

/**
 * Keep every completion fact and replace the opaque output text with its
 * size: a whole-binary disassembly can be megabytes. The complete text stays
 * in the retained parent.
 */
export const objdumpCommandSummarySchema = commandObservationSchema
  .omit({ stdout: true, stderr: true })
  .extend({
    available_counts: z.strictObject({
      stdout_utf16_units: z.number().int().nonnegative(),
      stderr_utf16_units: z.number().int().nonnegative(),
    }),
  });

const readGdbCommandResult = createAnalysisViewResultReader(
  gdbCommandResultSchema,
);
const readCommandObservation = createAnalysisViewResultReader(
  commandObservationSchema,
);

/** Select existing owner facts without parsing a command or its output protocol. */
export const projectCommandObservationView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const view = ownedView<SummaryAnalysisView>(admitted, "summary");
  if (view === undefined)
    return invalidAnalysisView("Command observations support summary views.");
  if (
    parent.operation !== "gdb_console" &&
    parent.operation !== "inspect_with_objdump"
  )
    return err(
      analysisViewInputError([
        {
          path: ["source", "operation"],
          reason: "invalid_value",
          message: "Unsupported command-observation operation.",
        },
      ]),
    );
  const parameters = jsonValueSchema.safeParse(parent.parameters ?? null);
  if (!parameters.success)
    return err(
      analysisInputErrorFromIssues(
        "inspect_analysis_view",
        parameters.error.issues.map((issue) => ({
          ...issue,
          path: ["source", "parameters", ...issue.path],
        })),
        { source: { parameters: parent.parameters } },
        { cause: parameters.error },
      ),
    );
  const subject =
    parent.subject === undefined
      ? undefined
      : evidenceSubjectTarget(parent.subject);
  const artifact =
    parent.subject === undefined
      ? (parent.artifact ?? null)
      : subject === undefined
        ? null
        : { path: subject.path, sha256: subject.sha256 };
  const shared = {
    kind: "summary" as const,
    view,
    parent_evidence_id: parent.evidenceId,
    parent_digest: parent.evidenceId.slice(3),
    artifact,
    source_provider: parent.provider ?? null,
    source_analysis_profile_digest: parent.analysisProfile?.digest ?? null,
    source_parameters: parameters.data,
    coverage: completeWithinViewCoverage(1),
    limitations: boundedViewMessages(
      parent.limitations,
      parent.evidenceId,
      "limitations",
    ),
    unknowns: boundedViewMessages(
      [
        "This retained command observation does not establish current target state or global analysis coverage.",
      ],
      parent.evidenceId,
      "unknowns",
    ),
  };
  if (parent.operation === "gdb_console") {
    const parsed = readGdbCommandResult(parent);
    if (!parsed.ok) return parsed;
    const selection = parameters.data;
    if (
      isRecord(selection) &&
      typeof selection.command === "string" &&
      selection.command !== parsed.value.command
    )
      return err(
        analysisViewInputError([
          {
            path: ["source", "parameters", "command"],
            reason: "invalid_value",
            message:
              "The captured command conflicts with its source parameters.",
          },
        ]),
      );
    const { console, target, log, records, ...facts } = parsed.value;
    const retained = records.filter((record) => !isGdbStreamRecord(record));
    return ok({
      ...shared,
      parent_operation: "gdb_console" as const,
      summary: {
        ...facts,
        records: retained,
        available_counts: {
          records: records.length,
          stream_records: records.length - retained.length,
          console_utf16_units: console.length,
          target_utf16_units: target.length,
          log_utf16_units: log.length,
        },
      },
    });
  }
  const parsed = readCommandObservation(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  if (
    artifact !== null &&
    report.artifact_sha256_after !== null &&
    report.artifact_changed !== null &&
    report.artifact_changed !==
      (artifact.sha256 !== report.artifact_sha256_after)
  )
    return err(
      analysisViewInputError([
        {
          path: ["source", "normalized_result", "artifact_changed"],
          reason: "invalid_value",
          message:
            "The recorded artifact-change flag conflicts with the observed digests.",
        },
      ]),
    );
  const { stdout, stderr, ...facts } = report;
  return ok({
    ...shared,
    parent_operation: "inspect_with_objdump" as const,
    summary: {
      ...facts,
      available_counts: {
        stdout_utf16_units: stdout.length,
        stderr_utf16_units: stderr.length,
      },
    },
  });
};
