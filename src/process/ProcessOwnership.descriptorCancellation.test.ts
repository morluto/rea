import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../tests/fixtures/binarySession.js";

const fixture = vi.hoisted(() => ({
  files: new Map<string, string>(),
  handles: new Map<string, FileHandle>(),
  denied: new Map<string, Error>(),
  onRead: undefined as undefined | ((path: string) => Promise<void>),
  onReadFailure: undefined as undefined | ((cause: unknown) => void),
  onClosed: undefined as undefined | ((path: string) => void),
  onDeniedClose: undefined as undefined | ((cause: unknown) => void),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...filesystem,
    readFile: (...args: Parameters<typeof filesystem.readFile>) => {
      if (String(args[0]).startsWith("/proc/"))
        throw new Error("Unexpected raw procfs read");
      return filesystem.readFile(...args);
    },
    open: async (path: string) => {
      const selected = fixture.files.get(path);
      if (selected === undefined) throw new Error(`Unexpected open: ${path}`);
      const handle = await filesystem.open(selected, "r");
      fixture.handles.set(path, handle);
      const read = handle.read.bind(handle);
      handle.read = (async (...args: unknown[]) => {
        await fixture.onRead?.(path);
        try {
          return await Reflect.apply(read, handle, args);
        } catch (cause: unknown) {
          fixture.onReadFailure?.(cause);
          throw cause;
        }
      }) as FileHandle["read"];
      const close = handle.close.bind(handle);
      onTestFinished(close);
      handle.close = async () => {
        const failure = fixture.denied.get(path);
        if (failure !== undefined) {
          fixture.onDeniedClose?.(failure);
          throw failure;
        }
        await close();
        fixture.onClosed?.(path);
      };
      return handle;
    },
  };
});

import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";
import {
  ProcessOwnershipIdentityBatchFailure,
  ProcessOwnershipInspectionCancelled,
  isProcessOwnershipInspectionCancellation,
} from "./ProcessInspectionCancellation.js";
import {
  createSystemProcessOwnershipHost,
  readNativeProcessIdentityMap,
} from "./ProcessOwnershipObservation.js";

const prepare = async () => {
  fixture.files.clear();
  fixture.handles.clear();
  fixture.denied.clear();
  fixture.onRead = undefined;
  fixture.onReadFailure = undefined;
  fixture.onClosed = undefined;
  fixture.onDeniedClose = undefined;
  const root = await mkdtemp(join(tmpdir(), "rea-inspection-descriptor-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const rows = [42, 43, 44].map((pid) => ({
    pid,
    parentPid: 1,
    processGroupId: pid,
    state: "S",
    command: "fixture",
  }));
  for (const { pid } of rows) {
    const path = join(root, String(pid));
    // Linux stat fields 3..22, including PF flags and the native start tick.
    await writeFile(
      path,
      `${pid} (fixture) S 1 ${pid} ${pid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100`,
    );
    fixture.files.set(`/proc/${pid}/stat`, path);
  }
  return { root, rows, host: createSystemProcessOwnershipHost("linux", {}) };
};

it("retains an actual descriptor read fault as unavailable when the identical fault aborts the caller", async () => {
  const { root, rows, host } = await prepare();
  const directory = join(root, "directory");
  await mkdir(directory);
  fixture.files.set("/proc/42/stat", directory);
  const controller = new AbortController();
  let nativeFailure: unknown;
  fixture.onReadFailure = (cause) => {
    nativeFailure = cause;
    controller.abort(cause);
  };
  const result = await host.processIdentities!([rows[0]!], controller.signal);
  expect(nativeFailure).toMatchObject({ code: "EISDIR" });
  expect(controller.signal.reason).toBe(nativeFailure);
  expect(result.get(42)).toMatchObject({
    state: "unavailable",
    reason: expect.stringContaining("EISDIR"),
  });
  expect(fixture.handles.get("/proc/42/stat")?.fd).toBe(-1);
});

