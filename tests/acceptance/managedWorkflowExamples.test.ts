import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { cliTest } from "../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { managedMemberInspectionSchema } from "../../src/domain/managed/managedArtifact.js";
import {
  MANAGED_APPLICATION_GRAPH_EXAMPLE,
  MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE,
} from "../../src/contracts/managed/managedWorkflowExamples.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "uses a consistent shared managed example through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-managed-example-");
    const source = MANAGED_APPLICATION_GRAPH_EXAMPLE.managed_members;
    const members = managedMemberInspectionSchema.parse(
      source.normalized_result,
    );
    expect(members.method_rows).toEqual({
      offset: 0,
      count: 1,
      total: 1,
    });
    expect(members.methods.map(({ token }) => token)).toEqual(["0x06000001"]);
    expect(parseEvidence(source)).toEqual(source);
    const mcp =
      surface === "stdio MCP" ? await connectLocalToolsMcp() : undefined;
    const scenarios = [
      {
        tool: "project_managed_application_graph",
        command: "project-managed-application-graph",
        input: MANAGED_APPLICATION_GRAPH_EXAMPLE,
      },
      {
        tool: "import_managed_reconstruction",
        command: "import-managed-reconstruction",
        input: MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE,
      },
    ];
    for (const { tool, command, input } of scenarios) {
      let reply: unknown;
      if (mcp !== undefined) {
        const response = await mcp.call(tool, input);
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        reply = response.structuredContent;
      } else {
        const request = join(root, `${command}.json`);
        await writeFile(request, JSON.stringify(input));
        const response = await cli.run({
          arguments: [command, request, "--json"],
        });
        expect(response.exitCode, response.stdout + response.stderr).toBe(0);
        reply = response.json;
      }
      const evidence = parseEvidence(reply);
      expect(evidence.operation).toBe(tool);
      if (tool === "project_managed_application_graph") {
        expect(evidence.normalized_result).toMatchObject({
          summary: { methods: 1 },
          coverage: { status: "complete-within-inputs" },
          evidence_links: [source.evidence_id],
        });
      } else {
        expect(evidence.normalized_result).toMatchObject({
          static_observation: { evidence_id: source.evidence_id },
        });
      }
    }
  },
);
