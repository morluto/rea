import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  getNavigationContext,
  inspectAddressContext,
} from "../application/AnalysisContextQueries.js";
import { readAnalysisSnapshot } from "../application/binary/AnalysisSnapshotFiles.js";
import type { BinarySessionPort } from "../application/binary/BinarySession.js";
import { createProcessCaptureEvidence } from "../application/ProcessEvidence.js";
import { captureProcessScenario } from "../application/ProcessHarness.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { AnalysisSnapshot } from "../domain/analysisSnapshot.js";
import { UnknownRegistryError } from "../domain/unknownRegistryError.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import type { ProcessCapture } from "../domain/processCapture.js";
import { ok, type Result } from "../domain/result.js";
import type { Logger } from "../logger.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import { registerArtifactComparisonTool } from "./registerArtifactComparisonTool.js";
import { registerBundleComparisonTool } from "./registerBundleComparisonTool.js";
import { registerCloseLifecycleTool } from "./registerCloseLifecycleTool.js";
import { registerFunctionComparisonTool } from "./registerFunctionComparisonTool.js";
import { registerInvestigationTools } from "./registerInvestigationTools.js";
import { registerProcessComparisonTool } from "./registerProcessComparisonTool.js";
import {
  registerEvidenceTools,
  registerUnknownTools,
} from "./registerSessionRecordTools.js";
import { registerSessionStatusTool } from "./registerSessionStatusTool.js";
import {
  sessionAvailabilityPolicy,
  type SessionAvailability,
} from "./sessionAvailabilityPolicy.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

const recordProcessResidualUnknowns = (
  session: BinarySessionPort,
  evidence: Evidence,
  residuals: ProcessCapture["residual_unknowns"],
): Result<null, AnalysisError> => {
  for (const residual of residuals) {
    const unknown = session.recordUnknown({
      question: `Was ${residual.scope} behavior fully observed during capture?`,
      severity: "medium",
      domain: `process-${residual.scope}`,
      supporting_evidence_ids: [evidence.evidence_id],
      contradicting_evidence_ids: [],
      required_authority: "controlled-replay",
      required_confidence: "observed",
      required_environment: evidence.environment,
      recommended_probes: [
        {
          operation: "capture_process_scenario",
          rationale:
            "Repeat with a scenario that observes the missing behavior.",
        },
      ],
      relationships: [],
    });
    if (
      !unknown.ok &&
      !(
        unknown.error instanceof UnknownRegistryError &&
        unknown.error.reason === "already-exists"
      )
    )
      return unknown;
  }
  return ok(null);
};

interface ProcessToolRegistration {
  readonly server: McpServer;
  readonly session: BinarySessionPort;
  readonly logger: Logger;
  readonly captureContract: ReturnType<
    typeof toolContract<"capture_process_scenario">
  >;
}

const registerProcessTools = ({
  server,
  session,
  logger,
  captureContract,
}: ProcessToolRegistration): void => {
  server.registerTool(
    captureContract.name,
    toolRegistrationOptions(captureContract),
    async (input, context) => {
      const scenario = input;
      const progress = mcpProgressReporter(context);
      await progress.report({
        phase: captureContract.name,
        completed: 0,
        total: 1,
        message: "started",
      });
      const captured = await logToolExecution(
        logger,
        captureContract.name,
        () => captureProcessScenario(scenario, context.mcpReq.signal),
      );
      await progress.report({
        phase: captureContract.name,
        completed: 1,
        total: 1,
        message: captured.ok ? "completed" : "failed",
        terminal: true,
      });
      if (!captured.ok) return toCallToolResult(captured, captureContract);
      const evidence = createProcessCaptureEvidence(scenario, captured.value);
      const recorded = session.recordEvidence(evidence);
      if (!recorded.ok) return toCallToolResult(recorded, captureContract);
      const unknowns = recordProcessResidualUnknowns(
        session,
        evidence,
        captured.value.residual_unknowns,
      );
      if (!unknowns.ok) return toCallToolResult(unknowns, captureContract);
      return toCallToolResult(ok(evidence), captureContract);
    },
  );
};

export interface LifecycleToolRegistration {
  readonly server: McpServer;
  readonly session: BinarySessionPort;
  readonly logger: Logger;
  readonly openContract: ReturnType<typeof toolContract<"open_binary">>;
  readonly closeContract: ReturnType<typeof toolContract<"close_binary">>;
  readonly statusContract: ReturnType<typeof toolContract<"binary_session">>;
  readonly startedAt: string;
  readonly availabilityPolicy: () => SessionAvailability;
}

