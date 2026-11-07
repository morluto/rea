import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisViewResult.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { managedMemberInspectionSchema } from "../../../src/domain/managed/managedArtifact.js";
import { managedMemberListStartsFixture } from "../../fixtures/managedMemberListStarts.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for(["decreasing", "ordered"] as const)(
  "preserves managed ownership and unknown filter rows over CLI/MCP: %s",
  async (kind, { cli }) => {
    const root = await createTestTempDirectory("rea-managed-list-order-");
    const path = join(root, "fixture.dll");
    const starts = kind === "decreasing" ? [2, 0, 1] : [1, 0, 1];
    const bytes = managedMemberListStartsFixture(starts, starts);
    await writeFile(path, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const destination = join(root, "members.json");
    const cliReply = await cli.run({
      arguments: [
        "inspect-managed-members",
        path,
        "--detail",
        "summary",
        "--evidence-bundle",
        destination,
        "--json",
      ],
    });
    expect(cliReply.exitCode, cliReply.stderr).toBe(0);
    const bundle = parseEvidenceBundle(
      JSON.parse(await readFile(destination, "utf8")),
    );
    const parent = bundle.records.find(
      ({ operation }) => operation === "inspect_managed_members",
    );
    if (parent === undefined)
      throw new Error("Missing complete member Evidence");
    expect(parent.subject?.digest.sha256).toBe(sha256);
    const report = managedMemberInspectionSchema.parse(
      parent.normalized_result,
    );
    expect(report.coverage.state).toBe("partial");
    expect(
      report.coverage.issues.filter(({ detail }) =>
        detail.includes("decreases"),
      ),
    ).toHaveLength(kind === "decreasing" ? 2 : 0);
    const owner = kind === "decreasing" ? null : "0x02000003";
    const field = report.fields.find(({ token }) => token === "0x04000001");
    const method = report.methods.find(({ token }) => token === "0x06000001");
    if (field?.name == null || method?.name == null)
      throw new Error("Readable fixture members were lost");
    for (const row of [field, method]) {
      expect(row.declaring_type_token).toBe(owner);
      expect(row.signature.parse_status).toBe("decoded");
    }

    const call = await cli.sharedMcpCall!();
    const reply = await call("inspect_managed_members", {
      path,
      detail: "summary",
    });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    const summary = analysisViewResultSchema.parse(
      parseEvidence(reply.structuredContent).normalized_result,
    );
    if (summary.kind !== "summary") throw new Error("Expected member summary");
    for (const [collection, member] of [
      ["fields", field],
      ["methods", method],
    ] as const) {
      for (const typed of [false, true]) {
        const result = await call("inspect_analysis_view", {
          source: {
            kind: "retained-evidence",
            evidence_id: summary.parent_evidence_id,
          },
          view: {
            kind: "managed-members",
            collection,
            names: [member.name],
            fields: ["name", "declaring_type"],
            offset: 0,
            limit: 8,
            ...(typed ? { declaring_types: ["Fixture.Program"] } : {}),
          },
        });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const view = analysisViewResultSchema.parse(
          parseEvidence(result.structuredContent).normalized_result,
        );
        if (view.kind !== "managed-members")
          throw new Error("Expected retained members");
        expect(view.page.collection).toBe(collection);
        expect(view.source_coverage.state).toBe("partial");
        if (typed && kind === "decreasing") {
          expect(view.page.rows).toEqual([]);
          expect(view.page.unresolved_filter_rows).toBe(1);
        } else {
          expect(view.page.rows).toMatchObject([
            {
              token: member.token,
              name: member.name,
              declaring_type_token: owner,
            },
          ]);
          expect(view.page.rows[0]).not.toHaveProperty("body");
          expect(view.page.rows[0]).not.toHaveProperty("signature");
        }
      }
    }
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);