it("joins a pending successful native read before reporting explicit cancellation and closing its descriptor", async () => {
  const { rows, host } = await prepare();
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  onTestFinished(() => release.resolve());
  const completed = createDeferred<void>();
  fixture.onClosed = (path) => {
    if (path === "/proc/44/stat") completed.resolve();
  };
  fixture.onRead = async (path) => {
    if (path === "/proc/42/stat") {
      entered.resolve();
      await release.promise;
    }
  };
  const controller = new AbortController();
  const reason = { caller: "during native read" };
  let settled = false;
  const pending = host.processIdentities!(
    [rows[0]!, rows[2]!],
    controller.signal,
  )
    .catch((cause: unknown) => cause)
    .finally(() => {
      settled = true;
    });
  await entered.promise;
  await completed.promise;
  // Let the completed sibling publish its parsed identity after descriptor close.
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(reason);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(fixture.handles.get("/proc/42/stat")?.fd).toBeGreaterThanOrEqual(0);
  release.resolve();
  const failure = await pending;
  expect(failure).toBeInstanceOf(ProcessOwnershipIdentityBatchFailure);
  if (!(failure instanceof ProcessOwnershipIdentityBatchFailure)) throw failure;
  expect(failure.origin).toBe("cancelled");
  expect(isProcessOwnershipInspectionCancellation(failure)).toBe(true);
  expect(ProcessOwnershipInspectionCancelled.from(failure)).toBe(failure);
  expect(failure.reason).toBe(reason);
  expect(failure.observations.get(44)).toMatchObject({
    state: "readable",
    identity: "linux-starttime:100",
  });
  expect(failure.failures[0]?.cause).toBeInstanceOf(
    ProcessOwnershipInspectionCancelled,
  );
  expect(failure.failures[0]?.cause).toMatchObject({ reason, cause: reason });
  expect(fixture.handles.get("/proc/42/stat")?.fd).toBe(-1);
});

it("drains mixed identity outcomes and transfers every exact failed-close owner with completed facts", async () => {
  const { rows, host } = await prepare();
  const firstClose = new Error("first close denied");
  const secondClose = new Error("second close denied");
  fixture.denied.set("/proc/42/stat", firstClose);
  fixture.denied.set("/proc/43/stat", secondClose);
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  onTestFinished(() => release.resolve());
  fixture.onRead = async (path) => {
    if (path === "/proc/43/stat") {
      entered.resolve();
      await release.promise;
    }
  };
  let settled = false;
  const pending = readNativeProcessIdentityMap(rows, host)
    .catch((cause: unknown) => cause)
    .finally(() => {
      settled = true;
    });
  await entered.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  release.resolve();
  const failure = await pending;
  expect(failure).toBeInstanceOf(ProcessOwnershipIdentityBatchFailure);
  if (!(failure instanceof ProcessOwnershipIdentityBatchFailure)) throw failure;
  expect(failure.observations.get(44)).toMatchObject({
    state: "readable",
    identity: "linux-starttime:100",
  });
  expect(failure.observations.has(42)).toBe(false);
  expect(failure.observations.has(43)).toBe(false);
  expect(
    failure.failures.map(({ pid, requestIndex }) => [pid, requestIndex]),
  ).toEqual([
    [42, 0],
    [43, 1],
  ]);
  for (const [index, { pid, cause }] of failure.failures.entries()) {
    expect(cause).toBeInstanceOf(RegularFileCleanupFailure);
    if (!(cause instanceof RegularFileCleanupFailure)) throw cause;
    expect(cause.cleanupCause).toBe(index === 0 ? firstClose : secondClose);
    expect(cause.outcome).toMatchObject({ kind: "completed" });
    expect(cause.owner.handle).toBe(fixture.handles.get(`/proc/${pid}/stat`));
    expect(cause.owner.handle.fd).toBeGreaterThanOrEqual(0);
    fixture.denied.delete(`/proc/${pid}/stat`);
    await cause.owner.close();
    expect(cause.owner.handle.fd).toBe(-1);
  }
  expect(fixture.handles.get("/proc/44/stat")?.fd).toBe(-1);
});