const registerLifecycleTools = (
  registration: LifecycleToolRegistration,
): void => {
  const { server, session, statusContract, startedAt, availabilityPolicy } =
    registration;
  registerOpenLifecycleTool(registration);
  registerCloseLifecycleTool(registration);
  registerSessionStatusTool({
    server,
    session,
    contract: statusContract,
    startedAt,
    availabilityPolicy,
  });
};

const registerOpenLifecycleTool = ({
  server,
  session,
  logger,
  openContract,
}: LifecycleToolRegistration): void => {
  server.registerTool(
    openContract.name,
    toolRegistrationOptions(openContract),
    async (input, context) => {
      let snapshot: AnalysisSnapshot | undefined;
      if (input.snapshot_path !== undefined) {
        const loaded = await readAnalysisSnapshot(input.snapshot_path);
        if (!loaded.ok) return toCallToolResult(loaded, openContract);
        snapshot = loaded.value;
      }
      const opened = await logToolExecution(logger, openContract.name, () =>
        session.open(input.path, {
          signal: context.mcpReq.signal,
          ...(input.format === undefined ? {} : { formatHint: input.format }),
          ...(input.provider_id === undefined
            ? {}
            : { providerId: input.provider_id }),
          ...(snapshot === undefined ? {} : { snapshot }),
        }),
      );
      return opened.ok
        ? toCallToolResult(
            {
              ok: true,
              value: {
                path: opened.value.path,
                format: opened.value.format,
                kind: opened.value.kind,
                loaderArgs: z
                  .array(z.string())
                  .parse(session.openCompatibility().loaderArgs ?? []),
                sha256: opened.value.sha256,
                architecture: opened.value.architecture ?? null,
              },
            },
            openContract,
          )
        : toCallToolResult(opened, openContract);
    },
  );
};

/** Register MCP-only target lifecycle operations on a long-lived session. */
export interface SessionToolOptions {
  readonly startedAt?: string;
  readonly availabilityPolicy?: () => SessionAvailability;
}

const registerContextTools = (
  server: McpServer,
  session: BinarySessionPort,
): void => {
  const navigationContract = toolContract("get_navigation_context");
  const addressContract = toolContract("inspect_address_context");
  server.registerTool(
    navigationContract.name,
    toolRegistrationOptions(navigationContract),
    async (input, context) => {
      return toCallToolResult(
        await getNavigationContext(session, input, context.mcpReq.signal),
        navigationContract,
      );
    },
  );
  server.registerTool(
    addressContract.name,
    toolRegistrationOptions(addressContract),
    async (input, context) => {
      return toCallToolResult(
        await inspectAddressContext(session, input, context.mcpReq.signal),
        addressContract,
      );
    },
  );
};

export const registerSessionTools = (
  server: McpServer,
  session: BinarySessionPort,
  logger: Logger,
  options: SessionToolOptions = {},
): void => {
  const openContract = toolContract("open_binary");
  const closeContract = toolContract("close_binary");
  const statusContract = toolContract("binary_session");
  const exportContract = toolContract("export_evidence_bundle");
  const importContract = toolContract("import_evidence_bundle");
  const captureContract = toolContract("capture_process_scenario");
  const compareContract = toolContract("compare_process_captures");
  const compareArtifactsContract = toolContract("compare_artifacts");
  const compareFunctionsContract = toolContract("compare_functions");
  const compareBundlesContract = toolContract("compare_bundles");
  const snapshotContract = toolContract("get_evidence_bundle");
  registerLifecycleTools({
    server,
    session,
    logger,
    openContract,
    closeContract,
    statusContract,
    startedAt: options.startedAt ?? new Date().toISOString(),
    availabilityPolicy: sessionAvailabilityPolicy(
      options.availabilityPolicy,
      {},
    ),
  });
  registerEvidenceTools({
    server,
    session,
    exportContract,
    importContract,
    snapshotContract,
  });
  registerProcessTools({
    server,
    session,
    logger,
    captureContract,
  });
  registerProcessComparisonTool(server, session, compareContract);
  registerArtifactComparisonTool(server, session, compareArtifactsContract);
  registerFunctionComparisonTool(server, session, compareFunctionsContract);
  registerBundleComparisonTool(server, session, compareBundlesContract);
  registerInvestigationTools(server, session);
  registerUnknownTools({ server, session });
  registerContextTools(server, session);
};
