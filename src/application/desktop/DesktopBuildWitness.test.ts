import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import * as stableFile from "../../filesystem/readStableFileBytes.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
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
    const reason = new AnalysisInputError("caller", { userMessage: "stop" });
    const signal = AbortSignal.abort(reason);
    const result = await witnessAt(bundle).then((witness) =>
      witness.check({ task, stage: "seed", directory }, signal),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    if (!(result.error instanceof AnalysisCancelledError)) return;
    expect(result.error.operation).toBe("check_build_task");
    expect(result.error.cause).toBe(reason);
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

it("preserves a bundle read failure when cancellation follows during close", async () => {
  const bundle = await createTestTempDirectory("witness-read-failure-");
  const directory = await createTestTempDirectory("witness-record-");
  const parsed = parseDesktopTask(task);
  if (!parsed.ok) throw new Error("expected a valid task");
  await mkdir(join(bundle, "tasks"));
  await mkdir(join(bundle, "artifacts", taskVerifierArtifact(parsed.value)), {
    recursive: true,
  });
  await writeFile(join(bundle, "tasks", `${task.name}.json`), "[]");
  await writeFile(
    join(bundle, "artifacts", taskVerifierArtifact(parsed.value), "verify.py"),
    "",
  );
  const controller = new AbortController();
  const reason = new Error("cancel during close");
  const physical = Object.assign(new Error("read failed"), { code: "EIO" });
  const read = vi
    .spyOn(stableFile, "readStableFileBytes")
    .mockRejectedValue(physical);
  const close = OwnedFileHandle.prototype.close;
  const closing = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      await close.call(this);
      controller.abort(reason);
    });
  try {
    const result = await (
      await witnessAt(bundle)
    ).check({ task, stage: "seed", directory }, controller.signal);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected read failure");
    expect(result.error).toBeInstanceOf(ProviderAdapterError);
    expect(result.error.cause).toBe(physical);
    expect(result.error.secondaryFailures).toEqual([
      expect.objectContaining({
        _tag: "AnalysisCancelledError",
        cause: reason,
      }),
    ]);
  } finally {
    read.mockRestore();
    closing.mockRestore();
  }
});

describe("bundle task reads with large inputs", () => {
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

describe("published witness cancellation recovery", () => {
  it.skipIf(process.platform === "win32").each([false, true])(
    "keeps the saved record and retries only real cleanup (close fails: %s)",
    async (closeFails) => {
      const directory = await createTestTempDirectory("witness-close-");
      const controller = new AbortController();
      const reason = new Error("cancel at published witness close");
      const endRecording = vi.fn(async () => ({
        recording_id: "rec",
        segments: [],
      }));
      const witnessed = new DesktopBuildWitness(
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
          endRecording,
          recordingSegments: async () => [],
        },
        new BuildComputerActionLog(),
        { ...SETTLE_TIMING, windowMs: 0 },
      );
      let isPublished = () => false;
      let publishedCloses = 0;
      const commit = SafeOutputTree.prototype.commit;
      const committing = vi
        .spyOn(SafeOutputTree.prototype, "commit")
        .mockImplementation(async function (this: SafeOutputTree, ...args) {
          isPublished = () => this.published;
          return commit.apply(this, args);
        });
      const close = OwnedFileHandle.prototype.close;
      const closing = vi
        .spyOn(OwnedFileHandle.prototype, "close")
        .mockImplementation(async function (this: OwnedFileHandle) {
          if (!isPublished()) return close.call(this);
          publishedCloses += 1;
          if (closeFails) {
            controller.abort(reason);
            throw new Error("published witness close failed");
          }
          await close.call(this);
          controller.abort(reason);
        });
      try {
        const result = await witnessed.check(
          { task, stage: "seed", directory },
          controller.signal,
        );
        expect(publishedCloses).toBeGreaterThan(0);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("expected finalization cancellation");
        expect(result.error.partialObservation).toMatchObject({
          operation: "check_build_task",
        });
        if (closeFails) {
          expect(result.error.cleanupResources).toEqual([directory]);
          expect(result.error.secondaryFailures).toContainEqual(
            expect.objectContaining({
              _tag: "AnalysisCancelledError",
              cause: reason,
            }),
          );
        } else {
          expect(result.error).toBeInstanceOf(AnalysisCancelledError);
          expect(result.error.cause).toBe(reason);
          expect(result.error.cleanupIncomplete).toBe(false);
        }
        const bytes = await readFile(join(directory, "witness.json"));
        closing.mockRestore();
        const again = await witnessed.check(
          { task, stage: "seed", directory },
          new AbortController().signal,
        );
        expect(again.ok).toBe(true);
        if (!again.ok) throw again.error;
        expect(again.value.witness?.record?.path).toBe(
          join(directory, "witness.json"),
        );
        expect(
          (await readFile(join(directory, "witness.json"))).equals(bytes),
        ).toBe(true);
        expect(endRecording).toHaveBeenCalledTimes(1);
        expect(result.error.cleanupIncomplete).toBe(false);
      } finally {
        closing.mockRestore();
        committing.mockRestore();
        // Retry any real retained witness owner even when an assertion fails.
        await witnessed.check(
          { task, stage: "seed", directory },
          new AbortController().signal,
        );
      }
    },
  );
});
