import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";

import type { FlutterBuildAnalysisPort } from "../../../src/application/flutter/FlutterBuildAnalysisPort.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { assertAdvertisedMcpContracts } from "./mcpContractHarness.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

const identity = {
  id: "flutter",
  name: "Flutter build identification",
  version: null,
};

const SNAPSHOT_HASH = "65817c30a78bb44c3dc3771876b6010a";

/** One shared target identity for both fake operation results. */
const target = {
  path: "/targets/gallery.apk",
  bytes: 117817550,
  sha256: "a".repeat(64),
};

const inspectExecution = () =>
  createAnalysisExecution(
    {
      target,
      abi: "arm64-v8a",
      libapp: {
        coverage: "complete",
        bytes: 24691632,
        sha256: "b".repeat(64),
        snapshot_hash: SNAPSHOT_HASH,
        snapshot_hash_candidates: [SNAPSHOT_HASH],
        snapshot_hash_sources: 2,
        sections: [
          {
            name: "_kDartVmSnapshotData",
            offset: 4096,
            size: 52,
            magic_valid: true,
            kind: 3,
            header_length: 48,
          },
          {
            name: "_kDartIsolateSnapshotData",
            offset: 8192,
            size: 1536,
            magic_valid: true,
            kind: 3,
            header_length: 48,
          },
        ],
      },
      string_pool: {
        coverage: "complete",
        package_uris: [
          "package:adaptive_breakpoints/src/adaptive_breakpoints.dart",
        ],
        package_uri_count_at_least: 1,
        dart_uris: ["dart:_http"],
        dart_uri_count_at_least: 1,
        class_like_tokens: ["AdaptiveBreakpoint"],
        class_like_token_count_at_least: 1,
        printable_run_count: 4,
      },
      coverage: "complete",
    },
    identity,
  );

const identifyExecution = () =>
  createAnalysisExecution(
    {
      target,
      flutter_detected: true,
      abis: [
        {
          abi: "arm64-v8a",
          libapp: {
            present: true,
            bytes: 24691632,
            sha256: "b".repeat(64),
            elf_header_valid: true,
            snapshot_hash_sources: 2,
            snapshot_hash_candidates: [SNAPSHOT_HASH],
            snapshot_hash: SNAPSHOT_HASH,
          },
          libflutter: {
            present: true,
            bytes: 9073432,
            sha256: "c".repeat(64),
            build_id: "e8d907ef7c175ec4313f47111019adc9588c5f61",
            build_id_candidates: ["e8d907ef7c175ec4313f47111019adc9588c5f61"],
            dart_version: null,
            dart_version_capped: false,
            toolchain_lines: ["Android (5900059) clang version 9.0.8"],
            toolchain_capped: false,
          },
        },
      ],
      coverage: "complete",
    },
    identity,
  );

/** A recording-free provider answering both Flutter operations inline. */
const fakeProvider = (): FlutterBuildAnalysisPort => ({
  async inspectAvailability() {
    return { status: "available", code: null, reason: null, diagnostics: {} };
  },
  async close() {},
  async execute(request) {
    return ok(
      request.operation === "inspect_dart_aot"
        ? inspectExecution()
        : identifyExecution(),
    );
  },
});

it("advertises an exact valid Flutter schema and records inline evidence through MCP", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("deep provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { flutterAnalysis: fakeProvider() },
  );
  onTestFinished(() => server.close());
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "flutter-boundary", version: "0.0.0" });
  onTestFinished(() => client.close());
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  assertAdvertisedMcpContracts(
    ["identify_flutter_build", "inspect_dart_aot"],
    tools,
  );

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
        libapp: { snapshot_hash: SNAPSHOT_HASH },
      },
    ],
  });

  const inspected = await client.callTool({
    name: "inspect_dart_aot",
    arguments: { path: "/targets/gallery.apk", abi: "arm64-v8a" },
  });
  expect(inspected.isError).not.toBe(true);
  const inspectedText = (inspected.content as { readonly text?: string }[])
    .map((part) => part.text ?? "")
    .join("");
  const inspectedEvidence = parseEvidence(JSON.parse(inspectedText));
  expect(inspectedEvidence.normalized_result).toMatchObject({
    abi: "arm64-v8a",
    libapp: {
      snapshot_hash: SNAPSHOT_HASH,
      snapshot_hash_candidates: [SNAPSHOT_HASH],
      snapshot_hash_sources: 2,
    },
  });
});
