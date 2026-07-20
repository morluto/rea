import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { BinarySessionPort } from "../application/BinarySession.js";
import {
  exportEvidenceBundleInputSchema,
  importEvidenceBundleInputSchema,
  listUnknownsInputSchema,
  SESSION_TOOL_CONTRACTS,
  verifyUnknownResolutionInputSchema,
} from "../contracts/toolContracts.js";
import { toCallToolResult } from "./toolResult.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  ProcessCapture,
  ProcessExecutionPolicy,
  ProcessScenario,
} from "../domain/processCapture.js";
import { processScenarioSchema } from "../domain/processCapture.js";
import { captureProcessScenario } from "../application/ProcessHarness.js";
import { processCapturePermissionRequest } from "../application/ProcessCapturePermission.js";
import type { Evidence } from "../domain/evidence.js";
import type { AnalysisSnapshot } from "../domain/analysisSnapshot.js";
import {
  recordUnknownInputSchema,
  updateUnknownInputSchema,
} from "../domain/residualUnknown.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import {
  readEvidenceBundle,
  writeEvidenceBundle,
} from "../application/EvidenceBundleFiles.js";
import {
  readAnalysisSnapshot,
  writeAnalysisSnapshot,
} from "../application/AnalysisSnapshotFiles.js";
import {
  AnalysisProtocolError,
  PermissionRequiredError,
  UnknownRegistryError,
  type AnalysisError,
} from "../domain/errors.js";
import {
  DENY_EVIDENCE_FILE_POLICY,
  DENY_PROCESS_POLICY,
} from "./sessionToolPolicies.js";
import { createProcessCaptureEvidence } from "../application/ProcessEvidence.js";
import { registerProcessComparisonTool } from "./registerProcessComparisonTool.js";
import { registerArtifactComparisonTool } from "./registerArtifactComparisonTool.js";
import { registerFunctionComparisonTool } from "./registerFunctionComparisonTool.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { safeParseToolInput } from "./toolInputValidation.js";
import { registerBundleComparisonTool } from "./registerBundleComparisonTool.js";
import { registerInvestigationTools } from "./registerInvestigationTools.js";
import {
  closeBinaryInputSchema,
  openBinaryInputSchema,
} from "../contracts/sessionLifecycleInputs.js";
import { registerSessionStatusTool } from "./registerSessionStatusTool.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import {
  authorizeProcessCaptureWithElicitation,
  type ProcessCaptureElicitation,
} from "./ProcessCaptureElicitation.js";
import { isInputRequiredResult } from "@modelcontextprotocol/server";

const permissionFailure = (
  failure: Awaited<ReturnType<PermissionAuthority["authorize"]>>,
): Result<never, AnalysisError> => {
  if (failure.ok)
    return err(new AnalysisProtocolError("Expected a denied permission"));
  return err(
    failure.error instanceof PermissionRequiredError
      ? failure.error
      : new AnalysisProtocolError(failure.error.message, {
          cause: failure.error,
        }),
  );
};

