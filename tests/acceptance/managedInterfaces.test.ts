import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { buildManagedPeFixture } from "../../src/dotnet/ManagedPe.fixture.js";
import { managedMemberInspectionSchema } from "../../src/domain/managed/managedArtifact.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "retains selected InterfaceImpl declarations through compiled CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-interface-cli-");
    const path = join(root, "interfaces.dll");
    const bytes = buildManagedPeFixture({
      targetFramework: null,
      typeNamespace: "Demo",
      typeName: "Worker",
      additionalEmptyTypes: 1,
      typeReferences: [{ namespace: "Contracts", name: "IWorker" }],
      interfaceImplementations: [
        [1, 9],
        [2, 9],
      ],
    });
    await writeFile(path, bytes);
    const output = await cli.run({
      arguments: [
        "inspect-managed-members",
        path,
        "--type",
        "Demo.Worker",
        "--json",
      ],
    });
    expect(output.exitCode, output.stdout + output.stderr).toBe(0);
    const parent = parseEvidence(output.json);
    const report = managedMemberInspectionSchema.parse(
      parent.normalized_result,
    );
    expect(report.artifact.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(report.interface_implementations).toMatchObject({
      state: "complete",
      rows: [
        {
          token: "0x09000002",
          class_row: 2,
          class_token: "0x02000002",
          declaring_type: "Demo.Worker",
          interface_token: "0x01000002",
          interface_name: "Contracts.IWorker",
        },
      ],
      issues: [],
    });
    expect(report.interface_implementations?.rows).toHaveLength(1);
    expect((await readFile(path)).equals(bytes)).toBe(true);
    await rm(path);
    const call = await cli.sharedMcpCall!();
    const response = await call("inspect_analysis_view", {
      source: { kind: "inline", evidence: parent },
      view: {
        kind: "managed-members",
        collection: "interface_implementations",
        fields: ["interface_name"],
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
        collection: "interface_implementations",
        rows: [
          {
            token: "0x09000002",
            class_token: "0x02000002",
            interface_token: "0x01000002",
            interface_name: "Contracts.IWorker",
          },
        ],
      },
    });
  },
);
