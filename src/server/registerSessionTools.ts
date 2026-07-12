import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { BinarySessionPort } from "../application/BinarySession.js";
import { SESSION_TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import { toCallToolResult } from "./toolResult.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { ok, type Result } from "../domain/result.js";
import type {
  ProcessCapture,
  ProcessExecutionPolicy,
  ProcessScenario,
} from "../domain/processCapture.js";
import { processScenarioSchema } from "../domain/processCapture.js";
import { captureProcessScenario } from "../application/ProcessHarness.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import {
  recordUnknownInputSchema,
  updateUnknownInputSchema,
} from "../domain/residualUnknown.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import {
  readEvidenceBundle,
  writeEvidenceBundle,
} from "../application/EvidenceBundleFiles.js";
import { UnknownRegistryError, type AnalysisError } from "../domain/errors.js";
import {
  DENY_EVIDENCE_FILE_POLICY,
  DENY_PROCESS_POLICY,
  PROCESS_PROVIDER,
} from "./sessionToolPolicies.js";
import { registerProcessComparisonTool } from "./registerProcessComparisonTool.js";
import { registerArtifactComparisonTool } from "./registerArtifactComparisonTool.js";
import { registerFunctionComparisonTool } from "./registerFunctionComparisonTool.js";
import { registerBundleComparisonTool } from "./registerBundleComparisonTool.js";
import { registerInvestigationTools } from "./registerInvestigationTools.js";

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
      question: `${residual.scope}: ${residual.reason}`,
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

const processEvidenceParameters = (
  scenario: ProcessScenario,
): Readonly<Record<string, JsonValue>> => ({
  executable_name: scenario.executable.split("/").at(-1) ?? scenario.executable,
  argument_count: scenario.arguments.length,
  event_count: scenario.events.length,
  filesystem_root_count: scenario.filesystem_roots.length,
  normalization: scenario.normalization,
});

interface ProcessToolRegistration {
  readonly server: McpServer;
  readonly session: BinarySessionPort;
  readonly logger: Logger;
  readonly processPolicy: ProcessExecutionPolicy;
  readonly captureContract: (typeof SESSION_TOOL_CONTRACTS)[5];
}

