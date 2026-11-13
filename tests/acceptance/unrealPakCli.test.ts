import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { readEvidenceBundle } from "../../src/application/EvidenceBundleFiles.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  analysisViewResultSchema,
  unrealPakSummaryViewResultSchema,
} from "../../src/domain/analysisView/analysisView.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { unrealPakSchema } from "../../src/domain/unreal/unrealPak.js";
import { createPakFixture } from "../fixtures/unreal/pak.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "returns identical complete pak indexes through CLI and MCP and pages a retained summary after removal",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-unreal-pak-");
    const path = join(root, "Game-Mac.pak");
    const { bytes, files } = createPakFixture({ layout: "v12" });
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-unreal-pak", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_unreal_pak").outputSchema.parse(
      result.json,
    );
    const report = unrealPakSchema.parse(evidence.normalized_result);
    expect(report.artifact).toEqual({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
    expect(report.footer.layout).toBe("v12");
    expect(report.entries.map((entry) => entry.path)).toEqual(
      files.map((file) => file.path),
    );
    expect(evidence.parameters).toEqual({ path });

    const { client, call } = await connectLocalToolsMcp();
    const complete = await call("inspect_unreal_pak", {
      path,
      detail: "complete",
    });
    expect(complete.isError, JSON.stringify(complete)).not.toBe(true);
    expect(parseEvidence(complete.structuredContent).normalized_result).toEqual(
      report,
    );

    // Omitted detail delivers the compact summary, like IL2CPP metadata.
    const summarized = await call("inspect_unreal_pak", { path });
    expect(summarized.isError, JSON.stringify(summarized)).not.toBe(true);
    const view = unrealPakSummaryViewResultSchema.parse(
      parseEvidence(summarized.structuredContent).normalized_result,
    );
    expect(view.summary.counts).toEqual({
      entries: 3,
      encoded_records: 3,
      full_records: 0,
      compressed: 1,
      encrypted: 0,
      deleted: 0,
      without_path: 0,
      issues: 0,
    });
    expect(view.summary.footer).toEqual(report.footer);

    // Pages come from retained Evidence, not the file.
    await unlink(path);
    const rows: unknown[] = [];
    let offset = 0;
    do {
      const page = await call("inspect_analysis_view", {
        source: {
          kind: "retained-evidence",
          evidence_id: view.parent_evidence_id,
        },
        view: { kind: "unreal-pak", collection: "entries", offset, limit: 2 },
      });
      expect(page.isError, JSON.stringify(page)).not.toBe(true);
      const projected = analysisViewResultSchema.parse(
        parseEvidence(page.structuredContent).normalized_result,
      );
      if (projected.kind !== "unreal-pak")
        throw new Error("Wrong pak page kind");
      expect(projected.counts).toEqual(view.summary.counts);
      rows.push(...projected.items);
      offset = projected.coverage.next_offset ?? report.entries.length;
    } while (offset < report.entries.length);
    expect(rows).toEqual(
      report.entries.map((entry, index) => ({ index, ...entry })),
    );

    // Filters intersect and rows keep their source index, not the page offset.
    const selected = await call("inspect_analysis_view", {
      source: {
        kind: "retained-evidence",
        evidence_id: view.parent_evidence_id,
      },
      view: {
        kind: "unreal-pak",
        collection: "entries",
        indices: [2, 0, 2],
        paths: [report.entries[2]!.path!, report.entries[1]!.path!],
        fields: ["size"],
      },
    });
    expect(selected.isError, JSON.stringify(selected)).not.toBe(true);
    const filtered = analysisViewResultSchema.parse(
      parseEvidence(selected.structuredContent).normalized_result,
    );
    if (filtered.kind !== "unreal-pak") throw new Error("Wrong pak page kind");
    expect(filtered.items).toEqual([
      { index: 2, size: report.entries[2]!.size },
    ]);
    expect(filtered.coverage).toMatchObject({
      examined: 1,
      total: 1,
      exhausted: true,
    });
    const none = await call("inspect_analysis_view", {
      source: {
        kind: "retained-evidence",
        evidence_id: view.parent_evidence_id,
      },
      view: { kind: "unreal-pak", collection: "entries", paths: [] },
    });
    expect(
      analysisViewResultSchema.parse(
        parseEvidence(none.structuredContent).normalized_result,
      ),
    ).toMatchObject({ items: [], coverage: { total: 0 } });
    const invalid = await call("inspect_analysis_view", {
      source: {
        kind: "retained-evidence",
        evidence_id: view.parent_evidence_id,
      },
      view: { kind: "unreal-pak", collection: "entries", fields: ["name"] },
    });
    expect(parseMcpToolError(invalid).error.code).toBe("invalid_request");
    await client.ping();
  },
  30000,
);

