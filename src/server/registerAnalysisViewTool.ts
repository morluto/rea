import type { ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { analysisViewSourceSchema } from "../domain/analysisView/analysisViewRequest.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";

import { inspectAnalysisView } from "../application/analysisView/AnalysisViewService.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { runEvidenceToolOperation } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { applicationToolRegistrationOptions } from "./toolRegistrationOptions.js";

const viewInputSourceSchema = z.looseObject({
  source: analysisViewSourceSchema,
});

/**
 * The source overflow recovery may name again. An inline record cannot be
 * repeated within the response it just overflowed, so it has none.
 */
const viewSource = (input: unknown): JsonValue | undefined => {
  const parsed = viewInputSourceSchema.safeParse(input);
  return parsed.success && parsed.data.source.kind !== "inline"
    ? jsonValueSchema.parse(parsed.data.source)
    : undefined;
};

/** Bind selected-view projection to its named contract and session Evidence owner. */
export const registerAnalysisViewTool = (
  server: EvidenceMcpServer,
  logger: Logger,
  evidenceById?: EvidenceLookup,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
  artifactResources?: ArtifactResourceScope,
): void => {
  const contract = toolContract("inspect_analysis_view");
  const registration = applicationToolRegistrationOptions(contract);
  server.registerTool(
    contract.name,
    registration,
    (input: unknown, context: ServerContext) =>
      runEvidenceToolOperation(
        { server, logger, recordEvidence, withAdmittedAnalysis, viewSource },
        contract,
        undefined,
        { input, context },
        (selected, { signal }) =>
          inspectAnalysisView(selected, evidenceById, {
            signal,
            ...(artifactResources === undefined
              ? {}
              : { resources: artifactResources }),
          }),
      ),
  );
};
