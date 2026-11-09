import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import { SETTLE_TIMING } from "../../domain/desktop/appSettle.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { BuildComputerActionLog } from "./DesktopBuildActionLog.js";
import {
  DesktopBuildWitness,
  type WitnessedComputer,
} from "./DesktopBuildWitness.js";

const task = {
  name: "add-eggs",
  prompt: "Add eggs.",
  checks: [
    {
      kind: "lines_present" as const,
      file: "Documents/today.txt",
      lines: ["eggs"],
    },
  ],
};

const computer = {
  appData: () => Promise.reject(new Error("unread")),
  startRecording: () => Promise.reject(new Error("unstarted")),
  endRecording: () => Promise.reject(new Error("unended")),
  recordingSegments: () => Promise.reject(new Error("unfetched")),
} as WitnessedComputer;

const witnessAt = async (bundle: string) =>
  new DesktopBuildWitness(
    computer,
    new BuildComputerActionLog(),
    SETTLE_TIMING,
    bundle,
  );

describe("bundle task reads", () => {
  it("returns a cancelled result when reading the bundle's task is aborted", async () => {
    const bundle = await createTestTempDirectory("witness-bundle-");
    const directory = await createTestTempDirectory("witness-record-");
    const signal = AbortSignal.abort();
    const result = await witnessAt(bundle).then((witness) =>
      witness.check({ task, stage: "seed", directory }, signal),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    if (!(result.error instanceof AnalysisCancelledError)) return;
    expect(result.error.operation).toBe("check_build_task");
  });

  it("returns an adapter error when the bundle path cannot be read", async () => {
    const root = await createTestTempDirectory("witness-bundle-file-");
    const bundle = join(root, "not-a-directory");
    await writeFile(bundle, "bundle");
    const directory = await createTestTempDirectory("witness-record-");
    const result = await witnessAt(bundle).then((witness) =>
      witness.check(
        { task, stage: "seed", directory },
        new AbortController().signal,
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisInputError);
    if (!(result.error instanceof AnalysisInputError)) return;
    expect(result.error.userMessage).toContain(bundle);
  });
});
