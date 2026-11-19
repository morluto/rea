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
  "retains unresolved Module and definition facts through CLI, MCP and retained pages",
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
    const type = {
      kind: "TypeDef",
      token: "0x02000001",
      row_offset: 964,
      failed_fields: [
        {
          field: "Name",
          field_offset: 968,
          heap_index: bytes.readUInt16LE(968),
          reason: "ambiguous-string-heap",
        },
        {
          field: "Namespace",
          field_offset: 970,
          heap_index: bytes.readUInt16LE(970),
          reason: "ambiguous-string-heap",
        },
      ],
    };
    const method = {
      kind: "MethodDef",
      token: "0x06000001",
      row_offset: 984,
      declaring_type_token: "0x02000001",
      rva: 10240,
      failed_fields: [
        {
          field: "Name",
          field_offset: 992,
          heap_index: bytes.readUInt16LE(992),
          reason: "ambiguous-string-heap",
        },
      ],
    };
    expect(report.unresolved_definitions).toEqual({
      rows: [type, method],
      method_names_examined: true,
    });

    const call = await cli.sharedMcpCall!();
    const mcp = await call("inspect_managed_members", { path });
    expect(mcp.isError, JSON.stringify(mcp)).not.toBe(true);
    const parent = parseEvidence(mcp.structuredContent);
    expect(parent.normalized_result).toEqual(report);
    const source = {
      kind: "retained-evidence",
      evidence_id: parent.evidence_id,
    };

    for (const [offset, item] of [type, method].entries()) {
      const coordinates = await call("inspect_analysis_view", {
        source,
        view: {
          kind: "managed-members",
          collection: "unresolved_definitions",
          offset,
          limit: 1,
        },
      });
      expect(coordinates.isError, JSON.stringify(coordinates)).not.toBe(true);
      expect(
        parseEvidence(coordinates.structuredContent).normalized_result,
      ).toMatchObject({
        parent_evidence_id: parent.evidence_id,
        source_metadata_status: "partial",
        unresolved_method_names_examined: true,
        page: { collection: "unresolved_definitions", rows: [item] },
      });
    }

    const page = await call("inspect_analysis_view", {
      source,
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
