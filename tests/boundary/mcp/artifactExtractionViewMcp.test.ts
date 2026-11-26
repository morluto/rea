import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";

import { writeOrderedZip } from "../../fixtures/artifactEntryOrder.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { parseEvidence } from "../../../src/domain/evidence.js";

/** An archive whose written-file list exceeds the default agent result budget. */
const ENTRIES = [
  "AndroidManifest.xml",
  ...Array.from(
    { length: 400 },
    (_, index) => `res/raw/item${String(index)}.txt`,
  ),
  "lib/arm64-v8a/libapp.so",
  "lib/x86_64/libapp.so",
];

const connect = async () => {
  const root = await createTestTempDirectory("rea-extraction-view-");
  const path = join(root, "app.zip");
  await writeOrderedZip(path, ENTRIES);
  const { call } = await connectLocalToolsMcp(
    {},
    onTestFinished,
    {},
    undefined,
    // These cases cover the budget's choice for an omitted detail.
    "budgeted",
  );
  const opened = await call("open_binary", { path });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  const evidence = async (name: string, args: Record<string, unknown>) => {
    const reply = await call(name, args);
    expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
    return { reply, evidence: parseEvidence(reply.structuredContent) };
  };
  return { root, evidence };
};

it("retains a large extraction behind its summary and pages written files", async () => {
  const { root, evidence } = await connect();
  const { reply, evidence: summary } = await evidence("extract_artifact", {
    output_root: join(root, "out"),
  });
  expect(JSON.stringify(reply.content).length).toBeLessThan(32 * 1024);
  expect(summary).toMatchObject({
    operation: "inspect_analysis_view",
    normalized_result: {
      kind: "summary",
      parent_operation: "extract_artifact",
      summary: {
        output_root: join(root, "out"),
        containment_verified: true,
        extraction_manifest: { selected_occurrences: ENTRIES.length },
        counts: {
          artifacts: ENTRIES.length,
          created: ENTRIES.length,
          bytes_written: ENTRIES.length * "evidence\n".length,
          integrity_contradictions: 0,
        },
        cleanup: { residual_paths: { items: [], omitted: 0 } },
      },
    },
  });
  expect(summary.normalized_result).not.toHaveProperty("summary.artifacts");
  // The files themselves are written whatever the delivery.
  expect(
    await readFile(join(root, "out", "lib/x86_64/libapp.so"), "utf8"),
  ).toBe("evidence\n");

  const source = {
    kind: "retained-evidence",
    evidence_id: summary.evidence_links[0],
  };
  const { evidence: libraries } = await evidence("inspect_analysis_view", {
    source,
    view: {
      kind: "artifact-extraction",
      collection: "artifacts",
      path_globs: ["lib/**"],
      fields: ["relative_path", "bytes_written"],
    },
  });
  expect(libraries.normalized_result).toMatchObject({
    kind: "artifact-extraction",
    output_root: join(root, "out"),
    items: [
      { index: 1, relative_path: "lib/arm64-v8a/libapp.so", bytes_written: 9 },
      { index: 2, relative_path: "lib/x86_64/libapp.so", bytes_written: 9 },
    ],
    coverage: { total: 2, exhausted: true },
    byte_limited: false,
  });
  expect(libraries.normalized_result).not.toHaveProperty("items.0.sha256");

  const { evidence: first } = await evidence("inspect_analysis_view", {
    source,
    view: { kind: "artifact-extraction", collection: "artifacts", limit: 2 },
  });
  expect(first.normalized_result).toMatchObject({
    items: [{ relative_path: "AndroidManifest.xml" }, { index: 1 }],
    coverage: { total: ENTRIES.length, next_offset: 2 },
  });

  const { evidence: complete } = await evidence("extract_artifact", {
    output_root: join(root, "complete"),
    detail: "complete",
  });
  expect(complete.operation).toBe("extract_artifact");
  expect(
    artifactExtractionResultSchema.parse(complete.normalized_result).artifacts,
  ).toHaveLength(ENTRIES.length);
  expect(complete.parameters).not.toHaveProperty("detail");
});

it("returns a small extraction inline when detail is omitted", async () => {
  const root = await createTestTempDirectory("rea-extraction-inline-");
  const path = join(root, "small.zip");
  await writeOrderedZip(path, ["a.txt", "b.txt"]);
  const { call } = await connectLocalToolsMcp(
    {},
    onTestFinished,
    {},
    undefined,
    "budgeted",
  );
  await call("open_binary", { path });
  const reply = await call("extract_artifact", {
    output_root: join(root, "out"),
  });
  expect(parseEvidence(reply.structuredContent)).toMatchObject({
    operation: "extract_artifact",
    normalized_result: {
      artifacts: [{ relative_path: "a.txt" }, { relative_path: "b.txt" }],
    },
  });
});
