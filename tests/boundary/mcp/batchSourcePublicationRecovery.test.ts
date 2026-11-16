import { unknownTarget } from "../../../src/domain/targetIdentity.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import pino from "pino";
import { expect, it, onTestFinished } from "vitest";
import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "../../../src/ports/AnalysisProvider.js";
import { EvidenceLedger } from "../../../src/application/investigation/EvidenceLedger.js";
import { InvestigationRecords } from "../../../src/application/investigation/InvestigationRecords.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { AnalysisResourceConstraintError } from "../../../src/domain/analysisErrorCore.js";
import { err, ok } from "../../../src/domain/result.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { withAdmittedAnalysis } from "../../../src/server/analysisAdmission.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { registerServiceTools } from "../../../src/server/serviceToolBindings.js";
import { recordsWorkflowSession } from "../../fixtures/workflowSession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
const provider = { id: "fixture", name: "Fixture", version: "1" };
const source = createEvidence(unknownTarget("not-observed"), provider, {
  operation: "health",
  parameters: {},
  result: "source",
});
it.each([
  { size: 100, denyAdmission: false },
  { size: 100_000, denyAdmission: false },
  { size: 100, denyAdmission: true },
])(
  "preserves capacity error with size $size and denied admission $denyAdmission",
  async ({ size, denyAdmission }) => {
    const ledger = new EvidenceLedger({ maximumRepresentationBytes: 0 });
    const record = (evidence: typeof source) => ledger.record(evidence);
    const analysis: AnalysisOperationPort = {
      execute: async (operation) => {
        return ok(
          createAnalysisExecution(
            operation === "procedure_address"
              ? "0x1000"
              : operation === "address_name"
                ? "example"
                : "x".repeat(size),
            provider,
            operation === "procedure_pseudo_code"
              ? { sourceEvidence: [source] }
              : {},
          ),
        );
      },
    };
    const server = new EvidenceMcpServer(
      { name: "batch-overflow", version: "1" },
      {},
      record,
      createToolResultDelivery(10 * 1024),
    );
    // Recovery admission has the default headroom unless denied; only the
    // ledger has none.
    const session = recordsWorkflowSession(new InvestigationRecords(), {
      recordEvidence: record,
      evidenceForAnalysis: (id) => ledger.forAnalysis(id),
      ...(denyAdmission
        ? {
            admitRecoveryObservation: () =>
              err(
                new AnalysisResourceConstraintError(
                  "batch_decompile",
                  "memory",
                  "no headroom",
                  null,
                ),
              ),
          }
        : {}),
    });
    registerServiceTools(
      server,
      { enhancedWorkflows: { session } },
      {
        logger: pino({ enabled: false }),
        recordEvidence: record,
        evidenceById: (id) => ledger.forAnalysis(id),
        withAdmittedAnalysis: withAdmittedAnalysis({ kind: "fixed", analysis }),
      },
    );
    const client = new Client(
      { name: "batch-overflow-test", version: "1" },
      { jsonSchemaValidator: createMcpSchemaValidation() },
    );
    onTestFinished(async () => {
      await client.close();
      await server.close();
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const response = await client.callTool({
      name: "batch_decompile",
      arguments: { addresses: ["example"] },
    });
    expect(response.isError).toBe(true);
    const error = parseMcpToolError(response).error;
    expect(error).toMatchObject({
      code: "resource_constraint",
      details: { partial_observation: { kind: "unretained-evidence" } },
    });
    if (denyAdmission)
      expect(error.details).toMatchObject({
        completed_observation_omitted: {
          reason: "insufficient-authentication-headroom",
          source_closure: "not-established",
        },
      });
    else if (size === 100)
      expect(error.details).toMatchObject({
        completed_observation: {
          kind: "unretained-evidence",
          source_closure: "not-established",
          evidence: { operation: "batch_decompile" },
        },
      });
    else
      expect(error.details).toMatchObject({
        completed_observation_omitted: {
          reason: "mcp-response-limit",
          source_closure: "not-established",
        },
      });
    expect(ledger.statistics().evidenceRecords).toBe(0);
  },
);
