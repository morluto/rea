import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import pino from "pino";
import { expect, it, onTestFinished } from "vitest";
import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "../../../src/application/AnalysisProvider.js";
import { EvidenceLedger } from "../../../src/application/investigation/EvidenceLedger.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { AnalysisResourceConstraintError } from "../../../src/domain/analysisErrorCore.js";
import { err, ok } from "../../../src/domain/result.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { registerEnhancedTools } from "../../../src/server/registerEnhancedTools.js";
import { withAdmittedAnalysis } from "../../../src/server/analysisAdmission.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
const provider = { id: "fixture", name: "Fixture", version: "1" };
const source = createEvidence(undefined, provider, {
  operation: "health",
  parameters: {},
  result: "source",
});
it.each([
  { size: 100, denyAdmission: false, ownerKnown: true },
  { size: 100_000, denyAdmission: false, ownerKnown: true },
  { size: 100, denyAdmission: true, ownerKnown: true },
  { size: 100, denyAdmission: false, ownerKnown: false },
])(
  "preserves capacity error with size $size, denied admission $denyAdmission, and known owner $ownerKnown",
  async ({ size, denyAdmission, ownerKnown }) => {
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
    registerEnhancedTools(server, {
      withAdmittedAnalysis: withAdmittedAnalysis({ kind: "fixed", analysis }),
      logger: pino({ enabled: false }),
      activeTarget: () => undefined,
      analysisProfile: undefined,
      recordEvidence: record,
      ...(ownerKnown ? { hasEvidence: (id: string) => ledger.has(id) } : {}),
      ...(denyAdmission
        ? {
            admitRecovery: () =>
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
      evidenceById: ownerKnown ? (id) => ledger.forAnalysis(id) : () => source,
      recordUnknown: undefined,
      allowsSnapshotReplay: undefined,
      recordWorkflowSnapshot: undefined,
    });
    const client = new Client({ name: "batch-overflow-test", version: "1" });
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
    else if (!ownerKnown)
      expect(error.details).toMatchObject({
        completed_observation: {
          kind: "inline-evidence",
          retention: "unknown",
          source_closure: "not-established",
          evidence: { operation: "batch_decompile" },
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
