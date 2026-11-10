import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import { SETTLE_TIMING } from "../../domain/desktop/appSettle.js";
import { parseDesktopTask } from "../../domain/desktop/appTask.js";
import {
  renderTaskSteps,
  renderTaskVerifier,
  taskVerifierArtifact,
} from "../../domain/desktop/appTaskPython.js";
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
  exec: () => Promise.reject(new Error("unrun")),
  callTool: () => Promise.reject(new Error("uncalled")),
} as WitnessedComputer;

const witnessAt = async (bundle: string) =>
  new DesktopBuildWitness(
    computer,
    new BuildComputerActionLog(),
    SETTLE_TIMING,
    { bundle: { path: bundle } },
  );

describe("bundle task reads", () => {
  it("keeps the selected record directory through failed-save retries", async () => {
    const directory = await createTestTempDirectory("witness-original-");
    const other = await createTestTempDirectory("witness-other-");
    let endAttempts = 0;
    const witness = new DesktopBuildWitness(
      {
        ...computer,
        appData: async () => [
          {
            kind: "data",
            data: {
              state: {
                "Documents/today.txt": {
                  format: "text",
                  view: { lines: ["eggs"], line_count: 1, truncated: false },
                  error: null,
                },
              },
            },
          },
        ],
        startRecording: async () => ({
          recording_id: "rec",
          started_at: "2026-11-10T00:00:00.000Z",
        }),
        endRecording: async () => {
          if (++endAttempts === 1) throw new Error("recording busy");
          return { recording_id: "rec", segments: [] };
        },
        recordingSegments: async () => [],
      },
      new BuildComputerActionLog(),
      { ...SETTLE_TIMING, windowMs: 0 },
    );
    const signal = new AbortController().signal;
    const first = await witness.check(
      { task, stage: "seed", directory },
      signal,
    );
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("Expected recording failure");
    expect(first.error.userMessage).toContain("recording busy");

    const refused = await witness.check(
      { task, stage: "seed", directory: other },
      signal,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("Expected directory refusal");
    expect(refused.error.userMessage).toContain(directory);
    expect(endAttempts).toBe(1);
    await expect(access(join(directory, "witness.json"))).rejects.toThrow();
    await expect(access(join(other, "witness.json"))).rejects.toThrow();

    const saved = await witness.check(
      { task, stage: "seed", directory },
      signal,
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw saved.error;
    expect(saved.value.witness?.record?.path).toBe(
      join(directory, "witness.json"),
    );
    const savedAgain = await witness.check(
      { task, stage: "seed", directory: other },
      signal,
    );
    expect(savedAgain.ok).toBe(false);
    expect(endAttempts).toBe(2);
  });

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

  it("reads a task whose prompt is larger than the old 1 MiB file cap", async () => {
    const prompt = `Add ${"eggs ".repeat(Math.ceil((1.1 * 1024 * 1024) / 5))}end`;
    const given = { ...task, prompt };
    const parsed = parseDesktopTask(given);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const large = parsed.value;
    const app = "notes";
    const bundle = await createTestTempDirectory("witness-large-task-");
    await mkdir(join(bundle, "tasks"));
    await mkdir(join(bundle, "artifacts", taskVerifierArtifact(large)), {
      recursive: true,
    });
    const stepsPath = join(bundle, "tasks", `${large.name}.json`);
    await writeFile(stepsPath, renderTaskSteps(large, app));
    expect((await stat(stepsPath)).size).toBeGreaterThan(1024 * 1024);
    await writeFile(
      join(bundle, "artifacts", taskVerifierArtifact(large), "verify.py"),
      renderTaskVerifier(large, app),
    );
    const directory = await createTestTempDirectory("witness-record-");
    const result = await witnessAt(bundle).then((witness) =>
      witness.check(
        { task: given, stage: "seed", directory },
        new AbortController().signal,
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.userMessage).toContain("could not start its recording");
  });
});
