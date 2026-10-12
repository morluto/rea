import { createHash } from "node:crypto";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import {
  aotFixtureImage,
  engineFixtureImage,
  REFERENCE_HASH,
} from "../../src/flutter/FlutterBuild.fixture.js";
import {
  createFlutterApk,
  createDuplicateFlutterApk,
} from "../fixtures/flutterApk.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "CLI and stdio MCP retain Flutter identity, selected ABI and duplicate-member refusals",
  async ({ cli }) => {
    const image = aotFixtureImage();
    Buffer.from("Login\0").copy(image, 0x2300);
    const engine = engineFixtureImage({
      notes: Buffer.from(
        "040000000800000003000000474e55000123456789abcdef",
        "hex",
      ),
      prefix: Buffer.from(
        "040000000800000003000000474e55001111111111111111",
        "hex",
      ),
      labels: ["Android (test) clang version 9.0.8"],
    });
    const path = await createFlutterApk("selected target.apk", [
      { path: "lib/arm64-v8a/libapp.so", bytes: image },
      {
        path: "lib/arm64-v8a/libflutter.so",
        bytes: engine,
      },
      { path: "lib/x86_64/libapp.so", bytes: image },
      {
        path: "lib/x86_64/libflutter.so",
        bytes: engine,
      },
    ]);
    const { call } = await connectLocalToolsMcp();
    for (const [name, abi] of [
      ["identify_flutter_build", undefined],
      ["inspect_dart_aot", undefined],
      ["inspect_dart_aot", "x86_64"],
    ] as const) {
      const result = await cli.run({
        arguments: [
          name.replaceAll("_", "-"),
          path,
          "--json",
          ...(abi === undefined ? [] : ["--abi", abi]),
        ],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const evidence = toolContract(name).outputSchema.parse(result.json);
      const response = await call(name, {
        path,
        ...(abi === undefined ? {} : { abi }),
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const mcp = parseEvidence(response.structuredContent);
      expect(mcp.normalized_result).toEqual(evidence.normalized_result);
      expect(mcp.subject).toEqual(evidence.subject);
      expect(mcp.subject).toMatchObject({
        local_path: path,
        format: "apk",
        digest: { sha256: evidence.normalized_result.target.sha256 },
      });
      expect(mcp.evidence_id).toBe(evidence.evidence_id);
      if (name === "inspect_dart_aot") {
        expect(evidence.normalized_result).toMatchObject({
          abi: abi ?? "arm64-v8a",
          libapp: {
            coverage: "complete",
            snapshot_hash: REFERENCE_HASH,
            sha256: createHash("sha256").update(image).digest("hex"),
          },
          string_pool: {
            coverage: "complete",
            class_like_tokens: expect.arrayContaining(["Login"]),
          },
        });
      } else {
        const identified = toolContract(
          "identify_flutter_build",
        ).outputSchema.parse(result.json).normalized_result;
        expect(identified.coverage).toBe("complete");
        for (const abi of identified.abis) {
          expect(abi.libflutter).toMatchObject({
            build_id: "0123456789abcdef",
            build_id_candidates: ["0123456789abcdef"],
          });
        }
      }
    }
    const duplicate = await createDuplicateFlutterApk();
    for (const name of [
      "identify_flutter_build",
      "inspect_dart_aot",
    ] as const) {
      const result = await cli.run({
        arguments: [name.replaceAll("_", "-"), duplicate, "--json"],
      });
      expect(result.exitCode).toBe(1);
      const mcp = parseMcpToolError(await call(name, { path: duplicate }));
      expect(mcp.error).toEqual(result.json);
      expect(mcp.error).toMatchObject({
        code: "invalid_request",
        details: { issues: [{ message: expect.stringContaining(duplicate) }] },
      });
    }
  },
);

cliTest(
  "CLI and MCP retain unsupported snapshot kinds as partial evidence",
  async ({ cli }) => {
    const image = aotFixtureImage();
    for (const offset of [0x1000, 0x2000])
      image.writeBigUInt64LE(4n, offset + 12);
    const path = await createFlutterApk("unsupported-kind.apk", [
      { path: "lib/arm64-v8a/libapp.so", bytes: image },
    ]);
    const result = await cli.run({
      arguments: ["inspect-dart-aot", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_dart_aot").outputSchema.parse(
      result.json,
    );
    const { call } = await connectLocalToolsMcp();
    const response = await call("inspect_dart_aot", { path });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(parseEvidence(response.structuredContent).normalized_result).toEqual(
      evidence.normalized_result,
    );
    expect(evidence.normalized_result).toMatchObject({
      coverage: "partial",
      libapp: { coverage: "partial", snapshot_hash: REFERENCE_HASH },
      string_pool: { coverage: "complete" },
    });
    expect(
      evidence.normalized_result.libapp.sections
        .filter((section) => section.name.endsWith("Data"))
        .map((section) => section.kind),
    ).toEqual([4, 4]);
  },
);