const registerProcessTools = ({
  server,
  session,
  logger,
  processPolicy,
  captureContract,
}: ProcessToolRegistration): void => {
  server.registerTool(
    captureContract.name,
    {
      description: captureContract.description,
      inputSchema: captureContract.inputSchema,
      outputSchema: captureContract.outputSchema,
      annotations: captureContract.annotations,
    },
    async (input, context) => {
      const scenario = processScenarioSchema.parse(input);
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
      if (!captured.ok) return toCallToolResult(captured, captureContract);
      const evidence = createEvidence(undefined, PROCESS_PROVIDER, {
        predicateType: "rea.process-capture/v2",
        operation: captureContract.name,
        parameters: processEvidenceParameters(scenario),
        result: jsonValueSchema.parse(captured.value),
        confidence: "observed",
        authority: "controlled-replay",
        environment: {
          id: `${process.platform}-${process.arch}`,
          platform: process.platform,
          architecture: process.arch,
          isolation: "process",
        },
        limitations: captured.value.limitations,
      });
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
}

const registerEvidenceTools = ({
  server,
  session,
  exportContract,
  importContract,
  filePolicy,
}: EvidenceToolRegistration): void => {
  server.registerTool(
    exportContract.name,
    {
      description: exportContract.description,
      inputSchema: exportContract.inputSchema,
      outputSchema: exportContract.outputSchema,
      annotations: exportContract.annotations,
    },
    async (input) => {
      const parsed = z
        .object({
          path: z.string().min(1).optional(),
          overwrite: z.boolean().default(false),
        })
        .parse(input);
      const bundle = session.exportEvidenceBundle();
      if (parsed.path === undefined)
        return toCallToolResult(ok(bundle), exportContract);
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
    {
      description: importContract.description,
      inputSchema: importContract.inputSchema,
      outputSchema: importContract.outputSchema,
      annotations: importContract.annotations,
    },
    async (input) => {
      const path = z.object({ path: z.string().min(1) }).parse(input).path;
      const loaded = await readEvidenceBundle(path, filePolicy);
      if (!loaded.ok) return toCallToolResult(loaded, importContract);
      const imported = session.importEvidenceBundle(loaded.value);
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
    {
      description: listContract.description,
      inputSchema: listContract.inputSchema,
      outputSchema: listContract.outputSchema,
      annotations: listContract.annotations,
    },
    (input) => {
      const filters = z
        .object({
          status: z
            .enum([
              "open",
              "investigating",
              "blocked",
              "contradicted",
              "resolved",
            ])
            .optional(),
          severity: z.enum(["low", "medium", "high", "critical"]).optional(),
          domain: z.string().trim().min(1).max(100).optional(),
        })
        .parse(input);
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
    {
      description: recordContract.description,
      inputSchema: recordContract.inputSchema,
      outputSchema: recordContract.outputSchema,
      annotations: recordContract.annotations,
    },
    (input) =>
      toCallToolResult(
        session.recordUnknown(recordUnknownInputSchema.parse(input)),
        recordContract,
      ),
  );
  server.registerTool(
    updateContract.name,
    {
      description: updateContract.description,
      inputSchema: updateContract.inputSchema,
      outputSchema: updateContract.outputSchema,
      annotations: updateContract.annotations,
    },
    (input) =>
      toCallToolResult(
        session.updateUnknown(updateUnknownInputSchema.parse(input)),
        updateContract,
      ),
  );
  server.registerTool(
    verifyContract.name,
    {
      description: verifyContract.description,
      inputSchema: verifyContract.inputSchema,
      outputSchema: verifyContract.outputSchema,
      annotations: verifyContract.annotations,
    },
    (input) => {
      const unknownId = z
        .object({ unknown_id: z.string().regex(/^unk_[a-f0-9]{64}$/u) })
        .parse(input).unknown_id;
      return toCallToolResult(
        session.verifyUnknownResolution(unknownId),
        verifyContract,
      );
    },
  );
};

const registerLifecycleTools = (
  server: McpServer,
  session: BinarySessionPort,
  logger: Logger,
  contracts: readonly [
    (typeof SESSION_TOOL_CONTRACTS)[0],
    (typeof SESSION_TOOL_CONTRACTS)[1],
    (typeof SESSION_TOOL_CONTRACTS)[2],
  ],
): void => {
  const [openContract, closeContract, statusContract] = contracts;
  server.registerTool(
    openContract.name,
    {
      description: openContract.description,
      inputSchema: openContract.inputSchema,
      outputSchema: openContract.outputSchema,
      annotations: openContract.annotations,
    },
    async (input, context) => {
      const parsed = z.object({ path: z.string().min(1) }).parse(input);
      const opened = await logToolExecution(logger, openContract.name, () =>
        session.open(parsed.path, { signal: context.mcpReq.signal }),
      );
      return opened.ok
        ? toCallToolResult(
            {
              ok: true,
              value: {
                path: opened.value.path,
                format: opened.value.format,
                kind: opened.value.kind,
                loaderArgs: [...opened.value.loaderArgs],
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
    {
      description: closeContract.description,
      inputSchema: closeContract.inputSchema,
      outputSchema: closeContract.outputSchema,
      annotations: closeContract.annotations,
    },
    async () =>
      toCallToolResult(
        await logToolExecution(logger, closeContract.name, () =>
          session.close(),
        ),
        closeContract,
      ),
  );
  server.registerTool(
    statusContract.name,
    {
      description: statusContract.description,
      inputSchema: statusContract.inputSchema,
      outputSchema: statusContract.outputSchema,
      annotations: statusContract.annotations,
    },
    () =>
      toCallToolResult({ ok: true, value: session.status() }, statusContract),
  );
};

/** Register MCP-only target lifecycle operations on a long-lived session. */
export interface SessionToolOptions {
  readonly processPolicy?: ProcessExecutionPolicy;
  readonly evidenceFilePolicy?: EvidenceFilePolicy;
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
  registerLifecycleTools(server, session, logger, [
    openContract,
    closeContract,
    statusContract,
  ]);
  registerEvidenceTools({
    server,
    session,
    exportContract,
    importContract,
    filePolicy: evidenceFilePolicy,
  });
  registerProcessTools({
    server,
    session,
    logger,
    processPolicy,
    captureContract,
  });
  registerProcessComparisonTool(server, session, compareContract);
  registerArtifactComparisonTool(server, session, compareArtifactsContract);
  registerFunctionComparisonTool(server, session, compareFunctionsContract);
  registerBundleComparisonTool(server, session, compareBundlesContract);
  registerInvestigationTools(server, session, [
    changedBehaviorContract,
    callPathContract,
    staticRuntimeContract,
    reconstructionContract,
  ]);
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