it("keeps an actual physical read primary alongside a sibling's explicit cancellation with the identical raw reason", async () => {
  const { root, rows, host } = await prepare();
  const directory = join(root, "directory");
  await mkdir(directory);
  fixture.files.set("/proc/42/stat", directory);
  const physical = createDeferred<void>();
  const sibling = createDeferred<void>();
  const siblingStarted = createDeferred<void>();
  const completed = createDeferred<void>();
  const observedFailure = createDeferred<void>();
  onTestFinished(() => {
    physical.resolve();
    sibling.resolve();
  });
  fixture.onClosed = (path) => {
    if (path === "/proc/44/stat") completed.resolve();
  };
  fixture.onRead = async (path) => {
    if (path === "/proc/42/stat") await physical.promise;
    if (path === "/proc/43/stat") {
      siblingStarted.resolve();
      await sibling.promise;
    }
  };
  const controller = new AbortController();
  let nativeFailure: unknown;
  fixture.onReadFailure = (cause) => {
    nativeFailure = cause;
    controller.abort(cause);
    observedFailure.resolve();
  };
  const pending = readNativeProcessIdentityMap(
    rows,
    host,
    controller.signal,
  ).catch((cause: unknown) => cause);
  await completed.promise;
  await siblingStarted.promise;
  physical.resolve();
  await observedFailure.promise;
  sibling.resolve();
  const failure = await pending;
  expect(failure).toBeInstanceOf(ProcessOwnershipIdentityBatchFailure);
  if (!(failure instanceof ProcessOwnershipIdentityBatchFailure)) throw failure;
  expect(nativeFailure).toMatchObject({ code: "EISDIR" });
  expect(controller.signal.reason).toBe(nativeFailure);
  expect(failure.origin).toBe("physical");
  expect(isProcessOwnershipInspectionCancellation(failure)).toBe(false);
  expect(ProcessOwnershipInspectionCancelled.from(failure)).toBeUndefined();
  expect(failure.physicalFailures).toEqual([
    { pid: 42, requestIndex: 0, cause: nativeFailure },
  ]);
  expect(failure.errors[0]).toBe(nativeFailure);
  expect(failure.cancellations).toHaveLength(1);
  expect(failure.cancellations[0]).toMatchObject({ pid: 43, requestIndex: 1 });
  expect(failure.cancellations[0]?.cancellation.reason).toBe(nativeFailure);
  expect(failure.observations.get(42)).toMatchObject({
    state: "unavailable",
    reason: expect.stringContaining("EISDIR"),
  });
  expect(failure.observations.get(44)).toMatchObject({
    state: "readable",
    identity: "linux-starttime:100",
  });
  for (const handle of fixture.handles.values()) expect(handle.fd).toBe(-1);
});

it("keeps failed close physical while transferring its explicit late cancellation and exact retry owner", async () => {
  const { rows, host } = await prepare();
  const closeFailure = new Error("native descriptor close denied");
  fixture.denied.set("/proc/42/stat", closeFailure);
  const controller = new AbortController();
  fixture.onDeniedClose = (cause) => controller.abort(cause);
  const failure = await host.processIdentities!(
    [rows[0]!],
    controller.signal,
  ).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(ProcessOwnershipIdentityBatchFailure);
  if (!(failure instanceof ProcessOwnershipIdentityBatchFailure)) throw failure;
  expect(failure.origin).toBe("physical");
  expect(isProcessOwnershipInspectionCancellation(failure)).toBe(false);
  expect(failure.failures).toHaveLength(1);
  const cleanup = failure.failures[0]?.cause;
  expect(cleanup).toBeInstanceOf(RegularFileCleanupFailure);
  if (!(cleanup instanceof RegularFileCleanupFailure)) throw cleanup;
  expect(cleanup.cleanupCause).toBe(closeFailure);
  expect(cleanup.completionCancellation?.reason).toBe(closeFailure);
  expect(cleanup.outcome).toMatchObject({ kind: "completed" });
  expect(failure.physicalFailures[0]?.cause).toBe(cleanup);
  expect(failure.cancellations[0]?.cancellation.reason).toBe(closeFailure);
  expect(cleanup.owner.handle).toBe(fixture.handles.get("/proc/42/stat"));
  expect(cleanup.owner.handle.fd).toBeGreaterThanOrEqual(0);
  fixture.denied.clear();
  await cleanup.owner.close();
  expect(cleanup.owner.handle.fd).toBe(-1);
});
