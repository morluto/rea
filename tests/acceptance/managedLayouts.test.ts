import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { buildManagedPeFixture } from "../../src/dotnet/ManagedPe.fixture.js";
import { managedMemberInspectionSchema } from "../../src/domain/managed/managedArtifact.js";
import { managedMemberComparisonResultSchema } from "../../src/domain/managed/managedMemberComparison.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "compares layout changes through compiled CLI and reads retained declarations through stdio MCP",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-layout-cli-");
    const left = join(directory, "left.dll");
    const right = join(directory, "right.dll");
    const fixture = (offset: number) =>
      buildManagedPeFixture({
        typeFlags: [0x100011],
        classLayouts: [[0, 16, 1]],
        fieldLayouts: [[offset, 1]],
      });
    const bytes = fixture(4);
    await writeFile(left, bytes);
    await writeFile(right, fixture(8));
    const inspected = await cli.run({
      arguments: ["inspect-managed-members", left, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    const parent = parseEvidence(inspected.json);
    const report = managedMemberInspectionSchema.parse(
      parent.normalized_result,
    );
    expect(report.artifact.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(report.layout_declarations).toMatchObject({
      state: "complete",
      classes: [{ packing_size: 0, class_size: 16 }],
      fields: [{ offset_bytes: 4 }],
    });
    const compared = await cli.run({
      arguments: ["compare-managed-members", left, right, "--json"],
    });
    expect(compared.exitCode, compared.stdout + compared.stderr).toBe(0);
    const comparison = managedMemberComparisonResultSchema.parse(
      parseEvidence(compared.json).normalized_result,
    );
    expect(comparison.fields[0]).toMatchObject({
      status: "changed",
      left: { layout: { state: "known", field_offset: 4 } },
      right: { layout: { state: "known", field_offset: 8 } },
    });
    expect((await readFile(left)).equals(bytes)).toBe(true);
    await rm(left);
    await rm(right);
    const call = await cli.sharedMcpCall!();
    const response = await call("inspect_analysis_view", {
      source: { kind: "inline", evidence: parent },
      view: {
        kind: "managed-members",
        collection: "field_layouts",
        fields: ["offset_bytes"],
        offset: 0,
        limit: 1,
      },
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(
      parseEvidence(response.structuredContent).normalized_result,
    ).toMatchObject({
      parent_evidence_id: parent.evidence_id,
      source_coverage: { state: "complete", issues: [] },
      page: {
        collection: "field_layouts",
        rows: [
          {
            token: "0x10000001",
            field_row: 1,
            field_token: "0x04000001",
            declaring_type_token: "0x02000001",
            offset_bytes: 4,
          },
        ],
      },
    });
  },
);
