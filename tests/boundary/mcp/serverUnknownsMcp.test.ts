import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, expect, it } from "vitest";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import type {
  AnalysisClient,
  AnalysisProvider,
  CapabilityDescriptor,
} from "../../../src/application/AnalysisProvider.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { err, ok as resultOk } from "../../../src/domain/result.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";
import { createServer } from "../../../src/server/createServer.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../../../src/domain/process/processCaptureExample.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { PROCESS_PROVIDER } from "../../../src/domain/process/processEvidenceProvider.js";

import { processCaptureSchema } from "../../../src/domain/process/processCapture.js";
const resources: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async (resource) => resource.close()),
  );
});

const providerWithCapabilities = (
  operations: readonly CapabilityDescriptor["operation"][],
): AnalysisProvider => {
  const identity = { id: "fixture", name: "Fixture", version: "1" };
  const capabilities: readonly CapabilityDescriptor[] = operations.map(
    (operation) => ({
      provider: identity,
      operation,
      available: true,
      reason: null,
      pagination: "none",
      exhaustive: true,
      effects: {
        mutatesArtifact: false,
        launchesProcess: false,
        mayShowUi: false,
        mayAccessNetwork: false,
        mayWriteFilesystem: false,
        changesPermissions: false,
        requiresRoot: false,
      },
      limits: {
        maxResults: null,
        maxPayloadBytes: null,
        timeoutMs: null,
      },
      limitations: [],
    }),
  );
  return {
    identity: () => identity,
    capabilities: () => capabilities,
    createClient: () => ({
      execute: (operation) => {
        return Promise.resolve(
          err(
            new AnalysisCapabilityUnavailableError(
              "fixture",
              operation,
              "Decompiler is not installed.",
            ),
          ),
        );
      },
      close: () => Promise.resolve(resultOk(null)),
    }),
  };
};

const structured = (result: CallToolResult): Record<string, unknown> => {
  if (result.isError === true) return parseMcpToolError(result);
  if (
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null
  )
    throw new Error("missing structured result");
  return Object.fromEntries(Object.entries(result.structuredContent));
};

it("does not record capability unavailability without supporting Evidence", async () => {
  const session = createTestBinarySession(
    providerWithCapabilities(["procedure_pseudo_code"]),
  );
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "unavailable-unknown", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await client.callTool({
    name: "open_binary",
    arguments: { path: process.execPath },
  });

  const unavailable = await client.callTool({
    name: "procedure_pseudo_code",
    arguments: {
      procedure: "main",
    },
  });
  expect(unavailable.isError).toBe(true);
  expect(structured(unavailable)).toMatchObject({
    error: {
      category: "unavailable",
    },
  });
  expect(
    structured(await client.callTool({ name: "list_unknowns", arguments: {} })),
  ).toMatchObject({
    result: {
      items: [],
    },
  });
});

it("records capture disagreement as a contradicted unknown", async () => {
  const session = createTestBinarySession(
    () =>
      ({
        execute: () => Promise.resolve(ok(null)),
        close: () => Promise.resolve(resultOk(null)),
      }) satisfies AnalysisClient,
  );
  const left = processCaptureSchema.parse(EMPTY_PROCESS_CAPTURE_EXAMPLE);
  const right = processCaptureSchema.parse({
    ...EMPTY_PROCESS_CAPTURE_EXAMPLE,
    interaction_events: [
      {
        sequence: 0,
        scheduled_at_ms: 0,
        dispatched_at_ms: 0,
        type: "input",
        data: "fixture",
        outcome: "dispatched",
      },
    ],
  });
  const captureEvidence = (capture: typeof left) =>
    createEvidence(undefined, PROCESS_PROVIDER, {
      predicateType: "rea.process-capture",
      operation: "capture_process_scenario",
      parameters: {},
      result: jsonValueSchema.parse(capture),
      confidence: "observed",
      authority: "controlled-replay",
    });
  const leftEvidence = captureEvidence(left);
  const rightEvidence = captureEvidence(right);
  expect(session.recordEvidence(leftEvidence).ok).toBe(true);
  expect(session.recordEvidence(rightEvidence).ok).toBe(true);
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "comparison-unknown", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const mismatched = await client.callTool({
    name: "compare_process_captures",
    arguments: {
      left: {
        ...leftEvidence,
        normalized_result: rightEvidence.normalized_result,
      },
      right: rightEvidence,
    },
  });
  expect(mismatched.isError).toBe(true);

  const compared = await client.callTool({
    name: "compare_process_captures",
    arguments: {
      left: leftEvidence,
      right: rightEvidence,
    },
  });
  expect(compared.isError).not.toBe(true);
  const firstEvidence = parseEvidence(structured(compared));
  expect(
    structured(await client.callTool({ name: "list_unknowns", arguments: {} })),
  ).toMatchObject({
    result: {
      items: [
        {
          status: "contradicted",
          domain: "process-comparison",
          question: `Process captures disagree across: interaction (comparison ${firstEvidence.evidence_id})`,
          contradicting_evidence_ids: [rightEvidence.evidence_id],
        },
      ],
    },
  });
  const repeatedCapture = captureEvidence(
    processCaptureSchema.parse({
      ...right,
      interaction_events: right.interaction_events.map((event) => ({
        ...event,
        data: "second observation",
      })),
    }),
  );
  expect(session.recordEvidence(repeatedCapture).ok).toBe(true);
  const secondComparison = await client.callTool({
    name: "compare_process_captures",
    arguments: { left: leftEvidence, right: repeatedCapture },
  });
  expect(secondComparison.isError, JSON.stringify(secondComparison)).not.toBe(
    true,
  );
  const secondEvidence = parseEvidence(structured(secondComparison));
  expect(secondEvidence.normalized_result).toMatchObject({
    status: "changed",
    interaction: "added",
  });
  expect(secondEvidence.evidence_id).not.toBe(firstEvidence.evidence_id);

  const unknowns = session.listUnknowns({ domain: "process-comparison" });
  expect(unknowns).toHaveLength(2);
  expect(unknowns.map((unknown) => unknown.contradicting_evidence_ids)).toEqual(
    expect.arrayContaining([
      [rightEvidence.evidence_id],
      [repeatedCapture.evidence_id],
    ]),
  );
  const beforeRepeat = parseEvidenceBundle(
    structured(await client.callTool({ name: "get_evidence_bundle" })).result,
  );
  const repeatedComparison = await client.callTool({
    name: "compare_process_captures",
    arguments: { left: leftEvidence, right: repeatedCapture },
  });
  expect(repeatedComparison.isError).not.toBe(true);
  expect(parseEvidence(structured(repeatedComparison))).toEqual(secondEvidence);
  expect(
    parseEvidenceBundle(
      structured(await client.callTool({ name: "get_evidence_bundle" })).result,
    ),
  ).toEqual(beforeRepeat);
});
