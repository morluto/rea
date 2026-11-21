import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../../resources/ArtifactResourceScope.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { inspectEvtxArchiveEvidence } from "./EvtxArchiveService.js";

it("reports the selected path and cause when it cannot resolve the event log", async () => {
  const root = await createTestTempDirectory("rea-evtx-missing-");
  const blocker = join(root, "file");
  await writeFile(blocker, "x");
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  for (const [path, code] of [
    [join(root, "missing.evtx"), "ENOENT"],
    [join(blocker, "child.evtx"), "ENOTDIR"],
  ] as const) {
    const result = await inspectEvtxArchiveEvidence({ path }, resources);
    expect(result.ok).toBe(false);
    if (result.ok || !(result.error instanceof AnalysisInputError))
      throw new Error("Expected input refusal");
    // A resolved-but-unreadable path does not conform to the input contract, so
    // the projection asks the caller to inspect the schema and names the path.
    expect(result.error.conformsToInputContract).toBe(false);
    expect(result.error.issues).toEqual([
      {
        path: ["path"],
        reason: "invalid_value",
        message: expect.stringContaining(path),
      },
    ]);
    expect(result.error.issues[0]?.message).toContain(code);
  }
});

it("names max_file_bytes as adjustable when the log exceeds the caller budget", async () => {
  const root = await createTestTempDirectory("rea-evtx-budget-");
  const path = join(root, "events.evtx");
  await writeFile(path, "ElfFile\0");
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  const result = await inspectEvtxArchiveEvidence(
    { path, max_file_bytes: 4 },
    resources,
  );
  expect(result.ok).toBe(false);
  if (result.ok || !(result.error instanceof AnalysisResourceConstraintError))
    throw new Error("Expected a resource-constraint refusal");
  expect(result.error.remediationAction).toContain("max_file_bytes");
});
