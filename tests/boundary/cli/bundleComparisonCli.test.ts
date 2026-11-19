import { displayedEvidenceSubject } from "../../fixtures/evidenceSubject.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, onTestFinished } from "vitest";

import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { bundleComparisonResultSchema } from "../../../src/domain/bundleComparison.js";
import {
  createEvidenceBundle,
  serializeEvidenceBundle,
} from "../../../src/domain/evidenceBundle.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

cliTest(
  "compares Evidence bundles without unexplained display-only changes",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-bundle-comparison-cli-");
    const leftPath = join(root, "left.json");
    const displayPath = join(root, "display.json");
    const changedPath = join(root, "changed.json");
    const target = {
      path: join(root, "left.elf"),
      sha256: "a".repeat(64),
      format: "elf" as const,
      architecture: "x86_64" as const,
    };
    const record = createEvidence(
      target,
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "observe",
        parameters: {},
        result: { observed: true },
        confidence: "observed",
        authority: "shipped-artifact",
      },
    );
    const left = createEvidenceBundle([record]);
    const displayOnly = {
      ...left,
      records: [
        {
          ...record,
          subject: displayedEvidenceSubject(record.subject, {
            name: "renamed.elf",
            local_path: join(root, "renamed.elf"),
          }),
        },
      ],
    };
    const different = createEvidenceBundle([
      createEvidence(
        target,
        { id: "fixture", name: "Fixture", version: "1" },
        {
          operation: "observe",
          parameters: {},
          result: { observed: false },
          confidence: "observed",
          authority: "shipped-artifact",
        },
      ),
    ]);
    await Promise.all([
      writeFile(leftPath, serializeEvidenceBundle(left)),
      writeFile(displayPath, serializeEvidenceBundle(displayOnly)),
      writeFile(changedPath, serializeEvidenceBundle(different)),
    ]);
    const compare = async (path: string) =>
      cli.run({ arguments: ["compare", leftPath, path, "--json"] });
    const same = await compare(leftPath);
    expect(same.exitCode).toBe(0);
    expect(bundleComparisonResultSchema.parse(same.json)).toMatchObject({
      status: "unchanged",
      changes: [],
    });
    const display = await compare(displayPath);
    expect(display.exitCode).toBe(0);
    const displayResult = bundleComparisonResultSchema.parse(display.json);
    expect(displayResult).toMatchObject({
      status: "unchanged",
      summary: { records_unchanged: 1, unresolved: 0 },
      changes: [],
    });
    expect(displayResult.left_bundle_sha256).not.toBe(
      displayResult.right_bundle_sha256,
    );
    const differentResult = await compare(changedPath);
    expect(differentResult.exitCode).toBe(0);
    expect(
      bundleComparisonResultSchema.parse(differentResult.json),
    ).toMatchObject({
      status: "unknown",
      summary: { unresolved: 2 },
      changes: [
        expect.objectContaining({
          entity: "evidence",
          conclusion_kind: "unresolved_branch",
        }),
        expect.objectContaining({
          entity: "evidence",
          conclusion_kind: "unresolved_branch",
        }),
      ],
    });
    const pairs = [
      {
        left_evidence_id: record.evidence_id,
        right_evidence_id: different.records[0]!.evidence_id,
      },
    ];
    const pairArgs = ["compare", leftPath, changedPath, "--record_pairs"];
    const compareWithPairs = (value: string) =>
      cli.run({ arguments: [...pairArgs, value, "--json"] });
    const paired = await compareWithPairs(JSON.stringify(pairs));
    expect(paired.exitCode).toBe(0);
    const pairedResult = bundleComparisonResultSchema.parse(paired.json);
    expect(pairedResult).toMatchObject({
      status: "changed",
      summary: { records_changed: 1, unresolved: 0 },
      changes: [
        { classification: "changed", conclusion_kind: "observed_change" },
      ],
    });
    const pairFile = join(root, "pairs.json");
    await writeFile(pairFile, JSON.stringify(pairs));
    const fromFile = await compareWithPairs(pairFile);
    expect(fromFile.exitCode).toBe(0);
    expect(bundleComparisonResultSchema.parse(fromFile.json)).toEqual(
      pairedResult,
    );
    const missingFile = join(root, "missing-pairs.json");
    const absentFile = await compareWithPairs(missingFile);
    expect(absentFile.exitCode).toBe(1);
    expect(absentFile.json).toMatchObject({
      code: "invalid_request",
      input_path: missingFile,
      input_reason: "read-failed",
    });
    const call = await cli.sharedMcpCall?.();
    if (call === undefined) throw new Error("Expected shared MCP session");
    const mcp = await call("compare_bundles", {
      left_bundle_path: leftPath,
      right_bundle_path: changedPath,
      record_pairs: pairs,
    });
    expect(mcp.isError).not.toBe(true);
    expect(
      bundleComparisonResultSchema.parse(
        parseEvidence(mcp.structuredContent).normalized_result,
      ),
    ).toEqual(pairedResult);
    const absentPair = await compareWithPairs(
      JSON.stringify([
        { ...pairs[0], left_evidence_id: `ev_${"f".repeat(64)}` },
      ]),
    );
    expect(absentPair.exitCode).toBe(1);
    expect(absentPair.json).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ path: ["record_pairs", 0, "left_evidence_id"] }] },
    });
  },
);

