import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { BinarySessionPort } from "../application/BinarySession.js";
import { SESSION_TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import { toCallToolResult } from "./toolResult.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { err, ok } from "../domain/result.js";
import { EvidenceLedgerError } from "../domain/errors.js";
import type { ProcessExecutionPolicy } from "../domain/processCapture.js";
import {
  compareProcessCaptures,
  processCaptureSchema,
  processScenarioSchema,
} from "../domain/processCapture.js";
import { captureProcessScenario } from "../application/ProcessHarness.js";
import { createEvidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";

const DENY_PROCESS_POLICY: ProcessExecutionPolicy = {
  enabled: false,
  executableRoots: [],
  workingRoots: [],
  allowedEnvironment: [],
};

const PROCESS_PROVIDER = {
  id: "rea-process",
  name: "REA deterministic process harness",
  version: "1",
} as const;

interface ProcessToolRegistration {
  readonly server: McpServer;
  readonly session: BinarySessionPort;
  readonly logger: Logger;
  readonly processPolicy: ProcessExecutionPolicy;
  readonly captureContract: (typeof SESSION_TOOL_CONTRACTS)[5];
  readonly compareContract: (typeof SESSION_TOOL_CONTRACTS)[6];
}

const registerProcessTools = ({
  server,
  session,
  logger,
  processPolicy,
  captureContract,
  compareContract,
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
        predicateType: "rea.process-capture/v1",
        operation: captureContract.name,
        parameters: {
          executable_name:
            scenario.executable.split("/").at(-1) ?? scenario.executable,
          argument_count: scenario.arguments.length,
          event_count: scenario.events.length,
          filesystem_root_count: scenario.filesystem_roots.length,
        },
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
      session.recordEvidence(evidence);
      return toCallToolResult(ok(evidence), captureContract);
    },
  );
  server.registerTool(
    compareContract.name,
    {
      description: compareContract.description,
      inputSchema: compareContract.inputSchema,
      outputSchema: compareContract.outputSchema,
      annotations: compareContract.annotations,
    },
    (input) => {
      const parsed = z
        .object({
          left_evidence_id: z.string(),
          left: processCaptureSchema,
          right_evidence_id: z.string(),
          right: processCaptureSchema,
        })
        .parse(input);
      const comparison = compareProcessCaptures(parsed.left, parsed.right);
      const evidence = createEvidence(undefined, PROCESS_PROVIDER, {
        predicateType: "rea.process-comparison/v1",
        operation: compareContract.name,
        parameters: {},
        result: jsonValueSchema.parse(comparison),
        confidence: "derived",
        authority: "analyst-inference",
        limitations: comparison.limitations,
        evidenceLinks: [parsed.left_evidence_id, parsed.right_evidence_id],
      });
      session.recordEvidence(evidence);
      return toCallToolResult(ok(evidence), compareContract);
    },
  );
};

interface EvidenceToolRegistration {
  readonly server: McpServer;
  readonly session: BinarySessionPort;
  readonly exportContract: (typeof SESSION_TOOL_CONTRACTS)[3];
  readonly importContract: (typeof SESSION_TOOL_CONTRACTS)[4];
}

const registerEvidenceTools = ({
  server,
  session,
  exportContract,
  importContract,
}: EvidenceToolRegistration): void => {
  server.registerTool(
    exportContract.name,
    {
      description: exportContract.description,
      inputSchema: exportContract.inputSchema,
      outputSchema: exportContract.outputSchema,
      annotations: exportContract.annotations,
    },
    () => toCallToolResult(ok(session.exportEvidenceBundle()), exportContract),
  );
  server.registerTool(
    importContract.name,
    {
      description: importContract.description,
      inputSchema: importContract.inputSchema,
      outputSchema: importContract.outputSchema,
      annotations: importContract.annotations,
    },
    (input) => {
      try {
        const bundle = z.object({ bundle: z.unknown() }).parse(input).bundle;
        const imported = session.importEvidenceBundle(bundle);
        return toCallToolResult(
          ok({
            imported,
            total: session.exportEvidenceBundle().records.length,
          }),
          importContract,
        );
      } catch (cause: unknown) {
        return toCallToolResult(
          err(
            new EvidenceLedgerError("Evidence bundle validation failed", {
              cause,
            }),
          ),
          importContract,
        );
      }
    },
  );
};

/** Register MCP-only target lifecycle operations on a long-lived session. */
export const registerSessionTools = (
  server: McpServer,
  session: BinarySessionPort,
  logger: Logger,
  processPolicy: ProcessExecutionPolicy = DENY_PROCESS_POLICY,
): void => {
  const [
    openContract,
    closeContract,
    statusContract,
    exportContract,
    importContract,
    captureContract,
    compareContract,
  ] = SESSION_TOOL_CONTRACTS;
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
  registerEvidenceTools({ server, session, exportContract, importContract });
  registerProcessTools({
    server,
    session,
    logger,
    processPolicy,
    captureContract,
    compareContract,
  });
};
