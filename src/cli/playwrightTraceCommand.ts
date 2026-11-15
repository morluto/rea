import { z } from "incur";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { projectArtifactCloseFailure } from "../artifacts/StableArtifactFailure.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  PLAYWRIGHT_TRACE_OPERATION as operation,
  PLAYWRIGHT_TRACE_PROVIDER,
} from "../domain/playwrightTrace/playwrightTrace.js";
import { playwrightTraceViewRequestSchema } from "../domain/playwrightTrace/playwrightTraceQuery.js";
import { withCommandCancellation } from "./commandCancellation.js";
import {
  analysisEvidenceDeliveryOptions,
  parseCliAnalysisEvidenceDelivery,
  deliverCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";

const deliverySchema = z
  .object({
    detail: analysisEvidenceDeliveryOptions.detail,
    view: playwrightTraceViewRequestSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.view !== undefined && value.detail !== "summary")
      context.addIssue({
        code: "custom",
        path: ["view"],
        message:
          "A selected page requires --detail summary and --evidence_output.",
      });
  });

/** Standard one-shot publication keeps complete inventory Evidence for later offline pages. */
export const registerPlaywrightTraceCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectPlaywrightTrace, {
    description:
      "Inventory local saved Playwright v10 trace ZIP events offline without launching a browser",
    args: z.object({
      path: localPathStringSchema.describe("Local Playwright trace ZIP path"),
    }),
    options: z.object({
      ...analysisEvidenceDeliveryOptions,
      view: z
        .string()
        .optional()
        .describe(
          "JSON playwright-trace page; requires --detail summary and --evidence_output",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectPlaywrightTrace, async () => {
          const selected = parseCliAnalysisEvidenceDelivery(
            operation,
            options,
            deliverySchema,
          );
          if (!selected.ok) return projectAnalysisError(selected.error);
          const resources = new ArtifactResourceScope();
          const { PlaywrightTraceService } =
            await import("../application/playwrightTrace/PlaywrightTraceService.js");
          const { PlaywrightTraceDecoder } =
            await import("../browser/history/playwrightTrace/PlaywrightTraceDecoder.js");
          const service = new PlaywrightTraceService(
            new PlaywrightTraceDecoder(resources),
          );
          return deliverCliAnalysisEvidence({
            callerInputPath: args.path,
            run: () =>
              service.inspect(
                {
                  path: absoluteCallerPath(args.path),
                  detail: "complete",
                },
                signal,
              ),
            service: {
              close: () =>
                resources.close().catch((cause: unknown) => {
                  throw projectArtifactCloseFailure(
                    cause,
                    PLAYWRIGHT_TRACE_PROVIDER.id,
                    operation,
                  );
                }),
            },
            providerId: PLAYWRIGHT_TRACE_PROVIDER.id,
            operation,
            signal,
            detail: selected.value.detail,
            evidenceOutput: selected.value.evidenceOutput,
            ...(selected.value.view === undefined
              ? {}
              : { view: selected.value.view }),
          });
        }),
      ),
  });
};
