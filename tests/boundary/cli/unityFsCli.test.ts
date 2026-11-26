import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { artifactComparisonResultSchema } from "../../../src/domain/artifactComparison.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { buildUnityFs } from "../../fixtures/unityfs.js";
import { cliTest } from "../../support/cli/cliFixture.js";

// Windows uses the native job launcher instead of Node's child_process.spawn.
cliTest.skipIf(process.platform === "win32").for([
  ["EAGAIN", { resource: "capacity", exhausted: "processes" }],
  ["ENOMEM", { resource: "capacity", exhausted: "memory" }],
  ["heap", { resource: "memory" }],
  ["exit", null],
] as const)(
  "reports a UnityFS worker %s failure consistently in CLI and MCP",
  async ([failure, constraint], { cli }) => {
    const root = await createTestTempDirectory("rea-unity-worker-failure-");
    const path = join(root, "bundle");
    const preload = join(root, "worker-failure.mjs");
    await writeFile(
      path,
      buildUnityFs([{ path: "CAB", data: "abc" }], { blockCompression: 1 }),
    );
    await writeFile(
      preload,
      `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const spawn = childProcess.spawn;
const failure = ${JSON.stringify(failure)};
childProcess.spawn = (command, args, options) => {
  if (args.at(-1) !== "--stdio" || !args.at(-2)?.endsWith("LzmaWorker.js"))
    return spawn(command, args, options);
  if (failure === "EAGAIN" || failure === "ENOMEM")
    throw Object.assign(new Error("controlled worker launch refusal"), {
      code: failure, syscall: "spawn " + command, path: command,
    });
  const diagnostic = failure === "heap"
    ? "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"
    : "controlled decoder exit";
  return spawn(command, ["-e", \`
    process.stdin.once("data", () =>
      process.stderr.write(\${JSON.stringify(diagnostic)} + "\\\\n", () => {
        process.exitCode = 1;
        process.stdin.destroy();
      }),
    );
  \`], options);
};
syncBuiltinESMExports();
`,
    );
    const environment = {
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    };
    const details =
      constraint === null
        ? {
            reason: "unavailable",
            detail: expect.stringContaining("controlled decoder exit"),
          }
        : {
            resource: constraint.resource,
            ...("exhausted" in constraint
              ? {
                  reported_limits: {
                    spawn_error: failure,
                    exhausted_resource: constraint.exhausted,
                  },
                  diagnostics: { system_code: failure },
                }
              : {
                  diagnostics: {
                    runtime_exhaustion_report: { runtime: "v8", area: "heap" },
                  },
                }),
          };
    const expected = {
      code:
        constraint === null
          ? "artifact_operation_failed"
          : "resource_constraint",
      category: constraint === null ? "unavailable" : "resource_constraint",
      details: { operation: "inspect_artifact", ...details },
    };
    const cliResult = await cli.run({
      arguments: ["inspect-artifact", path, "--json"],
      environment,
    });
    const { call } = await connectLocalToolsMcp(environment);
    expect((await call("open_binary", { path })).isError).not.toBe(true);
    const mcpResult = parseMcpToolError(await call("inspect_artifact", {}));
    await call("close_binary", {});
    expect(cliResult.exitCode, cliResult.stderr).toBe(1);
    expect(cliResult.json).toMatchObject(expected);
    expect(mcpResult.error).toMatchObject(expected);
  },
);

cliTest.for([
  "fixed header",
  "header padding",
  "directory",
  "payload",
] as const)(
  "rejects a UnityFS declaration excluding its %s",
  async (boundary, { cli }) => {
    const root = await createTestTempDirectory("rea-unity-extent-");
    const path = join(root, "bundle");
    const bytes = buildUnityFs([{ path: "payload.txt", data: "ORIGINAL" }], {
      blockCompression: 0,
      blocksInfoCompression: 0,
    });
    // The fixture's fixed tail starts at 32; its format-8 header is padded to 64.
    const declaredSize = {
      "fixed header": 16,
      "header padding": 63,
      directory: 64 + bytes.readUInt32BE(40) - 1,
      payload: bytes.length - 1,
    }[boundary]!;
    bytes.writeBigUInt64BE(BigInt(declaredSize), 32);
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-artifact", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.json).toMatchObject({
      code: "unsupported_target",
      details: { path, failure_kind: "malformed", format: "unityfs" },
    });
  },
);

