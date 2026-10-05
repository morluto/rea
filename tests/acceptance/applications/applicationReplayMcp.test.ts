import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import type { BinarySession } from "../../../src/application/BinarySession.js";
import type { JavaScriptReplayConfiguration } from "../../../src/application/JavaScriptReplayPlanning.js";
import { controlledReplayOutputSchema } from "../../../src/domain/javascriptReplay.js";
import { nodeCharacterizationPreparationOutputSchema } from "../../../src/domain/nodeRuntimeCharacterization.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";

function createReplayConfiguration(): JavaScriptReplayConfiguration {
  return {
    nodePath: process.execPath,
    bubblewrapPath: process.execPath,
    systemdRunPath: process.execPath,
    systemctlPath: process.execPath,
    shellPath: process.execPath,
  };
}

function createReplayScenario(root: string) {
  const configuration = createReplayConfiguration();
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(),
  }));
  const server = createServer(session, session, {
    availabilityPolicy: () => ({
      processCaptureEnabled: true,
      controlledReplayEnabled: true,
    }),
    javascriptReplayConfiguration: () => configuration,
    javascriptReplayHost: {
      readSource: async (path) => ({
        canonicalPath: await realpath(path),
        bytes: await readFile(path),
      }),
      identifyExecutable: async (path) => ({
        path,
        version: "fixture",
        sha256: "1".repeat(64),
      }),
      identifyWorker: async () => ({
        path: "/fixture/worker.js",
        version: "fixture-worker-1",
        sha256: "2".repeat(64),
      }),
      identifyRuntimeClosure: async (path) => [
        {
          sourcePath: path,
          destinationPath: "/runtime/node",
          sha256: "1".repeat(64),
        },
      ],
      seccompDigest: () => "3".repeat(64),
      probe: async () => undefined,
    },
    javascriptReplayRunner: {
      execute: async (prepared) => ({
        plan_digest: prepared.publicPlan.plan_digest,
        outcomes: [
          {
            case_id: "heading",
            outcome: "return",
            value: { type: "heading", text: "Title" },
            input_sha256:
              prepared.publicPlan.cases[0]?.sha256 ?? "0".repeat(64),
            output_sha256: "2".repeat(64),
            truncated: false,
          },
        ],
        stderr: "",
        termination: "completed",
        cleanup: { state: "complete", residual_resources: [] },
        limitations: ["fixture runner"],
        reproducer: null,
      }),
    },
  });
  const client = new Client({ name: "replay-parity-test", version: "1" });
  return { client, server, session };
}

function createReplayInput(root: string) {
  return {
    mode: "plan",
    left: {
      modules: [
        {
          alias: "parser",
          path: resolve(root, "parser.mjs"),
          format: "esm",
          role: "module",
          dependencies: {},
        },
      ],
      entry_alias: "parser",
      entry_export: "default",
    },
    cases: [{ case_id: "heading", arguments: ["# Title"] }],
  };
}

async function executeReplayScenario(
  client: Client,
  session: BinarySession,
  root: string,
) {
  const input = createReplayInput(root);
  const planned = await client.callTool({
    name: "run_controlled_replay",
    arguments: input,
  });
  expect(planned.isError).not.toBe(true);
  const digest = controlledReplayOutputSchema.parse(planned.structuredContent)
    .plan?.plan_digest;
  expect(digest).toMatch(/^[a-f0-9]{64}$/u);
  const executed = await client.callTool({
    name: "run_controlled_replay",
    arguments: {
      ...input,
      mode: "execute",
      plan_digest: digest,
    },
  });
  expect(executed.isError).not.toBe(true);
  expect(executed.structuredContent).toMatchObject({
    phase: "execute",
    evidence: {
      authority: "controlled-replay",
      provider: { id: "rea-javascript-replay" },
    },
  });
  expect(session.exportEvidenceBundle().records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ authority: "controlled-replay" }),
    ]),
  );
}

async function createCharacterizationInput(root: string) {
  const factoryPath = resolve(root, "sanitizer.factory.txt");
  const factoryBytes = await readFile(factoryPath);
  const factorySha256 = createHash("sha256").update(factoryBytes).digest("hex");
  return {
    selected_alias: "bundle",
    expected_effect: "pure",
    instrumentation: {
      artifact_path: factoryPath,
      artifact_sha256: factorySha256,
      selection: {
        byte_start: 0,
        byte_end: factoryBytes.byteLength,
        selected_sha256: factorySha256,
        export_name: "selected",
      },
    },
    replay: {
      mode: "plan",
      left: {
        modules: [
          {
            alias: "bundle",
            path: factoryPath,
            format: "commonjs-factory",
            role: "module",
            dependencies: {},
          },
        ],
        entry_alias: "bundle",
        entry_export: "selected",
      },
      cases: [{ case_id: "heading", arguments: ["# Title"] }],
    },
  };
}

async function executeCharacterizationScenario(
  client: Client,
  session: BinarySession,
  root: string,
) {
  const input = await createCharacterizationInput(root);
  const plan = await client.callTool({
    name: "prepare_node_characterization",
    arguments: input,
  });
  expect(plan.isError).not.toBe(true);
  const preparedPlan = nodeCharacterizationPreparationOutputSchema.parse(
    plan.structuredContent,
  ).plan;
  const characterized = await client.callTool({
    name: "execute_node_characterization",
    arguments: {
      plan_sha256: preparedPlan.plan_sha256,
      preparation: input,
    },
  });
  expect(characterized.isError).not.toBe(true);
  expect(characterized.structuredContent).toMatchObject({
    phase: "execution",
    evidence: {
      authority: "controlled-replay",
      provider: { id: "rea-node-characterization" },
    },
  });
  expect(session.exportEvidenceBundle().records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        predicate_type: "rea.javascript-export-transformation",
      }),
      expect.objectContaining({
        predicate_type: "rea.runtime-characterization",
      }),
    ]),
  );
}

describe("application workflow MCP parity", () => {
  it("plans and executes the same controlled replay contract", async () => {
    const root = resolve("tests/fixtures/replay");
    const { client, server, session } = createReplayScenario(root);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await executeReplayScenario(client, session, root);
      await executeCharacterizationScenario(client, session, root);
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  });
});
