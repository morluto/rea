import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { parseEvidence } from "../../src/domain/evidence.js";
import { modelArtifactSchema } from "../../src/domain/model/modelArtifact.js";
import {
  analysisViewResultSchema,
  modelArtifactSummaryViewResultSchema,
} from "../../src/domain/analysisView/analysisView.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { ortFixture } from "../fixtures/model/ort.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "inspects ORT through the compiled CLI and pages retained MCP declarations after file removal",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ort-cli-");
    const path = join(root, "unwrapped.data");
    const { bytes } = ortFixture();
    await writeFile(path, bytes);
    const response = await cli.run({
      arguments: [
        "inspect-model-artifact",
        path,
        "--hash",
        "full",
        "--detail",
        "complete",
        "--json",
      ],
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const evidence = parseEvidence(response.json);
    const report = modelArtifactSchema.parse(evidence.normalized_result);
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(report.artifact).toMatchObject({
      path,
      sha256: digest,
      read_scope: "full-file",
    });
    expect(evidence.subject?.digest.sha256).toBe(digest);
    expect(report.inputs?.[0]).toMatchObject({ name: "images", type: "FLOAT" });
    expect(report.inputs?.[0]?.shape).toEqual([
      { kind: "symbol", symbol: "batch" },
      { kind: "value", value: "3" },
      { kind: "symbol", symbol: "height" },
      { kind: "symbol", symbol: "width" },
    ]);
    expect(report.operators?.[1]).toMatchObject({
      domain: "com.microsoft",
      op_type: "QuickGelu",
      since_version: 1,
    });
    expect(report.tensors[0]).toMatchObject({
      byte_length: 16,
      shape: ["2", "2"],
    });

    const { call } = await connectLocalToolsMcp();
    const inspected = await call("inspect_model_artifact", { path });
    expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
    const summary = modelArtifactSummaryViewResultSchema.parse(
      parseEvidence(inspected.structuredContent).normalized_result,
    );
    expect(summary.summary).toMatchObject({
      format: "ort",
      ort_version: "6",
      counts: { inputs: 1, outputs: 1, operators: 2 },
    });
    expect(summary.summary).not.toHaveProperty("inputs");
    expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
    await unlink(path);
    const source = {
      kind: "retained-evidence",
      evidence_id: summary.parent_evidence_id,
    };
    for (const collection of [
      "inputs",
      "outputs",
      "operators",
      "tensors",
    ] as const) {
      const paged = await call("inspect_analysis_view", {
        source,
        view: { kind: "model-artifact", collection, offset: 0, limit: 1 },
      });
      expect(paged.isError, JSON.stringify(paged)).not.toBe(true);
      const page = analysisViewResultSchema.parse(
        parseEvidence(paged.structuredContent).normalized_result,
      );
      if (page.kind !== "model-artifact")
        throw new Error("Expected model-artifact page");
      expect(page.items).toEqual(report[collection]!.slice(0, 1));
      expect(page.source).toMatchObject({
        path,
        sha256: null,
        read_scope: "full-file",
      });
    }
    const contrib = await call("inspect_analysis_view", {
      source,
      view: {
        kind: "model-artifact",
        collection: "operators",
        domains: ["com.microsoft"],
        fields: ["op_type", "domain", "since_version"],
      },
    });
    expect(contrib.isError, JSON.stringify(contrib)).not.toBe(true);
    const filtered = analysisViewResultSchema.parse(
      parseEvidence(contrib.structuredContent).normalized_result,
    );
    if (filtered.kind !== "model-artifact")
      throw new Error("Expected model-artifact page");
    expect(filtered.items).toEqual([
      {
        index: 1,
        op_type: "QuickGelu",
        domain: "com.microsoft",
        since_version: 1,
      },
    ]);
  },
);

cliTest(
  "returns selected ORT graph declarations in the initial MCP call with partial coverage",
  async () => {
    const root = await createTestTempDirectory("rea-ort-selected-");
    const path = join(root, "unknown.ort");
    await writeFile(path, ortFixture({ missingInput: true }).bytes);
    const { call } = await connectLocalToolsMcp();
    const selected = await call("inspect_model_artifact", {
      path,
      view: { collection: "inputs", fields: ["name", "type", "shape"] },
    });
    expect(selected.isError, JSON.stringify(selected)).not.toBe(true);
    const page = analysisViewResultSchema.parse(
      parseEvidence(selected.structuredContent).normalized_result,
    );
    if (page.kind !== "model-artifact")
      throw new Error("Expected model-artifact page");
    expect(page.items).toEqual([
      { index: 0, name: "images", type: null, shape: null },
    ]);
    expect(page.source_coverage).toMatchObject({
      header: "partial",
      inputs: "partial",
    });
  },
);