cliTest.for([false, true])(
  "keeps the declared UnityFS inventory and payload with an appended replacement directory (footer: %s)",
  async (blocksInfoAtEnd, { cli }) => {
    const root = await createTestTempDirectory("rea-unity-trailer-");
    const path = join(root, "bundle");
    const payload = Buffer.from("ORIGINAL");
    const options = {
      blocksInfoAtEnd,
      blockCompression: 0,
      blocksInfoCompression: 0,
    };
    const original = buildUnityFs(
      [{ path: "payload.txt", data: payload }],
      options,
    );
    const replacement = buildUnityFs([{ path: "outside.txt", data: payload }], {
      ...options,
      blocksInfoAtEnd: true,
    });
    const directory = replacement.subarray(
      replacement.length - replacement.readUInt32BE(40),
    );
    await writeFile(path, Buffer.concat([original, directory]));
    const inspected = await cli.run({
      arguments: ["inspect-artifact", path, "--json"],
    });
    expect(inspected.exitCode, inspected.stderr).toBe(0);
    const inventory = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    ).substeps[0]!.evidence.normalized_result;
    expect(inventory.occurrences.map((entry) => entry.logical_path)).toEqual([
      ".",
      "payload.txt",
    ]);
    expect(inventory.occurrences[0]!.format_metadata).toMatchObject({
      declared_size: original.length,
    });
    const outputRoot = join(root, "extracted");
    const extracted = await cli.run({
      arguments: [
        "extract-artifact",
        path,
        "--output-root",
        outputRoot,
        "--json",
      ],
    });
    expect(extracted.exitCode, extracted.stderr).toBe(0);
    expect(
      (await readFile(join(outputRoot, "payload.txt"))).equals(payload),
    ).toBe(true);
  },
);

cliTest.for([1, 3] as const)(
  "inspects and extracts UnityFS with virtual coordinates and retained unavailable members (codec: %s)",
  async (blockCompression, { cli, onTestFinished }) => {
    const root = await createTestTempDirectory("rea-unity-cli-");
    const path = join(root, "bundle");
    const payload = Buffer.from("serialized bytes");
    await writeFile(
      path,
      buildUnityFs([{ path: "data..bin", data: payload, flags: 4 }], {
        blockCompression,
      }),
    );
    const inspected = await cli.run({
      arguments: ["inspect-artifact", path, "--json"],
    });
    expect(inspected.exitCode, inspected.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    );
    const inventory = inspection.substeps[0]!.evidence.normalized_result;
    expect(inventory.occurrences).toContainEqual(
      expect.objectContaining({
        logical_path: "data..bin",
        source_location: null,
        hash_status: "verified",
        format_metadata: {
          kind: "unityfs-entry",
          index: 0,
          source_path: "data..bin",
          declared_offset: 0,
          flags: 4,
        },
      }),
    );
    expect(inventory.nodes).toContainEqual(
      expect.objectContaining({
        sha256: createHash("sha256").update(payload).digest("hex"),
      }),
    );
    const extracted = await cli.run({
      arguments: ["extract-artifact", path, "--json"],
    });
    expect(extracted.exitCode, extracted.stderr).toBe(0);
    const output = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.json).normalized_result,
    );
    onTestFinished(() =>
      rm(output.output_root, { recursive: true, force: true }),
    );
    expect(
      (await readFile(join(output.output_root, "data..bin"))).equals(payload),
    ).toBe(true);

    await writeFile(
      path,
      buildUnityFs([{ path: "CAB-unsupported", data: payload }], {
        blockCompression: 4,
      }),
    );
    const unavailable = await cli.run({
      arguments: ["inspect-artifact", path, "--json"],
    });
    expect(unavailable.exitCode, unavailable.stderr).toBe(0);
    const partial = artifactInspectionResultSchema.parse(
      parseEvidence(unavailable.json).normalized_result,
    ).substeps[0]!.evidence.normalized_result;
    expect(partial.coverage).toMatchObject({ status: "unknown" });
    expect(partial.occurrences).toContainEqual(
      expect.objectContaining({
        logical_path: "CAB-unsupported",
        hash_status: "unavailable",
        artifact_id: null,
      }),
    );
    expect(partial.limitations.join(" ")).toContain(
      "compression 4 is unsupported",
    );
  },
);

