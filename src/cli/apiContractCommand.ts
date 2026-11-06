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
  API_CONTRACT_OPERATION as operation,
  API_CONTRACT_PROVIDER,
} from "../domain/apiContract/apiContract.js";
import {
  apiContractViewRequestSchema,
  inspectApiContractInputSchema,
} from "../domain/apiContract/apiContractQuery.js";
import { withCommandCancellation } from "./commandCancellation.js";
import {
  analysisEvidenceDeliveryOptions,
  parseCliAnalysisEvidenceDelivery,
  deliverCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";

const deliverySchema = z
  .object({
    detail: analysisEvidenceDeliveryOptions.detail,
    view: apiContractViewRequestSchema.optional(),
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
export const registerApiContractCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectApiContract, {
    description:
      "Inventory local OpenAPI 3.0/3.1/3.2 JSON declarations offline without resolving references",
    args: z.object({
      path: localPathStringSchema.describe("Local OpenAPI JSON path"),
    }),
    options: z.object({
      ...analysisEvidenceDeliveryOptions,
      maxFileBytes: inspectApiContractInputSchema.shape.max_file_bytes,
      view: z
        .string()
        .optional()
        .describe(
          "JSON api-contract page; requires --detail summary and --evidence_output",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectApiContract, async () => {
          const selected = parseCliAnalysisEvidenceDelivery(
            operation,
            options,
            deliverySchema,
          );
          if (!selected.ok) return projectAnalysisError(selected.error);
          const resources = new ArtifactResourceScope();
          const { inspectApiContractEvidence } =
            await import("../application/apiContract/ApiContractService.js");
          return deliverCliAnalysisEvidence({
            callerInputPath: args.path,
            run: () =>
              inspectApiContractEvidence(
                {
                  path: absoluteCallerPath(args.path),
                  max_file_bytes: options.maxFileBytes,
                  detail: "complete",
                },
                resources,
                { signal },
              ),
            service: {
              close: () =>
                resources.close().catch((cause: unknown) => {
                  throw projectArtifactCloseFailure(
                    cause,
                    API_CONTRACT_PROVIDER.id,
                    operation,
                  );
                }),
            },
            providerId: API_CONTRACT_PROVIDER.id,
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
