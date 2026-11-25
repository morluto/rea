import type { Logger } from "pino";

import {
  artifactComparisonSourceEvidence,
  compareArtifactEvidence,
  resolveArtifactComparisonSources,
} from "../application/artifacts/ArtifactComparisonEvidence.js";
import { ArtifactResourceScope } from "../resources/index.js";
import {
  inventoryArtifactPath,
  retainedInArtifactScope,
} from "../application/artifacts/ArtifactPathInspection.js";
import { SESSION_TOOL_CONTRACTS } from "../contracts/sessionToolContracts.js";
import { ARTIFACT_COMPARISON_PROVIDER } from "../domain/comparisonEvidenceIdentity.js";
import type { Evidence } from "../domain/evidence.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { publishCliAnalysisEvidence } from "./analysisEvidenceDelivery.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractDocumentCommand } from "./contractDocumentCommand.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import type { CliInstance } from "./types.js";

/** Compare artifact inventories through the same source owners and workflow as MCP. */
export const registerArtifactComparisonCommand = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void =>
  registerContractDocumentCommand(
    cli,
    logger,
    contractNamed(SESSION_TOOL_CONTRACTS, "compare_artifacts"),
    {
      description:
        'Compare two artifact inventories, including FIT and legacy uImage firmware components, named as {left, right}: complete Evidence, {kind:"evidence-file",path,evidence_id?}, or {kind:"path",path} to inventory a file or directory in place. Pass --evidence_output to publish the comparison and both source inventories as a canonical bundle. A one-shot command retains no session Evidence for retained-evidence references.',
      document: "Inline workflow JSON or JSON file path",
      // Evidence-file paths are resolved against the operator's working directory.
      callerPaths: [
        ["left", "path"],
        ["right", "path"],
      ],
      cliOptions: {
        evidence_output: localPathStringSchema
          .optional()
          .describe(
            "Save comparison Evidence and both source inventories as a canonical bundle; never overwrites.",
          ),
      },
    },
    async (document, { signal, operation, cliOptions }) => {
      const resources = new ArtifactResourceScope();
      let sourceEvidence: readonly Evidence[] = [];
      const result = await finishAnalysisCommand(
        async () => {
          const sources = await resolveArtifactComparisonSources(
            document,
            undefined,
            {
              signal,
              resources,
              inventoryPath: async (source, sourceSignal) => {
                const { createArtifactPathInspection } =
                  await import("../composition/binary.js");
                return inventoryArtifactPath(
                  createArtifactPathInspection(environment),
                  source,
                  sourceSignal,
                  retainedInArtifactScope(resources),
                );
              },
            },
          );
          if (!sources.ok) return sources;
          sourceEvidence = artifactComparisonSourceEvidence(sources.value);
          const compared = compareArtifactEvidence(sources.value);
          return compared.ok
            ? { ok: true as const, value: compared.value.evidence }
            : compared;
        },
        resources,
        ARTIFACT_COMPARISON_PROVIDER.id,
        operation,
        signal,
      );
      return publishCliAnalysisEvidence(result, {
        operation,
        signal,
        detail: "complete",
        evidenceOutput: cliOptions.evidence_output,
        sourceEvidence,
      });
    },
  );
