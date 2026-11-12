import { createHash } from "node:crypto";
import { constants as bufferConstants } from "node:buffer";
import { lstat, readFile, writeFile } from "node:fs/promises";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect } from "vitest";

import {
  bunModuleGraphPayload,
  elfAppendedBunPayload,
} from "../../src/artifacts/bun/BunStandalone.fixture.js";
import { dotnetBundleFixture } from "../../src/artifacts/dotnet/DotnetBundle.fixture.js";
import { nodeSeaElf } from "../../src/artifacts/nodeSea/NodeSea.fixture.js";
import type { ArtifactReaderLimitsInput } from "../../src/domain/artifactReaderLimits.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../src/domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { buildGodotPck } from "../fixtures/godotPck.js";
import { workspaceCliTest as test } from "../support/cli/workspaceCliFixture.js";

const digest = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const readInspection = (value: unknown) => {
  const evidence = parseEvidence(value);
  const result = artifactInspectionResultSchema.parse(
    evidence.normalized_result,
  );
  const source = result.substeps.find(
    (step) => step.operation === "inventory_artifact",
  )?.evidence;
  if (source === undefined) throw new Error("Missing inventory Evidence");
  return {
    evidence,
    source,
    inventory: artifactInventoryResultSchema.parse(source.normalized_result),
  };
};

interface ReaderCase {
  readonly format: string;
  readonly create: () => Buffer | Promise<Buffer>;
  readonly lower: ArtifactReaderLimitsInput;
  readonly raised: ArtifactReaderLimitsInput;
  readonly parameter: string;
  readonly value: number;
}

const readers: readonly ReaderCase[] = [
  {
    format: "bun-standalone",
    create: () =>
      elfAppendedBunPayload(
        bunModuleGraphPayload({
          modules: [
            {
              name: "/first.js",
              contents: Buffer.from("export const first=1;"),
            },
            {
              name: "/second.js",
              contents: Buffer.from("export const second=2;"),
            },
          ],
        }),
      ),
    lower: { bun: { module_count: 1 } },
    raised: { bun: { module_count: 2 } },
    parameter: "artifact_limits.bun.module_count",
    value: 1,
  },
  {
    format: "dotnet-bundle",
    create: () =>
      dotnetBundleFixture([
        { path: "first.txt", bytes: Buffer.from("first") },
        { path: "second.txt", bytes: Buffer.from("second") },
      ]).bytes,
    lower: { dotnet_bundle: { entry_count: 1 } },
    raised: { dotnet_bundle: { entry_count: 2 } },
    parameter: "artifact_limits.dotnet_bundle.entry_count",
    value: 1,
  },
  {
    format: "node-sea",
    create: () => nodeSeaElf({ execArgv: ["", ""] }),
    lower: { node_sea: { argument_count: 1 } },
    raised: { node_sea: { argument_count: 2 } },
    parameter: "artifact_limits.node_sea.argument_count",
    value: 1,
  },
  {
    format: "godot-pck",
    create: () =>
      buildGodotPck(2, [{ path: "res://main.gd", data: "extends Node\n" }]),
    lower: { godot: { directory_bytes: 1 } },
    raised: { godot: { directory_bytes: 4096 } },
    parameter: "artifact_limits.godot.directory_bytes",
    value: 1,
  },
  {
    format: "zip",
    create: async () => {
      const writer = new ZipWriter(new Uint8ArrayWriter());
      await writer.add("first.txt", new TextReader("first"));
      await writer.add("second.txt", new TextReader("second"));
      return Buffer.from(await writer.close());
    },
    lower: { expanded_bytes: 1 },
    raised: { expanded_bytes: 11 },
    parameter: "artifact_limits.expanded_bytes",
    value: 1,
  },
];

test("rejects malformed directory dimensions before suggesting a budget increase", async ({
  cli,
  workspace,
}) => {
  const path = workspace.path("unrepresentable-directory.pck");
  const bytes = buildGodotPck(2, [{ path: "main.gd", data: "extends Node\n" }]);
  // The v2 directory follows its 96-byte header and four-byte entry count.
  // Change only the declared length; do not allocate the claimed path.
  bytes.writeUInt32LE(0xffffffff, 100);
  await writeFile(path, bytes);
  const result = await cli.run({
    arguments: [
      "inspect-artifact",
      path,
      "--json",
      "--artifact-limits",
      JSON.stringify({
        godot: { directory_bytes: bufferConstants.MAX_STRING_LENGTH },
      }),
    ],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "artifact_operation_failed",
    retryable: false,
    details: {
      reason: "format",
    },
  });
  const failure = result.json as {
    remediation: { action: string };
    message: string;
  };
  expect(failure.remediation.action).not.toContain("Select a larger");
  expect(failure.message).not.toContain("Select a larger");
  expect((await readFile(path)).equals(bytes)).toBe(true);
});