const recordProcessResidualUnknowns = (
  session: BinarySessionPort,
  scenario: ProcessScenario,
  evidence: Evidence,
  residuals: ProcessCapture["residual_unknowns"],
): Result<null, AnalysisError> => {
  if (scenario.unknown_registry_approved !== true) return ok(null);
  for (const residual of residuals) {
    const unknown = session.recordUnknown({
      approved: true,
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
  readonly processPolicy: ProcessExecutionPolicy;
  readonly captureContract: (typeof SESSION_TOOL_CONTRACTS)[5];
  readonly permissionAuthority?: PermissionAuthority;
  readonly processCaptureElicitation?: ProcessCaptureElicitation;
  readonly availabilityPolicy?: () => {
    readonly processCaptureEnabled: boolean;
    readonly evidenceFileRoots: number;
  };
}

const registerProcessTools = ({
  server,
  session,
  logger,
  processPolicy,
  captureContract,
  permissionAuthority,
  processCaptureElicitation,
}: ProcessToolRegistration): void => {
  server.registerTool(
    captureContract.name,
    toolRegistrationOptions(captureContract),
    async (input, context) => {
      const parsedInput = safeParseToolInput(
        processScenarioSchema,
        input,
        captureContract.name,
      );
      if (!parsedInput.ok)
        return toCallToolResult(parsedInput, captureContract);
      const scenario = parsedInput.value;
      if (permissionAuthority !== undefined) {
        const request = processCapturePermissionRequest(scenario);
        const authorized =
          processCaptureElicitation === undefined
            ? await permissionAuthority.authorize(request, "read")
            : await authorizeProcessCaptureWithElicitation(
                permissionAuthority,
                request,
                context,
                processCaptureElicitation,
              );
        if (isInputRequiredResult(authorized)) return authorized;
        if (!authorized.ok)
          return toCallToolResult(
            permissionFailure(authorized),
            captureContract,
          );
      }
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
        () =>
          captureProcessScenario(
            scenario,
            processPolicy,
            context.mcpReq.signal,
          ),
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
        scenario,
        evidence,
        captured.value.residual_unknowns,
      );
      if (!unknowns.ok) return toCallToolResult(unknowns, captureContract);
      return toCallToolResult(ok(evidence), captureContract);
    },
  );
};

interface EvidenceToolRegistration {
  readonly server: McpServer;
  readonly session: BinarySessionPort;
  readonly exportContract: (typeof SESSION_TOOL_CONTRACTS)[3];
  readonly importContract: (typeof SESSION_TOOL_CONTRACTS)[4];
  readonly filePolicy: EvidenceFilePolicy;
  readonly permissionAuthority?: PermissionAuthority;
}

const registerEvidenceTools = ({
  server,
  session,
  exportContract,
  importContract,
  filePolicy,
  permissionAuthority,
}: EvidenceToolRegistration): void => {
  server.registerTool(
    exportContract.name,
    toolRegistrationOptions(exportContract),
    async (input) => {
      const parsedInput = safeParseToolInput(
        exportEvidenceBundleInputSchema,
        input,
        exportContract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, exportContract);
      const parsed = parsedInput.value;
      const bundle = session.exportEvidenceBundle();
      if (parsed.path === undefined)
        return toCallToolResult(ok(bundle), exportContract);
      if (permissionAuthority !== undefined) {
        const authorized = await permissionAuthority.authorize(
          {
            capability: "evidence_write",
            roots: [parsed.path],
            executables: [],
            environment_names: [],
            network: "none",
            mount: false,
            operation_identity: `export_evidence:${parsed.path}`,
          },
          "write",
        );
        if (!authorized.ok)
          return toCallToolResult(
            permissionFailure(authorized),
            exportContract,
          );
      }
      const written = await writeEvidenceBundle(
        bundle,
        parsed.path,
        parsed.overwrite,
        filePolicy,
      );
      return written.ok
        ? toCallToolResult(
            ok({
              path: written.value.path,
              bytes: written.value.bytes,
              records: bundle.records.length,
            }),
            exportContract,
          )
        : toCallToolResult(written, exportContract);
    },
  );
  server.registerTool(
    importContract.name,
    toolRegistrationOptions(importContract),
    async (input) => {
      const parsedInput = safeParseToolInput(
        importEvidenceBundleInputSchema,
        input,
        importContract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, importContract);
      const path = parsedInput.value.path;
      if (permissionAuthority !== undefined) {
        const authorized = await permissionAuthority.authorize(
          {
            capability: "evidence_read",
            roots: [path],
            executables: [],
            environment_names: [],
            network: "none",
            mount: false,
            operation_identity: `import_evidence:${path}`,
          },
          "read",
        );
        if (!authorized.ok)
          return toCallToolResult(
            permissionFailure(authorized),
            importContract,
          );
      }
      const loaded = await readEvidenceBundle(path, filePolicy);
      if (!loaded.ok) return toCallToolResult(loaded, importContract);
      const imported = session.importEvidenceBundle(loaded.value);
      if (imported.ok && imported.value > 0) server.sendResourceListChanged();
      return imported.ok
        ? toCallToolResult(
            ok({
              imported: imported.value,
              total: session.exportEvidenceBundle().records.length,
            }),
            importContract,
          )
        : toCallToolResult(imported, importContract);
    },
  );
};

interface UnknownToolRegistration {
  readonly server: McpServer;
  readonly session: BinarySessionPort;
  readonly contracts: readonly [
    (typeof SESSION_TOOL_CONTRACTS)[14],
    (typeof SESSION_TOOL_CONTRACTS)[15],
    (typeof SESSION_TOOL_CONTRACTS)[16],
    (typeof SESSION_TOOL_CONTRACTS)[17],
  ];
}

const registerUnknownTools = ({
  server,
  session,
  contracts: [listContract, recordContract, updateContract, verifyContract],
}: UnknownToolRegistration): void => {
  server.registerTool(
    listContract.name,
    toolRegistrationOptions(listContract),
    (input) => {
      const parsedInput = safeParseToolInput(
        listUnknownsInputSchema,
        input,
        listContract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, listContract);
      const filters = parsedInput.value;
      return toCallToolResult(
        ok(
          session.listUnknowns({
            ...(filters.status === undefined ? {} : { status: filters.status }),
            ...(filters.severity === undefined
              ? {}
              : { severity: filters.severity }),
            ...(filters.domain === undefined ? {} : { domain: filters.domain }),
          }),
        ),
        listContract,
      );
    },
  );
  server.registerTool(
    recordContract.name,
    toolRegistrationOptions(recordContract),
    (input) => {
      const parsedInput = safeParseToolInput(
        recordUnknownInputSchema,
        input,
        recordContract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, recordContract);
      const recorded = session.recordUnknown(parsedInput.value);
      if (recorded.ok) server.sendResourceListChanged();
      return toCallToolResult(recorded, recordContract);
    },
  );
  server.registerTool(
    updateContract.name,
    toolRegistrationOptions(updateContract),
    (input) => {
      const parsedInput = safeParseToolInput(
        updateUnknownInputSchema,
        input,
        updateContract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, updateContract);
      const updated = session.updateUnknown(parsedInput.value);
      if (updated.ok) server.sendResourceListChanged();
      return toCallToolResult(updated, updateContract);
    },
  );
  server.registerTool(
    verifyContract.name,
    toolRegistrationOptions(verifyContract),
    (input) => {
      const parsedInput = safeParseToolInput(
        verifyUnknownResolutionInputSchema,
        input,
        verifyContract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, verifyContract);
      const unknownId = parsedInput.value.unknown_id;
      return toCallToolResult(
        session.verifyUnknownResolution(unknownId),
        verifyContract,
      );
    },
  );
};

interface LifecycleToolRegistration {
  readonly server: McpServer;
  readonly session: BinarySessionPort;
  readonly logger: Logger;
  readonly contracts: readonly [
    (typeof SESSION_TOOL_CONTRACTS)[0],
    (typeof SESSION_TOOL_CONTRACTS)[1],
    (typeof SESSION_TOOL_CONTRACTS)[2],
  ];
  readonly snapshotFilePolicy: EvidenceFilePolicy;
  readonly startedAt: string;
  readonly availabilityPolicy: () => {
    readonly processCaptureEnabled: boolean;
    readonly evidenceFileRoots: number;
    readonly browserObservationEnabled?: boolean;
    readonly electronObservationEnabled?: boolean;
    readonly javascriptReplayEnabled?: boolean;
    readonly managedRuntimeEnabled?: boolean;
  };
  readonly permissionAuthority?: PermissionAuthority;
}

const registerLifecycleTools = ({
  server,
  session,
  logger,
  contracts,
  snapshotFilePolicy,
  startedAt,
  availabilityPolicy,
  permissionAuthority,
}: LifecycleToolRegistration): void => {
  const [openContract, closeContract, statusContract] = contracts;
  server.registerTool(
    openContract.name,
    toolRegistrationOptions(openContract),
    async (input, context) => {
      const parsedInput = safeParseToolInput(
        openBinaryInputSchema,
        input,
        openContract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, openContract);
      const parsed = parsedInput.value;
      let snapshot: AnalysisSnapshot | undefined;
      if (parsed.snapshot_path !== undefined) {
        if (permissionAuthority !== undefined) {
          const authorized = await permissionAuthority.authorize(
            {
              capability: "snapshot_read",
              roots: [parsed.snapshot_path],
              executables: [],
              environment_names: [],
              network: "none",
              mount: false,
              operation_identity: `open_binary:snapshot:${parsed.snapshot_path}`,
            },
            "read",
          );
          if (!authorized.ok)
            return toCallToolResult(
              permissionFailure(authorized),
              openContract,
            );
        }
        const loaded = await readAnalysisSnapshot(
          parsed.snapshot_path,
          snapshotFilePolicy,
        );
        if (!loaded.ok) return toCallToolResult(loaded, openContract);
        snapshot = loaded.value;
      }
      const opened = await logToolExecution(logger, openContract.name, () =>
        session.open(parsed.path, {
          signal: context.mcpReq.signal,
          ...(parsed.provider_id === undefined
            ? {}
            : { providerId: parsed.provider_id }),
          ...(snapshot === undefined ? {} : { snapshot }),
        }),
      );
      if (opened.ok) server.sendToolListChanged();
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
  server.registerTool(
    closeContract.name,
    toolRegistrationOptions(closeContract),
    async (input) => {
      const parsedInput = safeParseToolInput(
        closeBinaryInputSchema,
        input,
        closeContract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, closeContract);
      const parsed = parsedInput.value;
      if (parsed.snapshot_path !== undefined) {
        if (permissionAuthority !== undefined) {
          const authorized = await permissionAuthority.authorize(
            {
              capability: "snapshot_write",
              roots: [parsed.snapshot_path],
              executables: [],
              environment_names: [],
              network: "none",
              mount: false,
              operation_identity: `close_binary:snapshot:${parsed.snapshot_path}`,
            },
            "write",
          );
          if (!authorized.ok)
            return toCallToolResult(
              permissionFailure(authorized),
              closeContract,
            );
        }
        const snapshot = session.exportAnalysisSnapshot();
        if (!snapshot.ok) return toCallToolResult(snapshot, closeContract);
        const written = await writeAnalysisSnapshot(
          snapshot.value,
          parsed.snapshot_path,
          parsed.overwrite,
          snapshotFilePolicy,
        );
        if (!written.ok) return toCallToolResult(written, closeContract);
        const closed = await logToolExecution(logger, closeContract.name, () =>
          session.close(),
        );
        if (closed.ok) server.sendToolListChanged();
        return closed.ok
          ? toCallToolResult(
              ok({
                path: written.value.path,
                bytes: written.value.bytes,
                entries: snapshot.value.entries.length,
              }),
              closeContract,
            )
          : toCallToolResult(closed, closeContract);
      }
      const closed = await logToolExecution(logger, closeContract.name, () =>
        session.close(),
      );
      if (closed.ok) server.sendToolListChanged();
      return toCallToolResult(closed, closeContract);
    },
  );
  registerSessionStatusTool({
    server,
    session,
    contract: statusContract,
    startedAt,
    availabilityPolicy,
  });
};

/** Register MCP-only target lifecycle operations on a long-lived session. */
export interface SessionToolOptions {
  readonly processPolicy?: ProcessExecutionPolicy;
  readonly evidenceFilePolicy?: EvidenceFilePolicy;
  readonly investigationInputRoots?: readonly string[];
  readonly analysisSnapshotFilePolicy?: EvidenceFilePolicy;
  readonly startedAt?: string;
  readonly permissionAuthority?: PermissionAuthority;
  readonly processCaptureElicitation?: ProcessCaptureElicitation;
  readonly artifactIntegrityContinueEnabled?: () => boolean;
  readonly availabilityPolicy?: () => {
    readonly processCaptureEnabled: boolean;
    readonly evidenceFileRoots: number;
    readonly browserObservationEnabled?: boolean;
    readonly electronObservationEnabled?: boolean;
    readonly javascriptReplayEnabled?: boolean;
    readonly managedRuntimeEnabled?: boolean;
  };
}

export const registerSessionTools = (
  server: McpServer,
  session: BinarySessionPort,
  logger: Logger,
  options: SessionToolOptions = {},
): void => {
  const processPolicy = options.processPolicy ?? DENY_PROCESS_POLICY;
  const evidenceFilePolicy =
    options.evidenceFilePolicy ?? DENY_EVIDENCE_FILE_POLICY;
  const analysisSnapshotFilePolicy =
    options.analysisSnapshotFilePolicy ?? DENY_EVIDENCE_FILE_POLICY;
  const [
    openContract,
    closeContract,
    statusContract,
    exportContract,
    importContract,
    captureContract,
    compareContract,
    compareArtifactsContract,
    compareFunctionsContract,
    compareBundlesContract,
    changedBehaviorContract,
    callPathContract,
    staticRuntimeContract,
    reconstructionContract,
    listUnknownContract,
    recordUnknownContract,
    updateUnknownContract,
    verifyUnknownContract,
  ] = SESSION_TOOL_CONTRACTS;
  registerLifecycleTools({
    server,
    session,
    logger,
    contracts: [openContract, closeContract, statusContract],
    snapshotFilePolicy: analysisSnapshotFilePolicy,
    startedAt: options.startedAt ?? new Date().toISOString(),
    availabilityPolicy:
      options.availabilityPolicy ??
      (() => ({
        processCaptureEnabled: processPolicy.enabled,
        evidenceFileRoots: evidenceFilePolicy.roots.length,
        browserObservationEnabled: false,
        electronObservationEnabled: false,
        javascriptReplayEnabled: false,
        managedRuntimeEnabled: false,
      })),
    ...(options.permissionAuthority === undefined
      ? {}
      : { permissionAuthority: options.permissionAuthority }),
  });
  registerEvidenceTools({
    server,
    session,
    exportContract,
    importContract,
    filePolicy: evidenceFilePolicy,
    ...(options.permissionAuthority === undefined
      ? {}
      : { permissionAuthority: options.permissionAuthority }),
  });
  registerProcessTools({
    server,
    session,
    logger,
    processPolicy,
    captureContract,
    ...(options.permissionAuthority === undefined
      ? {}
      : { permissionAuthority: options.permissionAuthority }),
    ...(options.processCaptureElicitation === undefined
      ? {}
      : { processCaptureElicitation: options.processCaptureElicitation }),
  });
  registerProcessComparisonTool(server, session, compareContract);
  registerArtifactComparisonTool(server, session, compareArtifactsContract);
  registerFunctionComparisonTool(server, session, compareFunctionsContract);
  registerBundleComparisonTool(
    server,
    session,
    compareBundlesContract,
    evidenceFilePolicy,
  );
  const investigationContracts = [
    changedBehaviorContract,
    callPathContract,
    staticRuntimeContract,
    reconstructionContract,
  ] as const;
  registerInvestigationTools(server, session, investigationContracts, {
    evidenceFiles: evidenceFilePolicy,
    inputRoots: options.investigationInputRoots ?? [],
    ...(options.artifactIntegrityContinueEnabled === undefined
      ? {}
      : {
          integrityContinueEnabled: options.artifactIntegrityContinueEnabled,
        }),
    ...(options.permissionAuthority === undefined
      ? {}
      : { permissionAuthority: options.permissionAuthority }),
  });
  registerUnknownTools({
    server,
    session,
    contracts: [
      listUnknownContract,
      recordUnknownContract,
      updateUnknownContract,
      verifyUnknownContract,
    ],
  });
};
