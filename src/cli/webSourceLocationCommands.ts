import {
  localSourceMapLimitCliOptions,
  sourceMapLimitsFromCli,
} from "./sourceMapLimits.js";
import {
  analysisEvidenceDeliveryOptions,
  parseCliAnalysisEvidenceDelivery,
  deliverCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";
import { webSourceLocationDeliverySchema } from "../domain/analysisView/webSourceLocationView.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { z } from "incur";
import { createWebSourceLocationService } from "../composition/webSourceLocations.js";
import { webSourceLocationInputSchema } from "../domain/webSourceLocation.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { cliDecimalField } from "./options.js";
import { withCommandCancellation } from "./commandCancellation.js";

const sourceMapSelection = webSourceLocationInputSchema.shape.source_map;
const generatedPosition = webSourceLocationInputSchema.shape.generated_position;

/** Expose the same explicit selected map/point contract through the CLI. */
export const registerWebSourceLocationCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = createWebSourceLocationService(environment);
  cli.command(CLI_COMMANDS.traceWebSourceLocation, {
    description:
      "Trace one retained script position through an explicitly selected local source map",
    args: z.object({
      manifestPath: webSourceLocationInputSchema.shape.manifest_path,
      scriptIndex: cliDecimalField(
        webSourceLocationInputSchema.shape.script_index.describe(
          "Zero-based manifest script index",
        ),
      ),
      sourceMapPath: sourceMapSelection.shape.path,
      sourceMapUrl: sourceMapSelection.shape.url,
      line: cliDecimalField(
        generatedPosition.shape.line.describe("One-based generated line"),
      ),
      column: cliDecimalField(
        generatedPosition.shape.column.describe(
          "Zero-based UTF-16 generated column",
        ),
      ),
    }),
    options: z.object({
      ...localSourceMapLimitCliOptions,
      ...analysisEvidenceDeliveryOptions,
      view: z
        .string()
        .optional()
        .describe(
          "JSON source-location matches/source-text view; requires --detail summary and --evidence_output",
        ),
      decodeTimeoutMs: cliDecimalField(
        webSourceLocationInputSchema.shape.decode_timeout_ms,
      ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.traceWebSourceLocation, async () => {
          const delivery = parseCliAnalysisEvidenceDelivery(
            "trace_web_source_location",
            options,
            webSourceLocationDeliverySchema,
          );
          if (!delivery.ok) return projectAnalysisError(delivery.error);
          return deliverCliAnalysisEvidence({
            run: () =>
              service.trace(
                {
                  manifest_path: args.manifestPath,
                  script_index: args.scriptIndex,
                  source_map: {
                    path: args.sourceMapPath,
                    url: args.sourceMapUrl,
                  },
                  generated_position: { line: args.line, column: args.column },
                  ...sourceMapLimitsFromCli(options),
                  ...(options.decodeTimeoutMs === undefined
                    ? {}
                    : { decode_timeout_ms: options.decodeTimeoutMs }),
                },
                { signal },
              ),
            service,
            providerId: "web-source-location",
            operation: "trace_web_source_location",
            signal,
            detail: delivery.value.detail,
            evidenceOutput: delivery.value.evidenceOutput,
            ...(delivery.value.view === undefined
              ? {}
              : { view: delivery.value.view }),
          });
        }),
      ),
  });
};
