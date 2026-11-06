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
  apiContractViewSelectionSchema,
  apiContractFormatSchema,
  apiContractFileBytesSchema,
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
    view: apiContractViewSelectionSchema.optional(),
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
      "Inspect local OpenAPI JSON or GraphQL SDL declarations and field bindings offline",
    args: z.object({
      path: localPathStringSchema.describe(
        "Local OpenAPI JSON or GraphQL SDL path",
      ),
    }),
    options: z.object({
      ...analysisEvidenceDeliveryOptions,
      maxFileBytes: apiContractFileBytesSchema,
      contractFormat: apiContractFormatSchema
        .default("openapi-json")
        .describe("Input API contract syntax: OpenAPI JSON or GraphQL SDL"),
      operationsPath: localPathStringSchema
        .optional()
        .describe(
          "Local operation/fragment document, only with --contractFormat graphql-sdl",
        ),
      view: z
        .string()
        .optional()
        .describe(
          "JSON api-contract or graphql-contract page; requires --detail summary and --evidence_output",
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
            ...(options.operationsPath === undefined
              ? {}
              : {
                  callerInputPaths: { operations_path: options.operationsPath },
                }),
            run: () =>
              inspectApiContractEvidence(
                {
                  path: absoluteCallerPath(args.path),
                  format: options.contractFormat,
                  ...(options.operationsPath === undefined
                    ? {}
                    : {
                        operations_path: absoluteCallerPath(
                          options.operationsPath,
                        ),
                      }),
                  max_file_bytes: options.maxFileBytes,
                  detail: "complete",
                  ...(selected.value.view === undefined
                    ? {}
                    : { view: selected.value.view }),
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
