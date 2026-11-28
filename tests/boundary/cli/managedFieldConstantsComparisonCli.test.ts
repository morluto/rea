import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { buildManagedPeFixture } from "../../../scripts/fixtures/managed/pe.mjs";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { managedMemberInspectionSchema } from "../../../src/domain/managed/managedArtifact.js";
import { managedMemberComparisonResultSchema } from "../../../src/domain/managed/managedMemberComparison.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "compares encoded field defaults through CLI and retained MCP Evidence",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-constant-comparison-");
    const call = await cli.sharedMcpCall!();
    for (const [name, leftHex, rightHex, expected] of [
      ["changed", "0000000000002000", "0100000000002000", "changed"],
      ["same", "0000000000002000", "0000000000002000", "unchanged"],
      ["unavailable", "00", "0000000000002000", "unknown"],
    ] as const) {
      const bytes = [leftHex, rightHex].map((hex, index) =>
        buildManagedPeFixture({
          mvid: Buffer.alloc(16, index + 1),
          fields: [
            {
              name: "Default",
              flags: 0x8056,
              signature: Buffer.from([6, 0x0a]),
            },
          ],
          constants: [{ typeCode: 0x0a, value: Buffer.from(hex, "hex") }],
        }),
      );
      const leftPath = join(directory, `${name}-left.dll`);
      const rightPath = join(directory, `${name}-right.dll`);
      await writeFile(leftPath, bytes[0]!);
      await writeFile(rightPath, bytes[1]!);
      const compared = await cli.run({
        arguments: ["compare-managed-members", leftPath, rightPath, "--json"],
      });
      expect(compared.exitCode, compared.stderr).toBe(0);
      const inspections = [];
      for (const path of [leftPath, rightPath]) {
        const reply = await call("inspect_managed_members", {
          path,
          detail: "complete",
        });
        expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
        inspections.push(parseEvidence(reply.structuredContent));
      }
      const [left, right] = inspections;
      if (left === undefined || right === undefined)
        throw new Error("Both managed observations are required");
      const leftConstant = managedMemberInspectionSchema.parse(
        left.normalized_result,
      ).fields[0]?.constant;
      expect(leftConstant?.state).toBe(
        expected === "unknown" ? "unavailable" : "decoded",
      );
      expect((await readFile(leftPath)).equals(bytes[0]!)).toBe(true);
      expect((await readFile(rightPath)).equals(bytes[1]!)).toBe(true);
      await unlink(leftPath);
      await unlink(rightPath);
      const retained = await call("compare_managed_members", {
        left: { kind: "retained-evidence", evidence_id: left.evidence_id },
        right: { kind: "retained-evidence", evidence_id: right.evidence_id },
      });
      expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
      for (const evidence of [
        parseEvidence(compared.json),
        parseEvidence(retained.structuredContent),
      ]) {
        expect(evidence.authority).toBe("analyst-inference");
        const result = managedMemberComparisonResultSchema.parse(
          evidence.normalized_result,
        );
        expect(result.fields).toHaveLength(1);
        expect(result.fields[0]).toMatchObject({
          status: expected,
          match: { status: "matched", basis: "field-signature" },
          evidence_links: [result.left.evidence_id, result.right.evidence_id],
        });
        expect(result.summary.changed).toBe(expected === "changed" ? 1 : 0);
        expect(result.summary.unknown).toBe(expected === "unknown" ? 1 : 0);
        if (expected === "unknown")
          expect(result.fields[0]?.limitations).toEqual([
            expect.objectContaining({
              code: "field-constant-unavailable",
              side: "left",
            }),
          ]);
        else expect(result.fields[0]?.limitations).toEqual([]);
      }
      expect(
        managedMemberComparisonResultSchema.parse(
          parseEvidence(retained.structuredContent).normalized_result,
        ).evidence_links,
      ).toEqual([left.evidence_id, right.evidence_id]);
    }
  },
);
