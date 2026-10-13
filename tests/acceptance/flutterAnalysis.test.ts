import { createHash } from "node:crypto";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { flutterResultSchemas } from "../../src/domain/flutter/flutterBuildAnalysis.js";
import {
  aotFixtureImage,
  engineFixtureImage,
  REFERENCE_HASH,
  appendElfRanges,
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
      const complete = flutterResultSchemas[name].parse(
        evidence.normalized_result,
      );
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
        digest: { sha256: complete.target.sha256 },
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
    const complete = flutterResultSchemas.inspect_dart_aot.parse(
      evidence.normalized_result,
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
      complete.libapp.sections
        .filter((section) => section.name.endsWith("Data"))
        .map((section) => section.kind),
    ).toEqual([4, 4]);
  },
);

cliTest(
  "CLI and MCP qualify conflicting load mappings and bounded ELF notes",
  async ({ cli }) => {
    const note = Buffer.from(
      "040000000800000003000000474e55000123456789abcdef",
      "hex",
    );
    const engine = engineFixtureImage({
      notes: Buffer.concat([note, Buffer.alloc(2000)]),
    });
    const denseEngine = appendElfRanges(
      engine,
      "program",
      Array.from({ length: 2000 }, (_, index) => ({
        type: 4,
        offset: 0x400 + note.length + index,
        size: 1,
      })),
    );
    const { call } = await connectLocalToolsMcp();
    for (const conflict of [false, true]) {
      const image = appendElfRanges(aotFixtureImage(), "program", [
        {
          type: 1,
          address: 0x2010,
          offset: conflict ? 0x1010 : 0x2010,
          size: 4,
        },
      ]);
      const path = await createFlutterApk(`load-${String(conflict)}.apk`, [
        { path: "lib/x86_64/libapp.so", bytes: image },
        {
          path: "lib/x86_64/libflutter.so",
          bytes: conflict ? denseEngine : engine,
        },
      ]);
      for (const name of [
        "inspect_dart_aot",
        "identify_flutter_build",
      ] as const) {
        const result = await cli.run({
          arguments: [name.replaceAll("_", "-"), path, "--json"],
        });
        expect(result.exitCode, result.stderr).toBe(0);
        const evidence = toolContract(name).outputSchema.parse(result.json);
        const response = await call(name, { path });
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        const mcp = parseEvidence(response.structuredContent);
        expect(mcp.normalized_result).toEqual(evidence.normalized_result);
        expect(mcp.evidence_id).toBe(evidence.evidence_id);
        expect(mcp.subject).toEqual(evidence.subject);
        expect(mcp.limitations).toEqual(evidence.limitations);
        expect(evidence.normalized_result.coverage).toBe(
          conflict ? "partial" : "complete",
        );
        if (name === "inspect_dart_aot") {
          const facts = flutterResultSchemas[name].parse(
            evidence.normalized_result,
          );
          expect(facts.libapp.sections).toHaveLength(conflict ? 3 : 4);
          expect(facts.string_pool.coverage).toBe(
            conflict ? "partial" : "complete",
          );
          if (conflict) {
            expect(facts.string_pool.package_uris).toEqual([]);
            expect(evidence.limitations.join("\n")).toContain(
              "conflicting PT_LOAD",
            );
          }
        } else {
          const facts = flutterResultSchemas[name].parse(
            evidence.normalized_result,
          );
          expect(facts.abis[0]?.libflutter).toMatchObject({
            build_id: conflict ? null : "0123456789abcdef",
            build_id_candidates: ["0123456789abcdef"],
          });
          if (conflict)
            expect(evidence.limitations.join("\n")).toContain("note-range");
        }
      }
    }
  },
);
