import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";

import { compareProcessEvidenceFiles } from "../../../src/application/process/ProcessCli.js";
import { PROCESS_PROVIDER } from "../../../src/application/process/ProcessEvidence.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../../../src/contracts/process/processCaptureExample.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { digestProcessCommitment } from "../../../src/domain/process/processCapture.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const captureEvidence = (
  side: "left" | "right",
  comparisonContract: Readonly<Record<string, string>> = {},
) =>
  createEvidence(undefined, PROCESS_PROVIDER, {
    predicateType: "rea.process-capture",
    operation: "capture_process_scenario",
    parameters: { side },
    result: jsonValueSchema.parse({
      ...EMPTY_PROCESS_CAPTURE_EXAMPLE,
      manifest: {
        ...EMPTY_PROCESS_CAPTURE_EXAMPLE.manifest,
        comparison_contract: comparisonContract,
        comparison_contract_sha256: digestProcessCommitment(comparisonContract),
      },
    }),
    confidence: "observed",
    authority: "controlled-replay",
  });

const left = captureEvidence("left", { working_directory: "/work/reference" });
const right = captureEvidence("right", {
  working_directory: "/work/reconstruction",
});

const connect = async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Process comparison must not launch a provider");
  });
  const server = createServer(session, session);
  const client = new Client({ name: "process-comparison-test", version: "1" });
  onTestFinished(async () => {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

it("names differing comparison contract fields through MCP and the CLI", async () => {
  const client = await connect();
  const response = await client.callTool({
    name: "compare_process_captures",
    arguments: { left, right },
  });
  expect(response.isError).toBe(true);
  const issue = {
    path: ["right"],
    reason: "invalid_value",
    message: expect.stringContaining(
      "these scenario fields differ: working_directory",
    ),
    expected: ["working_directory"],
  };
  expect(response.structuredContent).toMatchObject({
    error: { code: "invalid_request", details: { issues: [issue] } },
  });

  const root = await createTestTempDirectory("rea-process-contract-");
  const leftPath = join(root, "left.json");
  const rightPath = join(root, "right.json");
  await writeFile(leftPath, JSON.stringify(left));
  await writeFile(rightPath, JSON.stringify(right));
  expect(await compareProcessEvidenceFiles(leftPath, rightPath)).toMatchObject({
    error: "Process command failed",
    code: "invalid_request",
    details: { operation: "compare_process_captures", issues: [issue] },
  });
});

it("names the stale capture that exceeds max_capture_age_ms", async () => {
  const client = await connect();
  const response = await client.callTool({
    name: "compare_process_captures",
    arguments: {
      left: captureEvidence("left"),
      right: captureEvidence("right"),
      max_capture_age_ms: 1000,
    },
  });
  expect(response.isError).toBe(true);
  expect(response.structuredContent).toMatchObject({
    error: {
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["max_capture_age_ms"],
            reason: "out_of_range",
            message: expect.stringContaining(
              `left completed at ${EMPTY_PROCESS_CAPTURE_EXAMPLE.manifest.completed_at}`,
            ),
          },
        ],
      },
    },
  });
});

it("reports CLI trace specification issues like the MCP trace_spec input", async () => {
  const root = await createTestTempDirectory("rea-process-trace-spec-");
  const capturePath = join(root, "capture.json");
  const specPath = join(root, "spec.json");
  await writeFile(capturePath, JSON.stringify(captureEvidence("left")));
  await writeFile(specPath, JSON.stringify({ language: {} }));
  expect(
    await compareProcessEvidenceFiles(capturePath, capturePath, specPath),
  ).toMatchObject({
    code: "invalid_request",
    details: {
      operation: "compare_process_captures",
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["trace_spec", "events"] }),
      ]),
    },
  });
});

it("names the side and constraint when Evidence is not a usable capture", async () => {
  const client = await connect();
  const capture = captureEvidence("right");
  const unrelated = createEvidence(undefined, PROCESS_PROVIDER, {
    operation: "other",
    parameters: {},
    result: {},
  });
  const wrongKind = await client.callTool({
    name: "compare_process_captures",
    arguments: { left: unrelated, right: capture },
  });
  expect(wrongKind.structuredContent).toMatchObject({
    error: {
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["left"],
            reason: "invalid_value",
            message: expect.stringContaining(
              "the left Evidence has operation other",
            ),
          },
        ],
      },
    },
  });

  const tampered = await client.callTool({
    name: "compare_process_captures",
    arguments: {
      left: capture,
      right: { ...capture, parameters: { side: "changed" } },
    },
  });
  expect(tampered.structuredContent).toMatchObject({
    error: {
      code: "evidence_integrity_mismatch",
      message: expect.stringContaining(
        "The right Evidence failed validation (Evidence semantic identifier does not match its record)",
      ),
    },
  });

  const invalidResult = createEvidence(undefined, PROCESS_PROVIDER, {
    predicateType: "rea.process-capture",
    operation: "capture_process_scenario",
    parameters: {},
    result: { manifest: {} },
  });
  const malformed = await client.callTool({
    name: "compare_process_captures",
    arguments: { left: capture, right: invalidResult },
  });
  expect(malformed.structuredContent).toMatchObject({
    error: {
      code: "evidence_integrity_mismatch",
      message: expect.stringContaining(
        "The right Evidence has an invalid process capture result (at ",
      ),
    },
  });

  const root = await createTestTempDirectory("rea-process-malformed-");
  const leftPath = join(root, "left.json");
  const rightPath = join(root, "right.json");
  await writeFile(leftPath, JSON.stringify(capture));
  await writeFile(rightPath, JSON.stringify(invalidResult));
  expect(await compareProcessEvidenceFiles(leftPath, rightPath)).toMatchObject({
    category: "invalid_input",
    message: expect.stringContaining("Capture evidence is malformed (at "),
  });
});
