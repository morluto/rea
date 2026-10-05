import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, expect, it } from "vitest";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import type {
  AnalysisClient,
  AnalysisOperationPort,
  AnalysisProvider,
  CapabilityDescriptor,
} from "../../../src/application/AnalysisProvider.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { err } from "../../../src/domain/result.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";
import { createServer } from "../../../src/server/createServer.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { processCaptureSchema } from "../../../src/domain/processCapture.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../../../src/contracts/processCaptureExample.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { PROCESS_PROVIDER } from "../../../src/server/sessionToolPolicies.js";

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
      execute: () => Promise.resolve(ok(null)),
      close: () => Promise.resolve(),
    }),
  };
};

const structured = (result: CallToolResult): Record<string, unknown> => {
  if (
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null
  )
    throw new Error("missing structured result");
  return Object.fromEntries(Object.entries(result.structuredContent));
};

it("does not record capability unavailability without supporting Evidence", async () => {
  const received: Array<Readonly<Record<string, unknown>>> = [];
  const analysis: AnalysisOperationPort = {
    execute: (name, arguments_) => {
      received.push(arguments_);
      return Promise.resolve(
        err(
          new AnalysisCapabilityUnavailableError(
            "partial",
            name,
            "Decompiler is not installed.",
          ),
        ),
      );
    },
  };
  const session = createTestBinarySession(
    providerWithCapabilities(["procedure_pseudo_code"]),
  );
  const server = createServer(analysis, session);
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
      category: "unsupported_provider",
    },
  });
  expect(received[0]).toMatchObject({ procedure: "main" });
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
        close: () => Promise.resolve(),
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
  const server = createServer(
    { execute: () => Promise.resolve(ok(null)) },
    session,
  );
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
  expect(
    structured(await client.callTool({ name: "list_unknowns", arguments: {} })),
  ).toMatchObject({
    result: {
      items: [
        {
          status: "contradicted",
          domain: "process-comparison",
          question: "Process captures disagree across: interaction",
          contradicting_evidence_ids: [rightEvidence.evidence_id],
        },
      ],
    },
  });
});
