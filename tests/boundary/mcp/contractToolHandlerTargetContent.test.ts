import { describe, expect, it } from "vitest";

import type {
  CallToolResult,
  ServerContext,
} from "@modelcontextprotocol/server";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import type { Evidence } from "../../../src/domain/evidence.js";
import { err, ok } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";
import { createEvidenceToolHandler } from "../../../src/server/contractToolHandler.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";

const UNTRUSTED_TARGET_CONTENT = {
  provenance: { untrusted_content: true, source: "analysis_target" },
};

const context = {
  mcpReq: { signal: new AbortController().signal },
} as ServerContext;

/**
 * Deliver one retained partial-observation failure through the shared Evidence
 * handler. The handler is the producer of the result: `EvidenceMcpServer` only
 * adds the marker later for results that bypass `ToolResultDelivery`, so a
 * missing marker here also undercounts the wire budget by the marker's bytes.
 */
const deliverPartialFailure = async (): Promise<{
  readonly result: CallToolResult;
  readonly evidence: Evidence;
}> => {
  const evidence = createEvidence(
    undefined,
    { id: "fixture", name: "Completed capture fixture", version: "1" },
    {
      operation: "inspect_packet_capture",
      parameters: { path: "recording.pcap" },
      result: { packets: [{ "frame.number": ["1"] }] },
      confidence: "observed",
    },
  );
  const failure = new AnalysisCancelledError("inspect_packet_capture", {
    partialObservation: evidence,
  });
  const writer = { recordEvidence: () => ok("added" as const) };
  const server = new EvidenceMcpServer(
    { name: "partial-error-framing-test", version: "1" },
    { capabilities: {} },
    writer.recordEvidence,
    new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
  );
  const contract = toolContract("inspect_packet_capture");
  const handler = createEvidenceToolHandler(
    server,
    async () => err(failure),
    silentLogger,
    writer.recordEvidence,
  );
  return {
    result: await handler(contract)({ path: "recording.pcap" }, context),
    evidence,
  };
};

describe("shared Evidence handler target-content framing", () => {
  it("marks a retained partial-observation error as untrusted target content", async () => {
    const { result, evidence } = await deliverPartialFailure();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        details: {
          partial_observation: {
            kind: "retained-evidence",
            evidence_id: evidence.evidence_id,
          },
        },
      },
    });
    expect(result._meta).toEqual(UNTRUSTED_TARGET_CONTENT);
  });
});
