import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { BinarySession } from "../src/application/BinarySession.js";
import type { AnalysisClient } from "../src/application/AnalysisProvider.js";
import { compareProcessEvidenceFiles } from "../src/application/ProcessCli.js";
import { PROCESS_PROVIDER } from "../src/application/ProcessEvidence.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../src/contracts/processCaptureExample.js";
import { createEvidence, parseEvidence } from "../src/domain/evidence.js";
import { jsonValueSchema } from "../src/domain/jsonValue.js";
import {
  compareProcessCaptures,
  processCaptureSchema,
} from "../src/domain/processCapture.js";
import type { ProcessTraceSpecification } from "../src/domain/processTraceComparison.js";
import { observed as ok } from "./fixtures/analysisExecution.js";
import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";
import { createServer } from "../src/server/createServer.js";

const resources: Array<{ close(): Promise<void> }> = [];
const temporaryRoots: string[] = [];
const beforeCheckpoint = {
  name: "before",
  at_ms: 0,
  files: [],
  effects: [],
  truncated: false,
};
const afterCheckpoint = {
  name: "after_settlement",
  at_ms: 50,
  files: [],
  effects: [],
  truncated: false,
};

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

const capture = {
  ...EMPTY_PROCESS_CAPTURE_EXAMPLE,
  event_journal: [
    { capture_order: 0, collection: "filesystem_checkpoints", index: 0 },
    { capture_order: 1, collection: "lifecycle", index: 0 },
    { capture_order: 2, collection: "lifecycle", index: 1 },
    { capture_order: 3, collection: "filesystem_checkpoints", index: 1 },
  ],
} as const;

const traceSpecification: ProcessTraceSpecification = {
  version: 1,
  events: [
    {
      id: "before",
      source: "filesystem",
      exact: beforeCheckpoint,
      cardinality: { kind: "required" },
    },
    {
      id: "exit",
      source: "lifecycle",
      exact: { event: "exit", ...capture.exit },
      cardinality: { kind: "required" },
    },
    {
      id: "settlement",
      source: "lifecycle",
      exact: { event: "settlement", ...capture.settlement },
      cardinality: { kind: "required" },
    },
    {
      id: "after",
      source: "filesystem",
      exact: afterCheckpoint,
      cardinality: { kind: "required" },
    },
  ],
  language: {
    kind: "finite_traces",
    variants: [
      {
        id: "normal",
        trace: ["before", "exit", "settlement", "after"],
      },
    ],
  },
};

const captureEvidence = (side: "left" | "right") =>
  createEvidence(undefined, PROCESS_PROVIDER, {
    predicateType: "rea.process-capture/v4",
    operation: "capture_process_scenario",
    parameters: { side },
    result: jsonValueSchema.parse(capture),
    confidence: "observed",
    authority: "controlled-replay",
    locations: [{ kind: "artifact-path", path: `/fixture/${side}` }],
  });

