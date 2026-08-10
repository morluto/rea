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
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/errors.js";
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
      inputContractVersion: 1,
      outputContractVersion: 1,
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

it("records approved trace truncation as a deduplicated residual unknown", async () => {
  const analysis: AnalysisOperationPort = {
    execute: () =>
      Promise.resolve(
        ok({
          items: [],
          offset: 0,
          limit: 500,
          total: 0,
          next_offset: null,
          has_more: false,
        }),
      ),
  };
  const session = createTestBinarySession(
    providerWithCapabilities([
      "list_strings",
      "list_procedures",
      "xrefs",
      "resolve_containing_procedure",
    ]),
  );
  const server = createServer(analysis, session);
  const client = new Client({ name: "unknown-workflow", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await client.callTool({
    name: "open_binary",
    arguments: { path: process.execPath },
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const traced = await client.callTool({
      name: "trace_feature",
      arguments: {
        query: "license",
        max_operations: 1,
        unknown_registry_approved: true,
      },
    });
    expect(traced.isError).not.toBe(true);
  }
  const listed = structured(
    await client.callTool({ name: "list_unknowns", arguments: {} }),
  );
  expect(listed).toMatchObject({
    result: {
      items: [
        {
          unknown: {
            status: "open",
            domain: "control-flow",
            question: "Investigation reached the operation budget.",
          },
        },
      ],
    },
  });
}, 10_000);

it("records approved typed capability unavailability without forwarding the flag", async () => {
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
      unknown_registry_approved: true,
    },
  });
  expect(unavailable.isError).toBe(true);
  expect(structured(unavailable)).toMatchObject({
    error: {
      category: "unsupported_provider",
    },
  });
  expect(received[0]).not.toHaveProperty("unknown_registry_approved");
  expect(
    structured(await client.callTool({ name: "list_unknowns", arguments: {} })),
  ).toMatchObject({
    result: {
      items: [
        {
          unknown: {
            domain: "analysis-capability",
            question:
              "The requested analysis is unavailable for the current target.",
            recommended_probes: [
              {
                rationale:
                  "Choose another analysis or target that can answer this question.",
              },
            ],
          },
        },
      ],
    },
  });
});

it("records approved capture disagreement as a contradicted unknown", async () => {
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
    shim_events: [
      {
        sequence: 0,
        at_ms: 0,
        command: "fixture",
        route_index: null,
        arguments: [],
        working_directory: "/tmp",
        outcome: "unmatched",
      },
    ],
  });
  const captureEvidence = (capture: typeof left) =>
    createEvidence(undefined, PROCESS_PROVIDER, {
      predicateType: "rea.process-capture/v4",
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
      left_evidence_id: leftEvidence.evidence_id,
      left: right,
      right_evidence_id: rightEvidence.evidence_id,
      right,
    },
  });
  expect(mismatched.isError).toBe(true);

  const compared = await client.callTool({
    name: "compare_process_captures",
    arguments: {
      left_evidence_id: leftEvidence.evidence_id,
      right_evidence_id: rightEvidence.evidence_id,
      unknown_registry_approved: true,
    },
  });
  expect(compared.isError).not.toBe(true);
  expect(
    structured(await client.callTool({ name: "list_unknowns", arguments: {} })),
  ).toMatchObject({
    result: {
      items: [
        {
          unknown: {
            status: "contradicted",
            domain: "process-comparison",
            question: "Process captures disagree across: interaction, shim",
            contradicting_evidence_ids: [rightEvidence.evidence_id],
          },
        },
      ],
    },
  });
});
