import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import type { NugetPackage } from "../../domain/nugetPackage/nugetPackage.js";
import { inspectNugetPackageEvidence } from "./NugetPackageService.js";

const STORED = 0;

/** A minimal stored-only ZIP, so the test does not need a compressor. */
const zip = (
  members: readonly {
    readonly path: string;
    readonly text: string;
    readonly corrupt?: boolean;
  }[],
): Buffer => {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of members) {
    const name = Buffer.from(entry.path, "utf8");
    const data = Buffer.from(entry.text, "utf8");
    const crc =
      entry.corrupt === true ? (crc32(data) ^ 0xffffffff) >>> 0 : crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(STORED, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0, 8);
    directory.writeUInt16LE(STORED, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(0, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30);
    directory.writeUInt16LE(0, 32);
    directory.writeUInt16LE(0, 34);
    directory.writeUInt16LE(0, 36);
    directory.writeUInt32LE(0, 38);
    directory.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(directory, name);
    offset += local.length + name.length + data.length;
  }
  const directoryBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directoryBytes, end]);
};

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1)
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

const crc32 = (data: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of data)
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const NUSPEC = `<?xml version="1.0" encoding="utf-8"?>
<package><metadata>
  <id>Example.Package</id>
  <version>1.0.0</version>
  <dependencies>
    <group targetFramework="net8.0">
      <dependency id="Newtonsoft.Json" version="[13.0.0,14.0.0)" />
    </group>
  </dependencies>
</metadata></package>`;

const writePackage = async (
  root: string,
  name = "Example.1.0.0.nupkg",
): Promise<string> => {
  const path = join(root, name);
  await writeFile(
    path,
    zip([
      { path: "Example.Package.nuspec", text: NUSPEC },
      { path: "lib/net8.0/Example.dll", text: "not really an assembly" },
      {
        path: "lib/netstandard2.0/Example.dll",
        text: "not really an assembly",
      },
      { path: "runtimes/win-x64/native/example.dll", text: "native" },
      { path: "analyzers/dotnet/cs/Example.Analyzers.dll", text: "analyzer" },
      { path: "build/Example.targets", text: "<Project />" },
    ]),
  );
  return path;
};

it("inventories a supplied package end to end", async () => {
  const root = await createTestTempDirectory("rea-nuget-package-");
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  const path = await writePackage(root);

  const result = await inspectNugetPackageEvidence({ path }, resources);
  if (!result.ok) throw new Error(result.error.message);
  const observed = result.value.evidence
    .normalized_result as unknown as NugetPackage;

  expect(observed.format).toBe("nupkg");
  expect(observed.artifact.path).toBe(path);
  expect(observed.artifact.bytes).toBeGreaterThan(0);
  expect(observed.nuspecs[0]?.id).toBe("Example.Package");
  expect(observed.nuspecs[0]?.dependency_groups[0]?.target_framework).toBe(
    "net8.0",
  );
  expect(observed.summary.assemblies).toBe(2);
  expect(observed.assets.map((asset) => asset.path)).toEqual([
    "Example.Package.nuspec",
    "lib/net8.0/Example.dll",
    "lib/netstandard2.0/Example.dll",
    "runtimes/win-x64/native/example.dll",
    "analyzers/dotnet/cs/Example.Analyzers.dll",
    "build/Example.targets",
  ]);
  expect(observed.diagnostics).toEqual([]);
  expect(observed.source_coverage.status).toBe("complete-within-scope");
});

it("reports the selected path and cause when it cannot resolve the package", async () => {
  const root = await createTestTempDirectory("rea-nuget-missing-");
  const blocker = join(root, "file");
  await writeFile(blocker, "x");
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  for (const [path, code] of [
    [join(root, "missing.nupkg"), "ENOENT"],
    [join(blocker, "child.nupkg"), "ENOTDIR"],
  ] as const) {
    const result = await inspectNugetPackageEvidence({ path }, resources);
    expect(result.ok).toBe(false);
    if (result.ok || !(result.error instanceof AnalysisInputError))
      throw new Error("Expected input refusal");
    expect(result.error.conformsToInputContract).toBe(true);
    expect(result.error.issues).toEqual([
      {
        path: ["path"],
        reason: "invalid_format",
        message: expect.stringContaining(path),
      },
    ]);
    expect(result.error.issues[0]?.message).toContain(code);
  }
});

it("refuses an unsafe .nuspec path without opening the member", async () => {
  const root = await createTestTempDirectory("rea-nuget-unsafe-");
  const path = join(root, "Unsafe.1.0.0.nupkg");
  // The member is unreadable (its stored data fails the CRC), so a read that
  // still happened before the path admission would surface as an input error
  // rather than the promised unsafe-entry-path diagnostic.
  await writeFile(
    path,
    zip([
      { path: "../escape.nuspec", text: NUSPEC, corrupt: true },
      { path: "lib/net8.0/Example.dll", text: "not really an assembly" },
    ]),
  );
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());

  const result = await inspectNugetPackageEvidence({ path }, resources);
  if (!result.ok) throw new Error(result.error.message);
  const observed = result.value.evidence
    .normalized_result as unknown as NugetPackage;
  expect(observed.nuspecs).toEqual([]);
  expect(observed.diagnostics.map((entry) => entry.code)).toEqual(
    expect.arrayContaining(["unsafe-entry-path"]),
  );
  expect(observed.diagnostics.map((entry) => entry.code)).not.toContain(
    "invalid-nuspec",
  );
});

it("keeps the admitted file snapshot when a later ZIP read fails", async () => {
  const root = await createTestTempDirectory("rea-nuget-late-failure-");
  const path = join(root, "Corrupt.1.0.0.nupkg");
  // The central directory is readable, so the carrier admits and hashes the
  // file; reading the member's stored data then fails its CRC.
  await writeFile(
    path,
    zip([{ path: "Example.Package.nuspec", text: NUSPEC, corrupt: true }]),
  );
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());

  const result = await inspectNugetPackageEvidence({ path }, resources);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected a read refusal");
  expect(result.error.partialObservation).toMatchObject({
    kind: "file-snapshot-hash",
    path,
  });
});