for (const reader of readers)
  test(`recovers the same ${reader.format} through selected CLI admission`, async ({
    cli,
    workspace,
  }) => {
    const path = workspace.path("carrier.bin");
    const bytes = await reader.create();
    await writeFile(path, bytes);
    const command = ["inspect-artifact", path, "--json"];
    const baseline = await cli.run({ arguments: command });
    expect(baseline.exitCode, baseline.stderr).toBe(0);
    const original = readInspection(baseline.json);
    expect(original.source.parameters).toEqual({ integrity_policy: "fail" });
    expect(original.inventory.effective_limits).toBeUndefined();

    const refused = await cli.run({
      arguments: [
        ...command,
        "--artifact-limits",
        JSON.stringify(reader.lower),
      ],
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({
      code: "truncated",
      retryable: true,
      details: {
        reader_limit: {
          parameter: reader.parameter,
          effective_value: reader.value,
          applies_at: "next_operation",
          agent_editable: true,
          update_mode: "parameter",
          pending_restart: false,
        },
      },
    });
    const recovered = await cli.run({
      arguments: [
        ...command,
        "--artifact-limits",
        JSON.stringify(reader.raised),
      ],
    });
    expect(recovered.exitCode, recovered.stderr).toBe(0);
    const inspected = readInspection(recovered.json);
    expect(inspected.source.parameters).toEqual({
      integrity_policy: "fail",
      artifact_limits: reader.raised,
    });
    expect(inspected.inventory.effective_limits).toMatchObject(reader.raised);
    expect(inspected.inventory.manifest).toMatchObject({
      root_format: reader.format,
      root_sha256: digest(bytes),
      root_artifact_id: original.inventory.manifest.root_artifact_id,
    });
    expect(inspected.inventory.occurrences).toEqual(
      original.inventory.occurrences,
    );
    expect(digest(await readFile(path))).toBe(digest(bytes));
  });

test("admits the same SEA carrier above the legacy 4096-argument ceiling", async ({
  cli,
  workspace,
}) => {
  const path = workspace.path("many-arguments.bin");
  const bytes = nodeSeaElf({
    execArgv: Array.from({ length: 4097 }, () => ""),
  });
  await writeFile(path, bytes);
  const command = ["inspect-artifact", path, "--json"];
  const refused = await cli.run({ arguments: command });
  expect(refused.exitCode).toBe(1);
  expect(refused.json).toMatchObject({
    code: "truncated",
    details: {
      reader_limit: {
        parameter: "artifact_limits.node_sea.argument_count",
        effective_value: 4096,
        required_value: 4097,
      },
    },
  });
  const recovered = await cli.run({
    arguments: [
      ...command,
      "--artifact-limits",
      '{"node_sea":{"argument_count":4097}}',
    ],
  });
  expect(recovered.exitCode, recovered.stderr).toBe(0);
  expect(readInspection(recovered.json).inventory.manifest).toMatchObject({
    root_format: "node-sea",
    root_sha256: digest(bytes),
  });
});

test("applies the selected reader budget before extraction and preserves its output", async ({
  cli,
  workspace,
}) => {
  const path = workspace.path("host.bin");
  const output = workspace.path("selected-output");
  const bytes = dotnetBundleFixture([
    { path: "first.txt", bytes: Buffer.from("first") },
    { path: "second.txt", bytes: Buffer.from("second") },
  ]).bytes;
  await writeFile(path, bytes);
  const command = ["extract-artifact", path, "--output-root", output, "--json"];
  const refused = await cli.run({
    arguments: [
      ...command,
      "--artifact-limits",
      '{"dotnet_bundle":{"entry_count":1}}',
    ],
  });
  expect(refused.exitCode).toBe(1);
  expect(refused.json).toMatchObject({
    code: "truncated",
    details: {
      reader_limit: { parameter: "artifact_limits.dotnet_bundle.entry_count" },
    },
  });
  await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  const recovered = await cli.run({
    arguments: [
      ...command,
      "--artifact-limits",
      '{"dotnet_bundle":{"entry_count":2}}',
    ],
  });
  expect(recovered.exitCode, recovered.stderr).toBe(0);
  const evidence = parseEvidence(recovered.json);
  const extracted = artifactExtractionResultSchema.parse(
    evidence.normalized_result,
  );
  expect(evidence.parameters).toMatchObject({
    artifact_limits: { dotnet_bundle: { entry_count: 2 } },
  });
  expect(extracted.effective_limits).toMatchObject({
    dotnet_bundle: { entry_count: 2 },
  });
  expect(extracted.manifest.root_sha256).toBe(digest(bytes));
  expect(
    await readFile(workspace.path("selected-output/first.txt"), "utf8"),
  ).toBe("first");
  expect(
    await readFile(workspace.path("selected-output/second.txt"), "utf8"),
  ).toBe("second");
});

test("rejects unknown reader-policy fields before opening the selected artifact", async ({
  cli,
  workspace,
}) => {
  for (const policy of [
    { unknown: 1 },
    { node_sea: { argument_count: 1, unknown: 1 } },
  ]) {
    const invalid = await cli.run({
      arguments: [
        "inspect-artifact",
        workspace.path("does-not-exist"),
        "--artifact-limits",
        JSON.stringify(policy),
        "--json",
      ],
    });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.json).toMatchObject({ code: "VALIDATION_ERROR" });
  }
});
