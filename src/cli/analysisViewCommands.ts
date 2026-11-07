import { evidenceFileReferenceSchema } from "../domain/evidenceReference.js";
import { inspectAnalysisViewInputSchema } from "../domain/analysisView/analysisView.js";
import { jsonInputArgument } from "./jsonInputArgument.js";
import { z } from "incur";

import { inspectAnalysisView } from "../application/analysisView/AnalysisViewService.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ANALYSIS_VIEW_PROVIDER } from "../domain/investigationProviders.js";
import { inspectEvidenceBundleCommand } from "../application/EvidenceBundleCommands.js";
import {
  getEvidenceBundleInputSchema,
  importEvidenceBundleInputSchema,
} from "../contracts/sessionToolSchemas.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { parseCliJsonInput, resolveCliJsonPaths } from "../cliJsonInput.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

const inspectEvidenceBundleCliInputSchema =
  getEvidenceBundleInputSchema.safeExtend({
    path: importEvidenceBundleInputSchema.shape.path,
  });

const analysisViewCliInputSchema = inspectAnalysisViewInputSchema.extend({
  source: z.union(
    inspectAnalysisViewInputSchema.shape.source.options.map((source) =>
      source.shape.kind.value === "evidence-file"
        ? evidenceFileReferenceSchema.extend({ path: localPathStringSchema })
        : source,
    ),
  ),
});

/** Project selected views of completed analysis Evidence through the CLI. */
export const registerAnalysisViewCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectEvidenceBundle, {
    description:
      "Inspect a local Evidence bundle completely, as discovery metadata, as a page of selected complete records, or as direct-link and retained-closure membership.",
    args: z.object({
      inputJson: jsonInputArgument(
        CLI_COMMANDS.inspectEvidenceBundle,
        inspectEvidenceBundleCliInputSchema,
      ).describe(
        "JSON or JSON file with absolute path, detail, optional record filters, records or links offset/limit, and links traversal/link_status",
      ),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectEvidenceBundle, async () => {
          const input = await parseCliJsonInput(
            args.inputJson,
            CLI_COMMANDS.inspectEvidenceBundle,
            signal,
          );
          if (!input.ok) return input.error;
          const parsed = inspectEvidenceBundleCliInputSchema.safeParse(
            input.value,
          );
          if (!parsed.success)
            return {
              error: "Evidence bundle inspection failed",
              ...projectAnalysisError(
                analysisInputErrorFromIssues(
                  CLI_COMMANDS.inspectEvidenceBundle,
                  parsed.error.issues,
                  input.value,
                ),
              ),
            };
          const result = await inspectEvidenceBundleCommand(
            parsed.data,
            signal,
          );
          return result.ok
            ? result.value
            : {
                error: "Evidence bundle inspection failed",
                ...projectAnalysisError(result.error),
              };
        }),
      ),
  });
  cli.command(CLI_COMMANDS.inspectAnalysisView, {
    description:
      "Project a selected view of completed Evidence JSON for a supported analysis operation. For inventory rows, use --format csv or --format tsv with --filter-output normalized_result.items and --columns logical_path,artifact_id (if those fields are included in the view).",
    args: z.object({
      inputJson: jsonInputArgument(
        CLI_COMMANDS.inspectAnalysisView,
        analysisViewCliInputSchema,
      ).describe("Inline workflow JSON or JSON file path"),
    }),
    options: z.object({
      evidenceBundle: localPathStringSchema
        .optional()
        .describe(
          "Read the exact retained-evidence source ID from this local Evidence bundle without reopening the target; omit for inline Evidence",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectAnalysisView, async () => {
          const input = await parseCliJsonInput(
            args.inputJson,
            CLI_COMMANDS.inspectAnalysisView,
            signal,
          );
          if (!input.ok) return input.error;
          // An evidence-file path is resolved against the operator's working directory.
          const value = resolveCliJsonPaths(input.value, [["source", "path"]]);
          const resources = new ArtifactResourceScope();
          const bundlePath = options.evidenceBundle;
          const result = await finishAnalysisCommand(
            () =>
              inspectAnalysisView(value, undefined, {
                signal,
                resources,
                ...(bundlePath === undefined
                  ? {}
                  : { evidenceBundlePath: bundlePath }),
              }),
            resources,
            ANALYSIS_VIEW_PROVIDER.id,
            "inspect_analysis_view",
            signal,
          );
          // Preserve the inline command's existing error label without copying
          // the authenticated completed Evidence or its partial observation.
          return result.ok
            ? result.value
            : bundlePath === undefined
              ? { error: "Application workflow failed", ...result.error }
              : result.error;
        }),
      ),
  });
};
