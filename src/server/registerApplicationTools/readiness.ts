import type { McpServer } from "@modelcontextprotocol/server";

import {
  evaluateReconstructionReadinessValidated,
  resolveReconstructionReadinessRequest,
} from "../../application/ReconstructionReadinessService.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import { reconstructionReadinessReportSchema } from "../../domain/reconstructionReadinessSchemas.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { toCallToolResult } from "../toolResult.js";
import { recordSources } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = applicationToolContract("evaluate_reconstruction_readiness");

/** Register deterministic public-contract reconstruction conformance. */
export const registerReconstructionReadinessTool = (
  server: McpServer,
  options: ApplicationToolRegistration,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input) => {
      const resolved = resolveReconstructionReadinessRequest(input);
      if (!resolved.ok) return toCallToolResult(resolved, contract);
      const result = await logToolExecution(options.logger, contract.name, () =>
        Promise.resolve(
          evaluateReconstructionReadinessValidated(resolved.value),
        ),
      );
      if (!result.ok) return toCallToolResult(result, contract);
      const recorded = recordSources(
        options.recordEvidence,
        resolved.value.evidence_bundle.records,
      );
      if (!recorded.ok) return toCallToolResult(recorded, contract);
      const recordedResult = options.recordEvidence?.(result.value);
      if (recordedResult !== undefined && !recordedResult.ok)
        return toCallToolResult(recordedResult, contract);
      const report = reconstructionReadinessReportSchema.parse(
        result.value.normalized_result,
      );
      const reportUri = `rea://evidence/${result.value.evidence_id}/reconstruction-readiness-report`;
      const projection = {
        schema: report.schema,
        schema_version: report.schema_version,
        report_id: report.report_id,
        source_digest: report.source_digest,
        report_digest: report.report_digest,
        status: report.status,
        summary: report.summary,
        metrics: report.metrics,
        report_resource_uri: reportUri,
      };
      return toCallToolResult({ ok: true, value: result.value }, contract, {
        evidenceResourcesAvailable: recordedResult !== undefined,
        evidenceResultProjection: projection,
        evidenceTextProjection: projection,
        resourceLinks: [
          {
            uri: reportUri,
            name: report.report_id,
            description: "Full deterministic reconstruction readiness report",
          },
        ],
      });
    },
  );
};
