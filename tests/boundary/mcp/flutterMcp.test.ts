import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";

import type { FlutterBuildAnalysisPort } from "../../../src/application/flutter/FlutterBuildAnalysisPort.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

const identity = {
  id: "flutter",
  name: "Flutter build identification",
  version: null,
};

it("advertises an exact valid Flutter schema and records inline evidence through MCP", async () => {
  const provider: FlutterBuildAnalysisPort = {
    async inspectAvailability() {
      return { status: "available", code: null, reason: null, diagnostics: {} };
    },
    async close() {},
    async execute() {
      return ok(
        createAnalysisExecution(
          {
            target: {
              path: "/targets/gallery.apk",
              bytes: 117817550,
              sha256: "a".repeat(64),
            },
            flutter_detected: true,
            abis: [
              {
                abi: "arm64-v8a",
                libapp: {
                  present: true,
                  bytes: 24691632,
                  sha256: "b".repeat(64),
                  snapshot_hash_sources: 2,
                  snapshot_hash_candidates: [
                    "65817c30a78bb44c3dc3771876b6010a",
                  ],
                  snapshot_hash: "65817c30a78bb44c3dc3771876b6010a",
                },
                libflutter: {
                  present: true,
                  bytes: 9073432,
                  sha256: "c".repeat(64),
                  build_id: "e8d907ef7c175ec4313f47111019adc9588c5f61",
                  dart_version: null,
                  toolchain_lines: ["Android (5900059) clang version 9.0.8"],
                },
              },
            ],
            coverage: "complete",
          },
          identity,
        ),
      );
    },
  };
  const session = createTestBinarySession(() => {
    throw new Error("deep provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { flutterAnalysis: provider },
  );
  onTestFinished(() => server.close());
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "flutter-boundary", version: "0.0.0" });
  onTestFinished(() => client.close());
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toContain("identify_flutter_build");
  expect(tools.map((tool) => tool.name)).toContain("inspect_dart_aot");

  for (const name of ["identify_flutter_build", "inspect_dart_aot"] as const) {
    const contract = toolContract(name);
    const listed = tools.find((tool) => tool.name === name);
    expect(listed, name).toBeTruthy();
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    if (listed?.inputSchema !== undefined) {
      const validate = ajv.compile(
        JSON.parse(JSON.stringify(listed.inputSchema)),
      );
      for (const example of contract.examples)
        expect(validate(example.input), `${name} example`).toBe(true);
      expect(validate({ unknown_argument: true }), `${name} rejects`).toBe(
        false,
      );
    }
  }

  const identified = await client.callTool({
    name: "identify_flutter_build",
    arguments: { path: "/targets/gallery.apk" },
  });
  expect(identified.isError).not.toBe(true);
  const text = (identified.content as { readonly text?: string }[])
    .map((part) => part.text ?? "")
    .join("");
  const evidence = parseEvidence(JSON.parse(text));
  expect(evidence.normalized_result).toMatchObject({
    flutter_detected: true,
    abis: [
      {
        abi: "arm64-v8a",
        libapp: { snapshot_hash: "65817c30a78bb44c3dc3771876b6010a" },
      },
    ],
  });
});
