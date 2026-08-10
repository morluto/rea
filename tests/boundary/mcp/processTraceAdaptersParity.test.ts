import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import type { AnalysisClient } from "../../../src/application/AnalysisProvider.js";
import { compareProcessEvidenceFiles } from "../../../src/application/ProcessCli.js";
import { PROCESS_PROVIDER } from "../../../src/application/ProcessEvidence.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../../../src/contracts/processCaptureExample.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import type { ProcessTraceSpecification } from "../../../src/domain/processTraceComparison.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

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

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("declared trace adapter parity", () => {
  it("returns identical CLI and MCP results and Evidence identity", async () => {
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
    const session = createTestBinarySession(
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
    expect(cliEvidence.locations).toEqual([
      { kind: "artifact-path", path: "/fixture/left" },
      { kind: "artifact-path", path: "/fixture/right" },
    ]);
  });
});
