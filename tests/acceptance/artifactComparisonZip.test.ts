import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";

import type { ArtifactComparisonResult } from "../../src/domain/artifactComparison.js";
import { artifactInventoryResultSchema } from "../../src/domain/artifactGraph.js";
import type { Evidence } from "../../src/domain/evidence.js";
import { connectArtifactComparisonMcp } from "../fixtures/artifactComparisonMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

/** A ZIP member with the Unix mode its external attributes declare. */
interface ZipMember {
  readonly name: string;
  readonly data: string;
  readonly mode: number;
  readonly password?: string;
}

/** Inspect ZIP archives and compare their inventories through MCP. */
const connectZipComparison = async () => {
  const root = await createTestTempDirectory("rea-zip-comparison-");
  const { inspect: inspectFile, compare } =
    await connectArtifactComparisonMcp();
  const inspect = async (
    name: string,
    members: readonly ZipMember[],
  ): Promise<Evidence> => {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {
      versionMadeBy: 3 << 8,
    });
    for (const { name: path, data, mode, password } of members)
      await writer.add(path, new TextReader(data), {
        externalFileAttributes: (mode << 16) >>> 0,
        ...(password === undefined ? {} : { password }),
      });
    const file = join(root, name);
    await writeFile(file, await writer.close());
    return inspectFile(file);
  };
  return { inspect, compare };
};

const member = (evidence: Evidence, path: string) => {
  const occurrence = artifactInventoryResultSchema
    .parse(evidence.normalized_result)
    .occurrences.find(({ logical_path }) => logical_path === path);
  if (occurrence === undefined) throw new Error(`Missing ${path}`);
  return occurrence;
};

/** The archive root differs whenever members do; compare members only. */
const memberChanges = (result: ArtifactComparisonResult) =>
  result.changes.filter(({ logical_path }) => logical_path !== ".");

it("reports a ZIP member that becomes a symlink", async () => {
  const { inspect, compare } = await connectZipComparison();
  // A symlink member stores its target as data, so both members hold the
  // same bytes; only the declared entry kind differs.
  const file = await inspect("file.zip", [
    { name: "current", data: "target.txt", mode: 0o100644 },
  ]);
  const link = await inspect("link.zip", [
    { name: "current", data: "target.txt", mode: 0o120777 },
  ]);
  expect(member(file, "current")).toMatchObject({
    entry_kind: "file",
    hash_status: "verified",
    executable: false,
  });
  // REA does not read symlink targets, so the link has no content.
  expect(member(link, "current")).toMatchObject({
    entry_kind: "symlink",
    artifact_id: null,
    hash_status: "not-hashed",
    executable: false,
  });

  // The entry kind change is known; whether the content changed is not.
  expect(memberChanges(await compare(file, link))).toMatchObject([
    {
      logical_path: "current",
      classification: "unknown",
      dimensions: ["metadata", "availability"],
      left_occurrence_id: member(file, "current").occurrence_id,
      right_occurrence_id: member(link, "current").occurrence_id,
    },
  ]);
  // Without a known difference, unread content stays unknown.
  expect(memberChanges(await compare(link, link))).toMatchObject([
    {
      logical_path: "current",
      classification: "unknown",
      dimensions: ["availability"],
    },
  ]);
});

it("reports an executable mode change on an encrypted ZIP member", async () => {
  const { inspect, compare } = await connectZipComparison();
  const tool = { name: "tool", data: "#!/bin/sh\n", password: "fixture" };
  const plain = await inspect("plain.zip", [{ ...tool, mode: 0o100644 }]);
  const marked = await inspect("marked.zip", [{ ...tool, mode: 0o100755 }]);
  // REA does not decrypt members, so neither side has content.
  for (const [evidence, executable] of [
    [plain, false],
    [marked, true],
  ] as const)
    expect(member(evidence, "tool")).toMatchObject({
      artifact_id: null,
      encrypted: true,
      hash_status: "unavailable",
      executable,
    });

  // The mode change is known; whether the encrypted bytes changed is not.
  expect(memberChanges(await compare(plain, marked))).toMatchObject([
    {
      logical_path: "tool",
      classification: "unknown",
      dimensions: ["executable", "availability"],
    },
  ]);
  // Without a known difference, the encrypted bytes stay unknown.
  expect(memberChanges(await compare(plain, plain))).toMatchObject([
    {
      logical_path: "tool",
      classification: "unknown",
      dimensions: ["availability"],
    },
  ]);
});
