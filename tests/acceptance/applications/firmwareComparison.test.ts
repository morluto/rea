import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { cliTest } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { evidenceBundleSchema } from "../../../src/domain/evidenceBundle.js";
import { artifactInventorySummaryViewResultSchema } from "../../../src/domain/analysisView/analysisViewResult.js";
import { parseEvidence, type Evidence } from "../../../src/domain/evidence.js";
import { artifactComparisonResultSchema } from "../../../src/domain/artifactComparison.js";
import { parseArtifactInventoryEvidence } from "../../../src/domain/artifactInventoryEvidence.js";
import {
  fitFixture,
  type FitFixtureImage,
} from "../../../src/artifacts/fit/FitImage.fixture.js";
import { dtString } from "../../../src/firmware/devicetree/Devicetree.fixture.js";

type McpCall = Awaited<ReturnType<typeof connectLocalToolsMcp>>["call"];
const image = (name: string, content: string): FitFixtureImage => ({
  name,
  data: Buffer.from(content),
  hashes: ["sha256"],
  properties: {
    type: dtString("firmware"),
    arch: dtString("arm64"),
    compression: dtString("none"),
  },
});
const inspect = async (call: McpCall, path: string) => {
  expect((await call("open_binary", { path })).isError).not.toBe(true);
  const result = await call("inspect_artifact", { detail: "summary" });
  expect(result.isError).not.toBe(true);
  const parent = artifactInventorySummaryViewResultSchema.parse(
    parseEvidence(result.structuredContent).normalized_result,
  );
  return { kind: "retained-evidence", evidence_id: parent.parent_evidence_id };
};
const compare = async (call: McpCall, left: object, right: object) => {
  const result = await call("compare_artifacts", { left, right });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  const evidence = parseEvidence(result.structuredContent);
  return {
    evidence,
    comparison: artifactComparisonResultSchema.parse(
      evidence.normalized_result,
    ),
  };
};
const inspectRecord = (records: readonly Evidence[], id: string) => {
  const record = records.find((record) => record.evidence_id === id);
  if (record === undefined)
    throw new Error("Expected complete inventory owner");
  return record;
};

cliTest(
  "compares FIT component changes through retained summaries and exact CLI Evidence sources",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-fit-version-compare-");
    const leftPath = join(root, "baseline.itb"),
      rightPath = join(root, "candidate.itb");
    const same = image("same", "identical stored bytes");
    const leftBytes = fitFixture({
      images: [
        same,
        image("changed", "old bytes"),
        image("removed", "removed bytes"),
      ],
    });
    const rightBytes = fitFixture({
      images: [
        image("added", "new component"),
        image("changed", "new bytes"),
        same,
      ],
    });
    await writeFile(leftPath, leftBytes);
    await writeFile(rightPath, rightBytes);
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "session,artifact,application",
      REA_MCP_INPUT_SCHEMA_PROFILE: "full",
    });
    const left = await inspect(call, leftPath),
      right = await inspect(call, rightPath);
    const { evidence, comparison } = await compare(call, left, right);
    expect(comparison).toMatchObject({
      status: "changed",
      summary: { unchanged: 1, added: 1, removed: 1, changed: 2, unknown: 0 },
    });
    expect(
      comparison.changes.map((row) => [row.logical_path, row.classification]),
    ).toEqual([
      [".", "changed"],
      ["images/added.bin", "added"],
      ["images/changed.bin", "changed"],
      ["images/removed.bin", "removed"],
    ]);
    expect(evidence.evidence_links).toEqual([
      left.evidence_id,
      right.evidence_id,
    ]);
    const bundlePath = join(root, "retained.json");
    expect(
      (await call("export_evidence_bundle", { path: bundlePath })).isError,
    ).not.toBe(true);
    const records = evidenceBundleSchema.parse(
      JSON.parse(await readFile(bundlePath, "utf8")),
    ).records;
    const inventory = parseArtifactInventoryEvidence(
      inspectRecord(records, left.evidence_id),
    ).inventory;
    const sameOccurrence = inventory.occurrences.find(
      (row) => row.logical_path === "images/same.bin",
    )!;
    const sameNode = inventory.nodes.find(
      (row) => row.artifact_id === sameOccurrence.artifact_id,
    )!;
    expect(sameNode.sha256).toBe(
      createHash("sha256").update(same.data).digest("hex"),
    );
    expect(sameOccurrence.hash_status).toBe("verified");
    const requestPath = join(root, "compare.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        left: {
          kind: "evidence-file",
          path: bundlePath,
          evidence_id: left.evidence_id,
        },
        right: {
          kind: "evidence-file",
          path: bundlePath,
          evidence_id: right.evidence_id,
        },
      }),
    );
    const run = cli.sharedCliRun?.bind(cli) ?? cli.run.bind(cli);
    const result = await run({
      arguments: ["compare-artifacts", requestPath, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(parseEvidence(result.json)).toEqual(evidence);
    const cliBundlePath = join(root, "cli-inspection.json");
    const cliInspection = await run({
      arguments: [
        "inspect-artifact",
        leftPath,
        "--detail",
        "summary",
        "--evidence_output",
        cliBundlePath,
        "--json",
      ],
    });
    expect(cliInspection.exitCode, cliInspection.stderr).toBe(0);
    const receipt = z
      .object({ summary: z.unknown() })
      .parse(cliInspection.json);
    const cliSummary = artifactInventorySummaryViewResultSchema.parse(
      parseEvidence(receipt.summary).normalized_result,
    );
    const cliRecords = evidenceBundleSchema.parse(
      JSON.parse(await readFile(cliBundlePath, "utf8")),
    ).records;
    const cliParent = inspectRecord(cliRecords, cliSummary.parent_evidence_id);
    expect(cliParent.caller_input_path).toBe(leftPath);
    expect(parseArtifactInventoryEvidence(cliParent).inventory).toEqual(
      inventory,
    );
    expect((await readFile(leftPath)).equals(leftBytes)).toBe(true);
    expect((await readFile(rightPath)).equals(rightBytes)).toBe(true);
  },
);
