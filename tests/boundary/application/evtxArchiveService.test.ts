import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../../../src/resources/ArtifactResourceScope.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../../src/domain/analysisErrorCore.js";
import { analysisErrorRefusal } from "../../../src/domain/analysisErrorRefusal.js";
import { EVTX_ARCHIVE_BUDGETS } from "../../../src/domain/evtxArchive/evtxArchiveQuery.js";
import { inspectEvtxArchiveEvidence } from "../../../src/application/evtxArchive/EvtxArchiveService.js";

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

it("binds the refused max_file_bytes as an adjustable budget that names the needed size", async () => {
  const root = await createTestTempDirectory("rea-evtx-budget-limit-");
  const path = join(root, "events.evtx");
  await writeFile(path, "ElfFile\0");
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  const result = await inspectEvtxArchiveEvidence(
    { path, max_file_bytes: 4 },
    resources,
  );
  if (result.ok || !(result.error instanceof AnalysisResourceConstraintError))
    throw new Error("Expected a resource-constraint refusal");
  // The public refusal must be an adjustable budget, not a bolt-on sentence:
  // without a bound parameter limit the caller learns neither the control nor
  // the value that would admit the log.
  expect(analysisErrorRefusal(result.error)).toEqual({
    kind: "adjustable_budget",
    operation: "inspect_evtx_archive",
    budget: {
      control_kind: "parameter",
      parameter: "max_file_bytes",
      effective_value: 4,
      unit: "bytes",
      minimum: 1,
      maximum: EVTX_ARCHIVE_BUDGETS.max_file_bytes.maximum,
      default_value: EVTX_ARCHIVE_BUDGETS.max_file_bytes.default_value,
      applies_at: "next_call",
      required_value: 8,
    },
  });
});

it("keeps budget fields the caller omitted out of Evidence parameters", async () => {
  const root = await createTestTempDirectory("rea-evtx-evidence-parameters-");
  const path = join(root, "events.evtx");
  await writeFile(path, "ElfFile\0");
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  const result = await inspectEvtxArchiveEvidence({ path }, resources);
  if (!result.ok) throw new Error(result.error.message);
  // A caller that selected only the path must not read back REA's resolved
  // budgets as their own selection.
  expect(result.value.evidence.parameters).toEqual({ path });
});
