import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { buildManagedPeFixture } from "../../../src/dotnet/ManagedPe.fixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { managedMemberInspectionSchema } from "../../../src/domain/managed/managedArtifact.js";
import { managedApplicationGraphResultSchema } from "../../../src/domain/managed/managedApplicationGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "projects validated generic calls through CLI and retained stdio MCP Evidence",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-generic-call-graph-");
    const call = await cli.sharedMcpCall!();
    for (const [name, base, instantiation, genericToken, calls] of [
      ["local", 4, [0x0a, 1, 8], "0x06000002", 1],
      ["external", 3, [0x0a, 1, 8], "0x0a000001", 0],
      ["unresolved", 4, [0x0a, 0], null, 0],
    ] as const) {
      const bytes = buildManagedPeFixture({
        methodRowCount: 2,
        methodSignature: Buffer.from([0x10, 1, 0, 1]),
        memberRefSignature: Buffer.from([0x30, 1, 0, 1]),
        methodSpecMethods: [base],
        methodSpecInstantiation: Buffer.from(instantiation),
        ilBody: Buffer.from([0x1a, 0x28, 1, 0, 0, 0x2b, 0x2a]),
      });
      const path = join(directory, `${name}.dll`);
      await writeFile(path, bytes);
      const inspected = await cli.run({
        arguments: [
          "inspect-managed-members",
          path,
          "--detail",
          "complete",
          "--json",
        ],
      });
      expect(inspected.exitCode, inspected.stderr).toBe(0);
      const response = await call("inspect_managed_members", {
        path,
        detail: "complete",
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const sources = [
        parseEvidence(inspected.json),
        parseEvidence(response.structuredContent),
      ];
      for (const source of sources) {
        const members = managedMemberInspectionSchema.parse(
          source.normalized_result,
        );
        expect(members.call_edges).toHaveLength(2);
        for (const edge of members.call_edges)
          expect(edge).toMatchObject({
            target_token: "0x2b000001",
            target_kind: "method-spec",
            generic_method_token: genericToken,
            target_row_resolved: genericToken !== null,
          });
      }
      expect((await readFile(path)).equals(bytes)).toBe(true);
      await unlink(path);
      const inputPath = join(directory, `${name}-graph.json`);
      await writeFile(
        inputPath,
        JSON.stringify({ managed_members: sources[0] }),
      );
      const projected = await cli.run({
        arguments: ["project-managed-application-graph", inputPath, "--json"],
      });
      expect(projected.exitCode, projected.stderr).toBe(0);
      const retained = await call("project_managed_application_graph", {
        managed_members: {
          kind: "retained-evidence",
          evidence_id: sources[1]!.evidence_id,
        },
      });
      expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
      for (const [index, evidence] of [
        parseEvidence(projected.json),
        parseEvidence(retained.structuredContent),
      ].entries()) {
        const result = managedApplicationGraphResultSchema.parse(
          evidence.normalized_result,
        );
        expect(evidence.evidence_links).toEqual([sources[index]!.evidence_id]);
        expect(result.summary.calls).toBe(calls);
        const relations = result.graph.edges.filter(
          ({ relation }) => relation === "calls",
        );
        expect(relations).toHaveLength(calls);
        if (calls === 1) {
          expect(relations[0]).toMatchObject({
            properties: {
              kind: "managed-call",
              site_count: 1,
              opcodes: { call: 1 },
            },
            evidence: { evidence_ids: [sources[index]!.evidence_id] },
          });
          const tokens = new Map(
            result.graph.nodes.map((node) => [
              node.node_id,
              node.observations[0]?.properties.token,
            ]),
          );
          expect(tokens.get(relations[0]!.source_node_id)).toBe("0x06000001");
          expect(tokens.get(relations[0]!.target_node_id)).toBe("0x06000002");
        } else {
          expect(result.coverage.status).toBe("partial");
          expect(result.limitations).toContainEqual(
            expect.stringContaining("2 generic method-instantiation"),
          );
        }
      }
    }
  },
);
