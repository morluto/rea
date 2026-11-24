import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect } from "vitest";

import {
  artifactComparisonResultSchema,
  type ArtifactComparisonResult,
} from "../../../src/domain/artifactComparison.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { parseEvidence, type Evidence } from "../../../src/domain/evidence.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

/** A minimal PE-looking executable; only its bytes and name matter here. */
const executable = (marker: number) =>
  Buffer.from([0x4d, 0x5a, 0x90, 0x00, marker, 0x00, 0x00, 0x00]);
const spirv = (marker: number) =>
  Buffer.from([0x03, 0x02, 0x23, 0x07, 0x00, 0x00, 0x01, marker]);

/**
 * The issue's scenario as two small CI build outputs. B drops one
 * executable, adds another, flips one byte of a SPIR-V module and adds a
 * data file.
 */
const BUILD_A: Readonly<Record<string, Buffer>> = {
  "game.exe": executable(1),
  "tool.exe": executable(2),
  "shaders/a.spv": spirv(1),
  "shaders/b.spv": spirv(2),
  "shaders/c.spv": spirv(3),
  "shaders/d.spv": spirv(4),
  "shaders/e.dxbc": Buffer.from("DXBC\u0000\u0001synthetic"),
};
const BUILD_B: Readonly<Record<string, Buffer>> = {
  ...Object.fromEntries(
    Object.entries(BUILD_A).filter(([path]) => path !== "tool.exe"),
  ),
  "editor.exe": executable(3),
  "shaders/b.spv": spirv(0xff),
  "data.pak": Buffer.from("synthetic data pack"),
};

const writeTree = async (
  root: string,
  files: Readonly<Record<string, Buffer>>,
): Promise<void> => {
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
};

const writeZip = async (
  path: string,
  files: Readonly<Record<string, Buffer>>,
): Promise<void> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  // `zip -r` records each directory as an entry, as the issue's workaround did.
  await writer.add("shaders/", undefined, { directory: true });
  for (const [name, bytes] of Object.entries(files))
    await writer.add(name, new Uint8ArrayReader(bytes));
  await writeFile(path, await writer.close());
};

/** Each path's classification, the facts the comparison is judged by. */
const classifications = (result: ArtifactComparisonResult) =>
  Object.fromEntries(
    result.changes.map(({ logical_path, classification }) => [
      logical_path,
      classification,
    ]),
  );

const EXPECTED_CHANGES = {
  ".": "changed",
  "data.pak": "added",
  "editor.exe": "added",
  shaders: "changed",
  "shaders/b.spv": "changed",
  "tool.exe": "removed",
};

const builds = async (prefix: string) => {
  const root = await createTestTempDirectory(prefix);
  const left = join(root, "buildA");
  const right = join(root, "buildB");
  await writeTree(left, BUILD_A);
  await writeTree(right, BUILD_B);
  return { root, left, right };
};

cliTest(
  "inspects and compares two build-output directories through the CLI",
  async ({ cli }) => {
    const { root, left, right } = await builds("rea-directory-compare-cli-");

    const inspected = await cli.run({
      arguments: ["inspect-artifact", left, "--json"],
    });
    expect(inspected.exitCode, inspected.stderr).toBe(0);
    const evidence = parseEvidence(inspected.json);
    const inspection = artifactInspectionResultSchema.parse(
      evidence.normalized_result,
    );
    expect(evidence.subject).toEqual({
      identity: {
        kind: "directory",
        algorithm: "rea-directory-tree",
        version: 1,
        sha256: inspection.subject.root_sha256,
      },
      name: "buildA",
      local_path: left,
    });
    expect(inspection.subject.root_format).toBe("directory");

    const compared = await cli.run({
      arguments: [
        "compare-artifacts",
        JSON.stringify({
          left: { kind: "path", path: "buildA" },
          right: { kind: "path", path: "buildB" },
        }),
        "--json",
      ],
      cwd: root,
    });
    expect(compared.exitCode, compared.stderr).toBe(0);
    const comparison = artifactComparisonResultSchema.parse(
      parseEvidence(compared.json).normalized_result,
    );
    expect(comparison.status).toBe("changed");
    expect(classifications(comparison)).toEqual(EXPECTED_CHANGES);
    expect(comparison.summary).toMatchObject({
      added: 2,
      removed: 1,
      changed: 3,
      unknown: 0,
    });

    // The zipped workaround classifies every member path the same way.
    await writeZip(join(root, "buildA.zip"), BUILD_A);
    await writeZip(join(root, "buildB.zip"), BUILD_B);
    const zipped = await cli.run({
      arguments: [
        "compare-artifacts",
        JSON.stringify({
          left: { kind: "path", path: "buildA.zip" },
          right: { kind: "path", path: "buildB.zip" },
        }),
        "--json",
      ],
      cwd: root,
    });
    expect(zipped.exitCode, zipped.stderr).toBe(0);
    const zippedComparison = artifactComparisonResultSchema.parse(
      parseEvidence(zipped.json).normalized_result,
    );
    expect(classifications(zippedComparison)).toEqual(
      classifications(comparison),
    );
  },
);

cliTest(
  "inspects a directory and compares directory paths through MCP without opening a target",
  async ({ cli }) => {
    const { left, right } = await builds("rea-directory-compare-mcp-");
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "session,artifact",
      REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
      REA_MCP_OUTPUT_SCHEMA_PROFILE: "compact",
    });
    const inspect = async (path: string): Promise<Evidence> => {
      const result = await call("inspect_artifact", {
        path,
        detail: "complete",
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return parseEvidence(result.structuredContent);
    };
    const [one, two] = [await inspect(left), await inspect(right)];
    expect(one.subject.identity).toMatchObject({
      kind: "directory",
      algorithm: "rea-directory-tree",
      version: 1,
    });
    expect(one.subject.identity).not.toEqual(two.subject.identity);

    // The CLI names the same directory with the same identity.
    const fromCli = await cli.run({
      arguments: ["inspect-artifact", left, "--json"],
    });
    expect(parseEvidence(fromCli.json).subject.identity).toEqual(
      one.subject.identity,
    );

    const byPath = await call("compare_artifacts", {
      left: { kind: "path", path: left },
      right: { kind: "path", path: right },
    });
    expect(byPath.isError, JSON.stringify(byPath)).not.toBe(true);
    const pathComparison = artifactComparisonResultSchema.parse(
      parseEvidence(byPath.structuredContent).normalized_result,
    );
    expect(classifications(pathComparison)).toEqual(EXPECTED_CHANGES);

    const byEvidence = await call("compare_artifacts", {
      left: { kind: "retained-evidence", evidence_id: one.evidence_id },
      right: { kind: "retained-evidence", evidence_id: two.evidence_id },
    });
    expect(byEvidence.isError, JSON.stringify(byEvidence)).not.toBe(true);
    // Path sources cite their inventories; retained inspections cite theirs.
    const withoutCitations = ({
      changes,
      ...rest
    }: ArtifactComparisonResult) => ({
      ...rest,
      changes: changes.map(({ evidence_links: _links, ...change }) => change),
    });
    expect(
      withoutCitations(
        artifactComparisonResultSchema.parse(
          parseEvidence(byEvidence.structuredContent).normalized_result,
        ),
      ),
    ).toEqual(withoutCitations(pathComparison));
  },
);
