import { expect, it } from "vitest";

import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { PYTHON_READER_CLEANUP } from "../../domain/desktop/appTaskReaders.js";
import { DesktopRemoteTaskReaders } from "./DesktopRemoteTaskReaders.js";

const reader = {
  id: "note",
  file: "Documents/note",
  argv: ["reader", "{file}"],
  output: "json" as const,
};
const success = {
  exit_code: 0,
  timed_out: false,
  stdout: JSON.stringify({ view: { format: "json", view: { value: 7 } } }),
  stderr: "",
};

it("retains a completed view and retries an owned folder when cleanup fails", async () => {
  let cleanups = 0;
  const owner = new DesktopRemoteTaskReaders(async (argv) => {
    if (argv[3] !== PYTHON_READER_CLEANUP) return success;
    cleanups += 1;
    return cleanups === 1
      ? { ...success, exit_code: 1, stderr: "permission denied" }
      : success;
  });
  const failure = await owner
    .read([reader], new AbortController().signal)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ProviderCleanupError);
  if (!(failure instanceof ProviderCleanupError))
    throw new Error("expected cleanup failure");
  expect(failure.diagnostics).toMatchObject({
    completed_reader_views: { note: { format: "json", view: { value: 7 } } },
  });
  expect(owner.cleanupResources).toHaveLength(2);
  expect(await owner.release()).toMatchObject({ verified: true });
  expect(owner.cleanupResources).toEqual([]);
  expect(failure.cleanupIncomplete).toBe(false);
});

it("waits for an interrupted reader before removing its folder", async () => {
  const controller = new AbortController();
  const calls: { requestId: string | undefined; cleanup: boolean }[] = [];
  let finish: ((value: typeof success) => void) | undefined;
  const owner = new DesktopRemoteTaskReaders(
    async (argv, _timeout, _signal, requestId) => {
      const cleanup = argv[3] === PYTHON_READER_CLEANUP;
      calls.push({ requestId, cleanup });
      return cleanup
        ? success
        : new Promise<typeof success>((resolve) => {
            finish = resolve;
          });
    },
  );
  const read = owner
    .read([reader], controller.signal)
    .catch((error: unknown) => error);
  await Promise.resolve();
  controller.abort(new Error("cancelled"));
  const failure = await read;
  expect(failure).toBeInstanceOf(ProviderCleanupError);
  expect(owner.cleanupResources).toHaveLength(2);
  const release = owner.release();
  await Promise.resolve();
  expect(calls.map(({ cleanup }) => cleanup)).toEqual([false]);
  if (finish === undefined) throw new Error("reader did not start");
  finish(success);
  expect(await release).toMatchObject({ verified: true });
  expect(calls.map(({ cleanup }) => cleanup)).toEqual([false, true]);
  if (!(failure instanceof ProviderCleanupError))
    throw new Error("expected cleanup failure");
  expect(failure.diagnostics).toMatchObject({
    completed_reader_views: { note: { view: { value: 7 } } },
  });
});

it("preserves a completed view when cancellation arrives during successful cleanup", async () => {
  const controller = new AbortController();
  const reason = { stage: "reader final cleanup" };
  const owner = new DesktopRemoteTaskReaders(async (argv) => {
    if (argv[3] === PYTHON_READER_CLEANUP) controller.abort(reason);
    return success;
  });
  const failure = await owner
    .read([reader], controller.signal)
    .catch((error: unknown) => error);
  if (!(failure instanceof AnalysisCancelledError))
    throw new Error("expected cancellation");
  expect(failure.cause).toBe(reason);
  expect(failure.diagnostics).toMatchObject({
    completed_reader_views: { note: { view: { value: 7 } } },
  });
  expect(owner.cleanupResources).toEqual([]);
});

