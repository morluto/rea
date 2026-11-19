import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { parseEvidence } from "../../src/domain/evidence.js";
import { managedMemberInspectionSchema } from "../../src/domain/managed/managedArtifact.js";
import {
  managedStringsAmbiguity,
  STRING_AMBIGUITY_MVID,
} from "../fixtures/managedStringsAmbiguity.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "retains unnamed Module identity through CLI, MCP and a retained member page",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-managed-module-name-");
    const path = join(root, "fixture.dll");
    const { bytes, nameIndex } = managedStringsAmbiguity("forward");
    await writeFile(path, bytes);

    const output = await cli.run({
      arguments: ["inspect-managed-members", path, "--json"],
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const report = managedMemberInspectionSchema.parse(
      parseEvidence(output.json).normalized_result,
    );
    expect(report).toMatchObject({
      module: null,
      metadata: {
        unresolved_module_name: {
          name: null,
          name_index: nameIndex,
          mvid: STRING_AMBIGUITY_MVID,
        },
      },
      identity_scope: { requires_mvid: STRING_AMBIGUITY_MVID },
    });

    const call = await cli.sharedMcpCall!();
    const mcp = await call("inspect_managed_members", { path });
    expect(mcp.isError, JSON.stringify(mcp)).not.toBe(true);
    const parent = parseEvidence(mcp.structuredContent);
    expect(parent.normalized_result).toEqual(report);

    const page = await call("inspect_analysis_view", {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: { kind: "managed-members", collection: "methods", limit: 1 },
    });
    expect(page.isError, JSON.stringify(page)).not.toBe(true);
    expect(
      parseEvidence(page.structuredContent).normalized_result,
    ).toMatchObject({
      source_metadata_status: "partial",
      unresolved_module_name: report.metadata.unresolved_module_name,
      identity_scope: report.identity_scope,
    });
  },
);
