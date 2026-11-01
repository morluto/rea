import { setImmediate } from "node:timers/promises";
import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { recordEvidenceSources } from "../../application/investigation/recordEvidenceSources.js";
import {
  inspectAnalysisViewValidated,
  requireAnalysisViewRetention,
} from "../../application/analysisView/AnalysisViewService.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";

import { traceApplicationFeatureEvidence } from "../../application/javascript/JavaScriptApplicationWorkflowService.js";
import { toolContract } from "../../contracts/toolContracts.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { recordApplicationResult, recordResult } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const traceContract = toolContract("trace_application_feature");

/** Register the provider-neutral JavaScript feature trace tool. */
export const registerTraceFeatureTool = (
  server: EvidenceMcpServer,
  options: ApplicationToolRegistration,
): void => {
  server.registerTool(
    traceContract.name,
    toolRegistrationOptions(traceContract),
    async ({ view, ...input }, context) =>
      runAdmittedToolOperation(
        server,
        options.withAdmittedAnalysis,
        traceContract.name,
        context.mcpReq.signal,
        async () => {
          // A selected view is meaningful only when the complete trace can be retained.
          if (view !== undefined) {
            const retention = requireAnalysisViewRetention(
              traceContract.name,
              options,
            );
            if (!retention.ok)
              return server.delivery.toCallToolResult(retention, traceContract);
          }
          const result = await logToolExecution(
            options.logger,
            traceContract.name,
            () =>
              Promise.resolve(
                traceApplicationFeatureEvidence(input, options.evidenceById, {
                  signal: context.mcpReq.signal,
                }),
              ),
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(result, traceContract);
          if (view === undefined) {
            const recorded = recordEvidenceSources(
              options.recordEvidence,
              result.value.sources,
            );
            if (!recorded.ok)
              return server.delivery.toCallToolResult(recorded, traceContract);
            return recordResult(
              { ...options, delivery: server.delivery },
              traceContract,
              result.value.evidence,
            );
          }
          const parent = result.value.evidence;
          // Stage the projection against the owned parent before committing any session facts.
          const selected = inspectAnalysisViewValidated(
            {
              source: {
                kind: "retained-evidence",
                evidence_id: parent.evidence_id,
              },
              view,
            },
            (id) =>
              id === parent.evidence_id ? parent : options.evidenceById?.(id),
          );
          await setImmediate();
          if (context.mcpReq.signal.aborted)
            return server.delivery.toErrorToolResult(
              new AnalysisCancelledError(traceContract.name, {
                cause: context.mcpReq.signal.reason,
              }),
              traceContract.returnsTargetContent,
            );
          if (!selected.ok)
            return server.delivery.toCallToolResult(selected, traceContract);
          const recorded = recordEvidenceSources(
            options.recordEvidence,
            result.value.sources,
          );
          if (!recorded.ok)
            return server.delivery.toCallToolResult(recorded, traceContract);
          const saved = recordApplicationResult(options, parent);
          if (saved !== undefined && !saved.ok)
            return server.delivery.toCallToolResult(saved, traceContract);
          return server.delivery.toEvidenceToolResult(
            selected.value,
            traceContract,
            options.recordEvidence?.(selected.value),
          );
        },
      ),
  );
};
