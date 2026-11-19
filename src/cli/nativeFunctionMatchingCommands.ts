import { z } from "zod";
import type { Logger } from "pino";
import { matchNativeFunctionsFromBundles } from "../application/native/NativeFunctionMatchingService.js";
import { ArtifactResourceScope } from "../resources/index.js";
import { SESSION_TOOL_CONTRACTS } from "../contracts/sessionToolContracts.js";
import { FUNCTION_COMPARISON_PROVIDER } from "../domain/comparisonEvidenceIdentity.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Evidence } from "../domain/evidence.js";
import {
  cliEvidenceDeliveryInputError,
  publishCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  admittedContractInput,
  registerContractDocumentCommand,
} from "./contractCommand.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import type { CliInstance } from "./types.js";
import { parseNativeMatchingAllowance } from "../config/nativeMatchingAllowance.js";
import { localPathStringSchema } from "../domain/localPath.js";

/** Resolve portable input bundles, then use the same read-only matching service as MCP. */
export const registerNativeFunctionMatchingCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void =>
  registerContractDocumentCommand(
    cli,
    logger,
    contractNamed(SESSION_TOOL_CONTRACTS, "match_native_functions"),
    {
      description:
        "Match two observed native function inventories without executing targets",
      document:
        "JSON or JSON file: left/right inventories, optional observations and detail",
      cliOptions: {
        source_bundle: z
          .array(localPathStringSchema)
          .default([])
          .describe(
            "Canonical source Evidence bundle for retained references; repeat for each input",
          ),
        evidence_output: localPathStringSchema
          .optional()
          .describe(
            "Save full matching Evidence and selected sources; required for default summary; never overwrites",
          ),
      },
    },
    async (_document, context) => {
      const { signal, operation, cliOptions } = context;
      const admitted = admittedContractInput(context);
      if (!admitted.ok) return projectAnalysisError(admitted.error);
      const input = admitted.value;
      const delivery = {
        providerId: FUNCTION_COMPARISON_PROVIDER.id,
        operation,
        signal,
        detail: input.detail,
        evidenceOutput: cliOptions.evidence_output,
      };
      const invalid = cliEvidenceDeliveryInputError(delivery);
      if (invalid !== undefined) return projectAnalysisError(invalid);
      const allowance = parseNativeMatchingAllowance(environment);
      if (!allowance.ok) return projectAnalysisError(allowance.error);
      const resources = new ArtifactResourceScope();
      let sources: readonly Evidence[] = [];
      const complete = await finishAnalysisCommand(
        async () => {
          const result = await matchNativeFunctionsFromBundles(
            input,
            cliOptions.source_bundle,
            resources,
            { signal, representationAllowance: allowance.value },
          );
          if (!result.ok) return result;
          sources = result.value.sources;
          return { ok: true as const, value: result.value.evidence };
        },
        resources,
        delivery.providerId,
        delivery.operation,
        signal,
      );
      return publishCliAnalysisEvidence(complete, {
        ...delivery,
        sourceEvidence: sources,
      });
    },
  );