cliTest(
  "keeps an unsafe declared uint64 size unknown in desktop header facts",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-unity-desktop-");
    await mkdir(join(root, "assets"));
    const bytes = buildUnityFs([{ path: "CAB", data: "bytes" }]);
    bytes.writeBigUInt64BE(2n ** 53n + 1n, 32);
    await writeFile(join(root, "assets", "content.bundle"), bytes);
    const result = await cli.run({
      arguments: ["inspect-desktop-application", root, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(parseEvidence(result.json).normalized_result).toMatchObject({
      files: expect.arrayContaining([
        expect.objectContaining({
          path: "assets/content.bundle",
          ranges: [{ offset: 0, bytes: 64, sha256: expect.any(String) }],
          facts: expect.arrayContaining([
            expect.objectContaining({
              kind: "unityfs-header",
              value: expect.objectContaining({ declared_size: null }),
            }),
          ]),
        }),
      ]),
    });
  },
);

cliTest(
  "retains the same UnityFS header facts when the version strings extend past the desktop prefix",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-unity-desktop-header-");
    const assets = join(root, "assets");
    await mkdir(assets);
    const engineVersion = "2022.3.1f1";
    const bytes = buildUnityFs([{ path: "CAB", data: Buffer.alloc(3_000) }], {
      playerVersion: "game-player-build-" + "x".repeat(72),
      engineVersion,
      blockCompression: 0,
    });
    const path = join(assets, "content.bundle");
    await writeFile(path, bytes);
    const inventory = await cli.run({
      arguments: ["inspect-artifact", path, "--json"],
    });
    expect(inventory.exitCode, inventory.stderr).toBe(0);
    const artifact = artifactInspectionResultSchema.parse(
      parseEvidence(inventory.json).normalized_result,
    ).substeps[0]!.evidence.normalized_result;
    const facts = {
      format_version: 8,
      engine_version: engineVersion,
      declared_size: bytes.length,
    };
    expect(artifact.occurrences[0]!.format_metadata).toMatchObject(facts);

    const scan = await cli.run({
      arguments: ["inspect-desktop-application", root, "--json"],
    });
    expect(scan.exitCode, scan.stderr).toBe(0);
    expect(parseEvidence(scan.json).normalized_result).toMatchObject({
      files: expect.arrayContaining([
        expect.objectContaining({
          path: "assets/content.bundle",
          facts: expect.arrayContaining([
            expect.objectContaining({
              kind: "unityfs-header",
              value: expect.objectContaining(facts),
            }),
          ]),
          ranges: expect.arrayContaining([
            expect.objectContaining({ offset: 0, bytes: 64 }),
            expect.objectContaining({ offset: 64, bytes: 2_016 }),
          ]),
        }),
      ]),
    });
  },
);

cliTest(
  "compares decoded UnityFS LZMA members against an LZ4 bundle without unknown hashes",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-unity-lzma-compare-");
    const leftPath = join(root, "left.bundle");
    const rightPath = join(root, "right.bundle");
    await writeFile(
      leftPath,
      buildUnityFs(
        [
          { path: "same.bin", data: "unchanged" },
          { path: "changed.bin", data: "old payload" },
        ],
        { blockCompression: 1 },
      ),
    );
    await writeFile(
      rightPath,
      buildUnityFs(
        [
          { path: "same.bin", data: "unchanged" },
          { path: "changed.bin", data: "new payload" },
        ],
        { blockCompression: 3 },
      ),
    );
    const left = await cli.run({
      arguments: [
        "inspect-artifact",
        leftPath,
        "--detail",
        "complete",
        "--json",
      ],
    });
    const right = await cli.run({
      arguments: [
        "inspect-artifact",
        rightPath,
        "--detail",
        "complete",
        "--json",
      ],
    });
    expect(left.exitCode, left.stderr).toBe(0);
    expect(right.exitCode, right.stderr).toBe(0);
    const request = join(root, "compare.json");
    await writeFile(
      request,
      JSON.stringify({
        left: parseEvidence(left.json),
        right: parseEvidence(right.json),
      }),
    );
    const compared = await cli.run({
      arguments: ["compare-artifacts", request, "--json"],
    });
    expect(compared.exitCode, compared.stderr).toBe(0);
    expect(
      artifactComparisonResultSchema.parse(
        parseEvidence(compared.json).normalized_result,
      ),
    ).toMatchObject({
      status: "changed",
      summary: { unknown: 0, unchanged: 1, changed: 2 },
      changes: expect.arrayContaining([
        expect.objectContaining({
          classification: "changed",
          logical_path: "changed.bin",
        }),
      ]),
    });
  },
);