describe("declared trace comparison adapters", () => {
  it("treats only explicitly ignored schedule metadata as reorderable", () => {
    const httpPayload = {
      protocol: "http" as const,
      direction: "request" as const,
      method: "GET",
      path: "/status",
      data: "",
      outcome: "unmatched" as const,
    };
    const websocketPayload = {
      protocol: "websocket" as const,
      direction: "received" as const,
      method: null,
      path: "/ws",
      data: "done",
      outcome: "matched" as const,
    };
    const scheduledCapture = (order: "http-first" | "websocket-first") => {
      const protocolEvents =
        order === "http-first"
          ? [
              { sequence: 0, at_ms: 1, ...httpPayload },
              { sequence: 1, at_ms: 2, ...websocketPayload },
            ]
          : [
              { sequence: 0, at_ms: 1, ...websocketPayload },
              { sequence: 1, at_ms: 2, ...httpPayload },
            ];
      return processCaptureSchema.parse({
        ...capture,
        protocol_events: protocolEvents,
        event_journal: [
          {
            capture_order: 0,
            collection: "filesystem_checkpoints",
            index: 0,
          },
          { capture_order: 1, collection: "protocol_events", index: 0 },
          { capture_order: 2, collection: "protocol_events", index: 1 },
          { capture_order: 3, collection: "lifecycle", index: 0 },
          { capture_order: 4, collection: "lifecycle", index: 1 },
          {
            capture_order: 5,
            collection: "filesystem_checkpoints",
            index: 1,
          },
        ],
      });
    };
    const specification: ProcessTraceSpecification = {
      version: 1,
      events: [
        {
          id: "status",
          source: "http",
          exact: httpPayload,
          ignore_fields: ["sequence", "at_ms"],
          cardinality: { kind: "required" },
        },
        {
          id: "done",
          source: "websocket",
          exact: websocketPayload,
          ignore_fields: ["sequence", "at_ms"],
          cardinality: { kind: "required" },
        },
      ],
      language: {
        kind: "partial_order",
        happens_before: [],
        not_before: [],
        unordered_groups: [{ events: ["status", "done"] }],
        prefix: [],
        suffix: [],
      },
    };

    expect(
      compareProcessCaptures(
        scheduledCapture("http-first"),
        scheduledCapture("websocket-first"),
        { traceSpecification: specification },
      ),
    ).toMatchObject({
      status: "unchanged",
      protocol: "unchanged",
      trace: {
        verdict: "equivalent",
        left: { raw_trace: [{ event_id: "status" }, { event_id: "done" }] },
        right: { raw_trace: [{ event_id: "done" }, { event_id: "status" }] },
      },
    });
  });

  it("does not mask an unselected source in a covered legacy dimension", () => {
    const http = {
      sequence: 0,
      at_ms: 1,
      protocol: "http" as const,
      direction: "request" as const,
      method: "GET",
      path: "/status",
      data: "",
      outcome: "unmatched" as const,
    };
    const websocket = (data: string) => ({
      sequence: 1,
      at_ms: 2,
      protocol: "websocket" as const,
      direction: "received" as const,
      method: null,
      path: "/ws",
      data,
      outcome: "matched" as const,
    });
    const withProtocol = (data: string) =>
      processCaptureSchema.parse({
        ...capture,
        protocol_events: [http, websocket(data)],
        event_journal: [
          {
            capture_order: 0,
            collection: "filesystem_checkpoints",
            index: 0,
          },
          { capture_order: 1, collection: "protocol_events", index: 0 },
          { capture_order: 2, collection: "protocol_events", index: 1 },
          { capture_order: 3, collection: "lifecycle", index: 0 },
          { capture_order: 4, collection: "lifecycle", index: 1 },
          {
            capture_order: 5,
            collection: "filesystem_checkpoints",
            index: 1,
          },
        ],
      });
    const specification: ProcessTraceSpecification = {
      version: 1,
      events: [
        {
          id: "status",
          source: "http",
          exact: http,
          cardinality: { kind: "required" },
        },
      ],
      language: {
        kind: "finite_traces",
        variants: [{ id: "status", trace: ["status"] }],
      },
    };

    expect(
      compareProcessCaptures(withProtocol("left"), withProtocol("right"), {
        traceSpecification: specification,
      }),
    ).toMatchObject({
      status: "changed",
      protocol: "changed",
      trace: { verdict: "equivalent" },
    });
  });

  it("does not call identical captures changed when both violate the language", () => {
    const parsedCapture = processCaptureSchema.parse(capture);
    const specification: ProcessTraceSpecification = {
      ...traceSpecification,
      language: {
        kind: "finite_traces",
        variants: [
          {
            id: "reversed",
            trace: ["after", "settlement", "exit", "before"],
          },
        ],
      },
    };

    expect(
      compareProcessCaptures(parsedCapture, parsedCapture, {
        traceSpecification: specification,
      }),
    ).toMatchObject({
      status: "unchanged",
      trace: { verdict: "nonconforming" },
    });
  });

  it("returns identical CLI and MCP results and derived Evidence identity", async () => {
    const left = captureEvidence("left");
    const right = captureEvidence("right");
    const root = await createTestTempDirectory("rea-trace-adapters-");
    temporaryRoots.push(root);
    const leftPath = join(root, "left.json");
    const rightPath = join(root, "right.json");
    const specificationPath = join(root, "trace.json");
    await Promise.all([
      writeFile(leftPath, JSON.stringify(left)),
      writeFile(rightPath, JSON.stringify(right)),
      writeFile(specificationPath, JSON.stringify(traceSpecification)),
    ]);
    const cliEvidence = parseEvidence(
      await compareProcessEvidenceFiles(leftPath, rightPath, specificationPath),
    );

    const session = new BinarySession(
      (_path) =>
        ({
          execute: () => Promise.resolve(ok(null)),
          close: () => Promise.resolve(),
        }) satisfies AnalysisClient,
    );
    expect(session.recordEvidence(left).ok).toBe(true);
    expect(session.recordEvidence(right).ok).toBe(true);
    const server = createServer(
      { execute: () => Promise.resolve(ok(null)) },
      session,
    );
    const client = new Client({ name: "trace-parity", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    resources.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const response = await client.callTool({
      name: "compare_process_captures",
      arguments: {
        left_evidence_id: left.evidence_id,
        right_evidence_id: right.evidence_id,
        trace_spec: traceSpecification,
      },
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      result: { trace: { verdict: "equivalent" } },
      evidence_id: cliEvidence.evidence_id,
    });
    const structuredResult =
      typeof response.structuredContent === "object" &&
      response.structuredContent !== null
        ? Reflect.get(response.structuredContent, "result")
        : undefined;
    expect(structuredResult).toEqual(cliEvidence.normalized_result);
    expect(cliEvidence).toMatchObject({
      predicate_type: "rea.process-comparison/v4",
      locations: [
        { kind: "artifact-path", path: "/fixture/left" },
        { kind: "artifact-path", path: "/fixture/right" },
      ],
    });
  });
});