it("keeps cancellation and a completed view when final cleanup also fails", async () => {
  const controller = new AbortController();
  const reason = { stage: "reader final cleanup" };
  let fail = true;
  const owner = new DesktopRemoteTaskReaders(async (argv) => {
    if (argv[3] !== PYTHON_READER_CLEANUP) return success;
    if (fail) {
      fail = false;
      controller.abort(reason);
      return { ...success, exit_code: 1, stderr: "denied" };
    }
    return success;
  });
  const failure = await owner
    .read([reader], controller.signal)
    .catch((error: unknown) => error);
  if (!(failure instanceof ProviderCleanupError))
    throw new Error("expected cleanup failure");
  expect(failure.cleanupPrimary).toBeInstanceOf(AnalysisCancelledError);
  expect(failure.cleanupPrimary?.cause).toBe(reason);
  expect(failure.diagnostics).toMatchObject({
    completed_reader_views: { note: { view: { value: 7 } } },
  });
  expect(await owner.release()).toMatchObject({ verified: true });
});

it("retains earlier views when a later reader's cleanup fails", async () => {
  let cleanup = 0;
  const owner = new DesktopRemoteTaskReaders(async (argv) => {
    if (argv[3] !== PYTHON_READER_CLEANUP) return success;
    cleanup += 1;
    return cleanup === 2
      ? { ...success, exit_code: 1, stderr: "denied" }
      : success;
  });
  const failure = await owner
    .read([reader, { ...reader, id: "second" }], new AbortController().signal)
    .catch((error: unknown) => error);
  if (!(failure instanceof ProviderCleanupError))
    throw new Error("expected cleanup failure");
  expect(failure.diagnostics).toMatchObject({
    completed_reader_views: {
      note: { view: { value: 7 } },
      second: { view: { value: 7 } },
    },
  });
  expect(await owner.release()).toMatchObject({ verified: true });
});

it("retains an unknown transport outcome without starting the reader again", async () => {
  let calls = 0;
  const owner = new DesktopRemoteTaskReaders(async () => {
    calls += 1;
    throw new Error("connection lost");
  });
  await expect(
    owner.read([reader], new AbortController().signal),
  ).rejects.toBeInstanceOf(ProviderCleanupError);
  expect(await owner.release()).toMatchObject({ verified: false });
  expect(calls).toBe(1);
  expect(owner.cleanupResources).toHaveLength(2);
});

it("retains a timed-out runner's folder because its separate reader session may still run", async () => {
  let calls = 0;
  const owner = new DesktopRemoteTaskReaders(async () => {
    calls += 1;
    return { ...success, exit_code: null, timed_out: true };
  });
  await expect(
    owner.read([reader], new AbortController().signal),
  ).rejects.toBeInstanceOf(ProviderCleanupError);
  expect(await owner.release()).toMatchObject({ verified: false });
  expect(calls).toBe(1);
  expect(owner.cleanupResources).toHaveLength(2);
});

it("does not start a second cleanup while a timed-out cleanup may still be running", async () => {
  let calls = 0;
  const owner = new DesktopRemoteTaskReaders(async (argv) => {
    if (argv[3] !== PYTHON_READER_CLEANUP) return success;
    calls += 1;
    return { ...success, exit_code: null, timed_out: true };
  });
  await expect(
    owner.read([reader], new AbortController().signal),
  ).rejects.toBeInstanceOf(ProviderCleanupError);
  expect(await owner.release()).toMatchObject({ verified: false });
  expect(calls).toBe(1);
  expect(owner.cleanupResources).toHaveLength(2);
});

it.each([
  { ...success, exit_code: 4, stderr: "reader failed" },
  { ...success, stdout: "invalid reader answer" },
])(
  "preserves earlier views and absences when a later runner fails after settling (%#)",
  async (failed) => {
    let readers = 0;
    const owner = new DesktopRemoteTaskReaders(async (argv) => {
      if (argv[3] === PYTHON_READER_CLEANUP) return success;
      readers += 1;
      if (readers === 1) return success;
      if (readers === 2)
        return { ...success, stdout: JSON.stringify({ absent: true }) };
      return failed;
    });
    const failure = await owner
      .read(
        [reader, { ...reader, id: "absent" }, { ...reader, id: "failed" }],
        new AbortController().signal,
      )
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      operation: "check_build_task",
      diagnostics: {
        completed_reader_views: {
          note: { format: "json", view: { value: 7 } },
        },
        completed_reader_absent: ["absent"],
      },
    });
    expect(owner.cleanupResources).toEqual([]);
  },
);