cliTest(
  "identifies an analysis snapshot across portable Evidence readers",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-compare-snapshot-kind-");
    const bundlePath = join(root, "bundle.json");
    const snapshotPath = join(root, "snapshot.json");
    const malformedPath = join(root, "malformed.json");
    const snapshot = {
      target: {},
      binding: {},
      evidence_bundle: {},
      entries: [],
      workflow_entries: [],
    };
    await Promise.all([
      writeFile(bundlePath, serializeEvidenceBundle(createEvidenceBundle([]))),
      writeFile(snapshotPath, JSON.stringify(snapshot)),
      writeFile(malformedPath, JSON.stringify({ ...snapshot, records: [] })),
    ]);

    const call = await cli.sharedMcpCall?.();
    if (call === undefined) throw new Error("Expected shared MCP session");
    const wrongKind = {
      code: "invalid_request",
      remediation: {
        action: expect.stringContaining("standalone Evidence bundle"),
      },
      details: {
        operation: "read",
        reason: "wrong-kind",
        detected_kind: "analysis-snapshot",
        path: snapshotPath,
        related_operations: ["export_evidence_bundle"],
      },
    };
    const compareCli = (left: string, right: string) =>
      cli.run({ arguments: ["compare", left, right, "--json"] });
    const compareMcp = (left: string, right: string) =>
      call("compare_bundles", {
        left_bundle_path: left,
        right_bundle_path: right,
      });
    for (const [left, right] of [
      [snapshotPath, bundlePath],
      [bundlePath, snapshotPath],
    ] as const) {
      const compared = await compareCli(left, right);
      expect(compared.exitCode).toBe(1);
      expect(compared.json).toMatchObject(wrongKind);
      expect(
        parseMcpToolError(await compareMcp(left, right)).error,
      ).toMatchObject(wrongKind);
    }

    const source = { kind: "evidence-file", path: snapshotPath };
    const view = { kind: "summary" };
    const direct = await cli.run({
      arguments: [
        "inspect-analysis-view",
        JSON.stringify({ source, view }),
        "--json",
      ],
    });
    expect(direct.exitCode).toBe(1);
    const explicitSource = {
      ...wrongKind,
      remediation: {
        action: expect.stringContaining("standalone Evidence record or bundle"),
      },
    };
    expect(direct.json).toMatchObject(explicitSource);
    expect(
      parseMcpToolError(await call("inspect_analysis_view", { source, view }))
        .error,
    ).toMatchObject(explicitSource);

    const portable = await cli.run({
      arguments: [
        "inspect-analysis-view",
        JSON.stringify({
          source: {
            kind: "retained-evidence",
            evidence_id: `ev_${"f".repeat(64)}`,
          },
          view,
        }),
        "--evidence-bundle",
        snapshotPath,
        "--json",
      ],
    });
    expect(portable.exitCode).toBe(1);
    expect(portable.json).toMatchObject(wrongKind);

    const malformed = await compareCli(bundlePath, malformedPath);
    expect(malformed.exitCode).toBe(1);
    expect(malformed.json).toMatchObject({
      code: "evidence_integrity_mismatch",
    });
  },
);

cliTest(
  "rejects relative bundle paths over stdio MCP while CLI resolves them from its cwd",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-bundle-path-boundary-");
    const leftPath = join(root, "left.json");
    const rightPath = join(root, "right.json");
    const encoded = serializeEvidenceBundle(createEvidenceBundle([]));
    await Promise.all([
      writeFile(leftPath, encoded),
      writeFile(rightPath, encoded),
    ]);

    const client = new Client(
      {
        name: "bundle-path-contract-test",
        version: "1",
      },
      { jsonSchemaValidator: createMcpSchemaValidation() },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../../../scripts/rea.mjs", import.meta.url)),
        "mcp",
      ],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        REA_LOG_LEVEL: "silent",
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    onTestFinished(async () => {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
    });

    await client.connect(transport);
    for (const [left, right, rejectedField] of [
      ["left.json", "right.json", "left_bundle_path"],
      ["left.json", rightPath, "left_bundle_path"],
      [leftPath, "right.json", "right_bundle_path"],
    ] as const) {
      const result = await client.callTool({
        name: "compare_bundles",
        arguments: { left_bundle_path: left, right_bundle_path: right },
      });
      expect(parseMcpToolError(result).error).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
        details: {
          operation: "compare_bundles",
          issues: expect.arrayContaining([
            expect.objectContaining({
              path: [rejectedField],
              reason: "invalid_format",
              expected: "regex",
            }),
          ]),
        },
      });
    }

    const absolute = await client.callTool({
      name: "compare_bundles",
      arguments: {
        left_bundle_path: leftPath,
        right_bundle_path: rightPath,
      },
    });
    expect(absolute.isError).not.toBe(true);
    expect(absolute.structuredContent).toMatchObject({
      normalized_result: { status: "unchanged" },
    });

    const relativeCli = await cli.run({
      arguments: ["compare", "left.json", "right.json", "--json"],
      cwd: root,
      environment: { HOME: root, REA_LOG_LEVEL: "silent" },
    });
    expect(relativeCli.exitCode).toBe(0);
    expect(bundleComparisonResultSchema.parse(relativeCli.json)).toMatchObject({
      status: "unchanged",
      changes: [],
    });
  },
);
