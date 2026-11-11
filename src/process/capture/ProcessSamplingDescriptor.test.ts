import {
  captureInspectionFailures,
  normalizeCaptureFailure,
  ProcessCaptureSamplingFailure,
} from "./ProcessCaptureError.js";
import { writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { readProcessInspectionFile } from "../ProcessInspectionFile.js";
import { ProcessCaptureResourceScope } from "./ProcessCaptureLifecycle.js";
import {
  SamplingReadBatchFailure,
  readSamplingSource,
  settleSamplingReads,
} from "./ProcessSamplingObservation.js";

const controls = vi.hoisted(
  () =>
    new Map<
      string,
      {
        allow: boolean;
        handle?: FileHandle | undefined;
        gate?: Promise<void>;
        closing?: () => void;
      }
    >(),
);
vi.mock("node:fs/promises", async (original) => {
  const filesystem = await original<typeof import("node:fs/promises")>();
  return {
    ...filesystem,
    open: async (...args: Parameters<typeof filesystem.open>) => {
      if (String(args[0]).startsWith("/proc/"))
        throw new Error("Unexpected native procfs open");
      const handle = await filesystem.open(...args);
      const control = controls.get(String(args[0]));
      if (control !== undefined) {
        control.handle = handle;
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          control.closing?.();
          await control.gate;
          if (!control.allow)
            throw new Error(
              "controlled real sampling descriptor close failure",
            );
          await close();
        });
      }
      return handle;
    },
  };
});

it("settles every admitted actual descriptor, retaining completed sibling values and all exact close owners", async () => {
  const directory = await createTestTempDirectory("rea-sampling-descriptors-");
  const firstPath = join(directory, "first");
  const secondPath = join(directory, "second");
  await writeFile(firstPath, "first observed bytes");
  await writeFile(secondPath, "second observed bytes");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let closing!: () => void;
  const secondClosing = new Promise<void>((resolve) => {
    closing = resolve;
  });
  const first = { allow: false, handle: undefined as FileHandle | undefined };
  const second = {
    allow: false,
    handle: undefined as FileHandle | undefined,
    gate,
    closing,
  };
  controls.set(firstPath, first);
  controls.set(secondPath, second);
  const scope = new ProcessCaptureResourceScope();
  onTestFinished(async () => {
    release();
    first.allow = true;
    second.allow = true;
    await scope.close();
    await Promise.all([first.handle?.close(), second.handle?.close()]);
    controls.clear();
  });
  const signal = new AbortController().signal;
  const completed = { value: "caller-selected completed observation" };
  const read = (path: string) =>
    readSamplingSource(path, signal, () =>
      readProcessInspectionFile(path, signal),
    );
  let settled = false;
  const running = settleSamplingReads([
    read(firstPath),
    Promise.resolve(completed),
    read(secondPath),
  ]).catch((cause: unknown) => {
    settled = true;
    return cause;
  });
  await secondClosing;
  expect(settled).toBe(false);
  expect(first.handle?.fd).toBeGreaterThanOrEqual(0);
  expect(second.handle?.fd).toBeGreaterThanOrEqual(0);
  release();
  const failure = await running;
  expect(failure).toBeInstanceOf(SamplingReadBatchFailure);
  if (!(failure instanceof SamplingReadBatchFailure))
    throw new Error("Expected owned sampling batch");
  expect(failure.outcomes[1]).toEqual({
    status: "fulfilled",
    value: completed,
  });
  expect(failure.otherFailures).toEqual([]);
  const capture = normalizeCaptureFailure(failure);
  if (!(capture instanceof ProcessCaptureSamplingFailure))
    throw new Error("Expected capture-owned sampling presentation");
  expect(capture.reason).toBe("capture_failed");
  const leaves = captureInspectionFailures(capture);
  expect(leaves).toHaveLength(2);
  for (const leaf of leaves) scope.retainInspectionFailure(leaf);
  expect(capture.cleanupIncomplete).toBe(true);
  await expect(scope.retryCleanup()).rejects.toBeDefined();
  first.allow = true;
  await expect(scope.retryCleanup()).rejects.toBeDefined();
  expect(first.handle?.fd).toBe(-1);
  expect(second.handle?.fd).toBeGreaterThanOrEqual(0);
  expect(capture.cleanupIncomplete).toBe(true);
  second.allow = true;
  await scope.retryCleanup();
  expect(second.handle?.fd).toBe(-1);
  expect(capture.cleanupIncomplete).toBe(false);
  expect(capture.inspectionFailures).toEqual(leaves);
  expect(capture.samplingFailure).toBe(failure);
  expect(failure.outcomes[1]).toEqual({
    status: "fulfilled",
    value: completed,
  });
});
