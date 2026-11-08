import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { perfDataSchema } from "../../domain/perfData/perfData.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  buildPerfRecording,
  perfEntry,
} from "../../../tests/fixtures/perfData.js";
import { inspectPerfDataEvidence } from "./PerfDataService.js";

const inputFile = async (
  bytes: Uint8Array,
  name = "perf.data",
): Promise<{ root: string; path: string }> => {
  const root = await createTestTempDirectory("rea-perf-data-");
  const path = join(root, name);
  await writeFile(path, bytes);
  return { root, path };
};

it("binds the published source bytes to complete Evidence", async () => {
  const bytes = buildPerfRecording({
    entries: [
      perfEntry({ type: 0, config: 0, samplePeriod: 1000, ids: [7] }),
      perfEntry({
        type: 1,
        config: 9,
        samplePeriod: 4000,
        freq: true,
        ids: [8],
      }),
    ],
  });
  const { path } = await inputFile(bytes);
  const resources = new ArtifactResourceScope();
  try {
    const result = await inspectPerfDataEvidence({ path }, resources);
    expect(
      result.ok,
      result.ok ? undefined : JSON.stringify(result.error),
    ).toBe(true);
    if (!result.ok) throw new Error("expected a verified import");
    const value = perfDataSchema.parse(result.value.evidence.normalized_result);
    expect(result.value.evidence.operation).toBe("inspect_perf_data");
    expect(value.artifact).toEqual({
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(value.events.map((event) => event.config)).toEqual([0, 9]);
    expect(value.events.map((event) => event.sample_freq)).toEqual([
      false,
      true,
    ]);
    expect(value.summary).toMatchObject({ events: 2, identifiers: 2 });
    expect(result.value.observation).toEqual(value.artifact);
  } finally {
    await resources.close();
  }
});

it("rejects a non-perf file as verified Evidence with a diagnostic", async () => {
  const { root, path } = await inputFile(Buffer.from("hello"));
  const resources = new ArtifactResourceScope();
  try {
    const result = await inspectPerfDataEvidence({ path }, resources);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a verified read");
    const value = perfDataSchema.parse(result.value.evidence.normalized_result);
    expect(value.events).toEqual([]);
    expect(value.diagnostics).toEqual([
      expect.objectContaining({ code: "not-a-perf-data-file" }),
    ]);
    expect(value.source_coverage.status).toBe("partial");
    expect(root).toBeTruthy();
  } finally {
    await resources.close();
  }
});

it("refuses a recording larger than the selected file allowance", async () => {
  const bytes = buildPerfRecording();
  const { path } = await inputFile(bytes);
  const resources = new ArtifactResourceScope();
  try {
    const result = await inspectPerfDataEvidence(
      { path, max_file_bytes: 16 },
      resources,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a resource constraint");
    expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  } finally {
    await resources.close();
  }
});

it("honours the event allowance without discarding the file identity", async () => {
  const bytes = buildPerfRecording({
    entries: [perfEntry({ ids: [1] }), perfEntry({ ids: [2] })],
  });
  const { path } = await inputFile(bytes);
  const resources = new ArtifactResourceScope();
  try {
    const result = await inspectPerfDataEvidence(
      { path, max_events: 1 },
      resources,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a verified import");
    const value = perfDataSchema.parse(result.value.evidence.normalized_result);
    expect(value.events).toHaveLength(1);
    expect(value.artifact.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(value.diagnostics).toEqual([
      expect.objectContaining({ code: "event-limit-reached" }),
    ]);
  } finally {
    await resources.close();
  }
});