cliTest(
  "distinguishes unsupported, corrupt and encrypted paks through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-unreal-pak-fail-");
    const { client, call } = await connectLocalToolsMcp();
    const frozen = createPakFixture({ layout: "v9", frozenIndex: true }).bytes;
    const outside = createPakFixture({
      layout: "v8b",
      lastOffsetShift: 1 << 20,
    }).bytes;
    for (const [name, bytes, expected] of [
      [
        "frozen.pak",
        frozen,
        {
          code: "unsupported_target",
          details: { operation: "inspect_unreal_pak" },
          message: expect.stringContaining("frozen-index"),
        },
      ],
      [
        "outside.pak",
        outside,
        {
          code: "invalid_request",
          details: {
            operation: "inspect_unreal_pak",
            issues: [
              {
                path: ["path"],
                reason: "invalid_format",
                message: expect.stringContaining("entry-out-of-bounds"),
              },
            ],
          },
        },
      ],
    ] as const) {
      const path = join(root, name);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-unreal-pak", path, "--json"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject(expected);
      const response = await call("inspect_unreal_pak", { path });
      expect(parseMcpToolError(response).error).toMatchObject(expected);
    }

    // An encrypted index is a successful report with footer facts only.
    const encryptedPath = join(root, "encrypted.pak");
    await writeFile(
      encryptedPath,
      createPakFixture({ layout: "v11", encryptedIndex: true }).bytes,
    );
    const encrypted = await cli.run({
      arguments: ["inspect-unreal-pak", encryptedPath, "--json"],
    });
    expect(encrypted.exitCode, encrypted.stderr).toBe(0);
    expect(
      unrealPakSchema.parse(
        toolContract("inspect_unreal_pak").outputSchema.parse(encrypted.json)
          .normalized_result,
      ),
    ).toMatchObject({
      footer: { index_encrypted: true },
      index: { state: "encrypted" },
      entries: [],
    });
    await client.ping();
  },
  30000,
);

cliTest(
  "exports complete pak Evidence for compact CLI delivery and portable selected reads",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-unreal-pak-export-");
    const path = join(root, "Game-Mac.pak");
    const bundle = join(root, "evidence.json");
    const refused = await cli.run({
      arguments: [
        "inspect-unreal-pak",
        join(root, "must-not-be-read"),
        "--detail",
        "summary",
        "--json",
      ],
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ path: ["evidence_output"] }] },
    });
    const { bytes, files } = createPakFixture({ layout: "v11" });
    await writeFile(path, bytes);
    const args = [
      "inspect-unreal-pak",
      path,
      "--detail",
      "summary",
      "--evidence_output",
      bundle,
      "--json",
    ];
    const result = await cli.run({ arguments: args });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      evidence_bundle: { path: bundle, bytes: expect.any(Number) },
      summary: { normalized_result: { kind: "summary" } },
    });
    const before = await readFile(bundle);
    const overwrite = await cli.run({ arguments: args });
    expect(overwrite.exitCode).toBe(1);
    expect((await readFile(bundle)).equals(before)).toBe(true);
    const saved = await readEvidenceBundle(bundle);
    if (!saved.ok) throw saved.error;
    const evidence = saved.value.records[0];
    if (evidence === undefined) throw new Error("Missing exported Evidence");
    expect(
      unrealPakSchema
        .parse(evidence.normalized_result)
        .entries.map((entry) => entry.path),
    ).toEqual(files.map((file) => file.path));
    await unlink(path);
    const query = join(root, "query.json");
    await writeFile(
      query,
      JSON.stringify({
        source: { kind: "inline", evidence },
        view: {
          kind: "unreal-pak",
          collection: "entries",
          indices: [1],
          fields: ["path"],
        },
      }),
    );
    const selected = await cli.run({
      arguments: ["inspect-analysis-view", query, "--json"],
    });
    expect(selected.exitCode, selected.stderr).toBe(0);
    expect(parseEvidence(selected.json).normalized_result).toMatchObject({
      items: [{ index: 1, path: files[1]!.path }],
      parent_evidence_id: evidence.evidence_id,
    });
  },
  30000,
);

cliTest(
  "reports contradicting pak facts as offset-backed issues through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-unreal-pak-issues-");
    const path = join(root, "counted.pak");
    await writeFile(
      path,
      createPakFixture({
        layout: "v11",
        declaredEntries: 5,
        files: [
          { path: "A/x", size: 1 },
          { path: "A/x", size: 2 },
          { path: "B/y", size: 3 },
        ],
      }).bytes,
    );
    const result = await cli.run({
      arguments: ["inspect-unreal-pak", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = unrealPakSchema.parse(
      toolContract("inspect_unreal_pak").outputSchema.parse(result.json)
        .normalized_result,
    );
    expect(report.index).toMatchObject({ entry_count: null });
    expect(report.entries.map((entry) => entry.path)).toEqual([
      "A/x",
      "A/x",
      "B/y",
    ]);
    expect(report.issues.map((issue) => issue.kind).sort()).toEqual([
      "duplicate-path",
      "duplicate-path",
      "entry-count-mismatch",
    ]);

    const { client, call } = await connectLocalToolsMcp();
    const summarized = await call("inspect_unreal_pak", { path });
    const view = unrealPakSummaryViewResultSchema.parse(
      parseEvidence(summarized.structuredContent).normalized_result,
    );
    expect(view.summary.counts.issues).toBe(3);
    const page = await call("inspect_analysis_view", {
      source: {
        kind: "retained-evidence",
        evidence_id: view.parent_evidence_id,
      },
      view: {
        kind: "unreal-pak",
        collection: "issues",
        kinds: ["entry-count-mismatch"],
        fields: ["offset"],
      },
    });
    expect(page.isError, JSON.stringify(page)).not.toBe(true);
    const mismatch = report.issues.findIndex(
      (issue) => issue.kind === "entry-count-mismatch",
    );
    expect(
      analysisViewResultSchema.parse(
        parseEvidence(page.structuredContent).normalized_result,
      ),
    ).toMatchObject({
      items: [{ index: mismatch, offset: report.issues[mismatch]!.offset }],
      coverage: { total: 1 },
    });
    await client.ping();
  },
  30000,
);

cliTest(
  "rejects an empty pak path before resolving it against the working directory",
  async ({ cli }) => {
    const result = await cli.run({
      arguments: ["inspect-unreal-pak", "", "--json"],
    });
    // The argument schema refuses it; filesystem admission never sees a path.
    expect(result.json).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [{ code: "too_small", path: "path" }],
    });
  },
);
