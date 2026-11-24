import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { parseEvidence } from "../../src/domain/evidence.js";
import { evidenceBundleSchema } from "../../src/domain/evidenceBundle.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "summarizes byte entropy beside the unchanged complete Evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-entropy-delivery-");
    const path = join(root, "bytes");
    const bundle = join(root, "entropy.json");
    await writeFile(path, Buffer.alloc(65536));
    const args = [
      "inspect-byte-entropy",
      path,
      "--block-size",
      "256",
      "--offset",
      "7",
      "--length",
      "32769",
      "--json",
    ];
    const complete = await cli.run({ arguments: args });
    expect(complete.exitCode, complete.stderr).toBe(0);
    const parent = parseEvidence(complete.json);
    const compact = await cli.run({
      arguments: [...args, "--detail", "summary", "--evidence_output", bundle],
    });
    expect(compact.exitCode, compact.stdout).toBe(0);
    expect(compact.json).toMatchObject({
      summary: {
        normalized_result: {
          kind: "summary",
          parent_evidence_id: parent.evidence_id,
          summary: {
            file_entropy: 0,
            block_count: 129,
            run_count: 1,
            top_runs: [{ offset: 7, length: 32769, classification: "low" }],
          },
        },
      },
    });
    const retained = evidenceBundleSchema.parse(
      JSON.parse(await readFile(bundle, "utf8")),
    );
    expect(retained.records).toEqual([parent]);
    const refused = await cli.run({
      arguments: [
        "inspect-byte-entropy",
        join(root, "missing-input"),
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
  },
);

cliTest(
  "pages the same retained blocks through CLI and MCP without the input file",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-entropy-page-");
    const path = join(root, "bytes");
    const bundle = join(root, "entropy.json");
    const bytes = Buffer.alloc(632);
    bytes.set(
      Uint8Array.from({ length: 256 }, (_, value) => value),
      263,
    );
    await writeFile(path, bytes);
    const saved = await cli.run({
      arguments: [
        "inspect-byte-entropy",
        path,
        "--block-size",
        "256",
        "--offset",
        "7",
        "--detail",
        "summary",
        "--evidence_output",
        bundle,
        "--json",
      ],
    });
    expect(saved.exitCode, saved.stdout).toBe(0);
    const { call } = await connectLocalToolsMcp();
    const mcp = await call("inspect_byte_entropy", {
      path,
      block_size: 256,
      offset: 7,
      detail: "summary",
    });
    expect(mcp.isError, JSON.stringify(mcp.structuredContent)).not.toBe(true);
    const {
      records: [parent],
    } = evidenceBundleSchema.parse(JSON.parse(await readFile(bundle, "utf8")));
    if (parent === undefined)
      throw new Error("Expected retained entropy Evidence");
    await rename(path, join(root, "moved-bytes"));

    const blocks = [
      { offset: 7, length: 256, entropy: 0 },
      { offset: 263, length: 256, entropy: 8 },
      { offset: 519, length: 113, entropy: 0 },
    ];
    for (const [offset, next] of [
      [0, 2],
      [2, null],
      [3, null],
    ] as const) {
      const view = { kind: "byte-entropy-blocks", offset, limit: 2 };
      const page = await call("inspect_analysis_view", {
        source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
        view,
      });
      expect(page.isError, JSON.stringify(page.structuredContent)).not.toBe(
        true,
      );
      const projected = parseEvidence(page.structuredContent);
      expect(projected.normalized_result).toMatchObject({
        kind: "byte-entropy-blocks",
        parent_evidence_id: parent.evidence_id,
        items: blocks.slice(offset, offset + 2),
        coverage: {
          total: blocks.length,
          next_offset: next,
          exhausted: next === null,
        },
      });
      const offline = await cli.run({
        arguments: [
          "inspect-analysis-view",
          JSON.stringify({
            source: { kind: "evidence-file", path: bundle },
            view,
          }),
          "--json",
        ],
      });
      expect(offline.exitCode, offline.stdout).toBe(0);
      expect(parseEvidence(offline.json)).toEqual(projected);
    }
  },
);
