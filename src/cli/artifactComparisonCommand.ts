import type { Logger } from "pino";

import {
  compareArtifactEvidence,
  resolveArtifactComparisonSources,
} from "../application/artifacts/ArtifactComparisonEvidence.js";
import { ArtifactResourceScope } from "../resources/index.js";
import { SESSION_TOOL_CONTRACTS } from "../contracts/sessionToolContracts.js";
import { ARTIFACT_COMPARISON_PROVIDER } from "../domain/comparisonEvidenceIdentity.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractDocumentCommand } from "./contractCommand.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import type { CliInstance } from "./types.js";

/** Compare artifact inventories through the same source owners and workflow as MCP. */
export const registerArtifactComparisonCommand = (
  cli: CliInstance,
  logger: Logger,
): void =>
  registerContractDocumentCommand(
    cli,
    logger,
    contractNamed(SESSION_TOOL_CONTRACTS, "compare_artifacts"),
    {
      description:
        'Compare two artifact inventories, including FIT and legacy uImage firmware components, named as {left, right}: complete Evidence or {kind:"evidence-file",path,evidence_id?}. A one-shot command retains no session Evidence for retained-evidence references.',
      document: "Inline workflow JSON or JSON file path",
      // Evidence-file paths are resolved against the operator's working directory.
      callerPaths: [
        ["left", "path"],
        ["right", "path"],
      ],
    },
    async (document, { signal, operation }) => {
      const resources = new ArtifactResourceScope();
      const result = await finishAnalysisCommand(
        async () => {
          const sources = await resolveArtifactComparisonSources(
            document,
            undefined,
            { signal, resources },
          );
          if (!sources.ok) return sources;
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
      return result.ok
        ? result.value
        : { error: "Application workflow failed", ...result.error };
    },
  );
