import type { BigIntStats, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";

import {
  NonRegularFileReadError,
  openRegularFile,
  RegularFileAdmissionFailure,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";

const { mockOpen } = vi.hoisted(() => ({ mockOpen: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  open: mockOpen,
}));

afterEach(() => mockOpen.mockReset());

it.each(["cancellation after open", "non-regular metadata", "stat failure"])(
  "retains the exact owner when close fails after %s",
  async (failureCase) => {
    const closeFailure = new Error("native close failed");
    const statFailure = new Error("descriptor stat failed");
    const cancellation = new Error("cancelled after open");
    const controller = new AbortController();
    const file = {
      fd: 17,
      stat: vi.fn(async () => {
        if (failureCase === "cancellation after open") {
          controller.abort(cancellation);
          return { isFile: () => true } as Stats;
        }
        if (failureCase === "non-regular metadata")
          return {
            isFile: () => false,
            isDirectory: () => false,
          } as Stats;
        throw statFailure;
      }),
      close: vi.fn(async () => {
        file.fd = -1;
        throw closeFailure;
      }),
    };
    mockOpen.mockResolvedValue(file as unknown as FileHandle);

    const cause = await openRegularFile("/selected/input", {
      symlinks: "reject",
      signal: controller.signal,
    }).catch((failure: unknown) => failure);

    expect(cause).toBeInstanceOf(RegularFileAdmissionFailure);
    if (!(cause instanceof RegularFileAdmissionFailure))
      throw new Error("Expected an admission failure that retains its owner");
    expect(cause.owner.handle).toBe(file);
    expect(cause.cleanupCause).toBe(closeFailure);
    expect(file.close).toHaveBeenCalledTimes(1);
    await expect(cause.owner.close()).rejects.toBe(closeFailure);
    expect(file.close).toHaveBeenCalledTimes(1);

    if (failureCase === "non-regular metadata")
      expect(cause.cause).toBeInstanceOf(NonRegularFileReadError);
    else if (failureCase === "stat failure")
      expect(cause.cause).toBe(statFailure);
    else expect(cause.cause).toBe(cancellation);
  },
);

it("compares available nanosecond timestamps without rounding away source changes", () => {
  const before = {
    dev: 1n,
    ino: 2n,
    size: 3n,
    mode: 0o100400n,
    mtimeMs: 10n,
    ctimeMs: 20n,
    mtimeNs: 10_000_001n,
    ctimeNs: 20_000_001n,
    isFile: () => true,
  } as BigIntStats;
  expect(sameRegularFileState(before, { ...before })).toBe(true);
  expect(
    sameRegularFileState(before, { ...before, mtimeNs: before.mtimeNs + 1n }),
  ).toBe(false);
  expect(
    sameRegularFileState(before, { ...before, ctimeNs: before.ctimeNs + 1n }),
  ).toBe(false);
});

it.each([
  ["EACCES", -13, "keeps"],
  ["ENXIO", -6, "reclassifies"],
] as const)(
  "%s from opening a non-regular path: admission %s the failure",
  async (code, errno, outcome) => {
    const failure = Object.assign(new Error(`open ${code}`), { code, errno });
    mockOpen.mockRejectedValue(failure);
    // The selected path itself is a directory that stat can still describe.
    const cause = await openRegularFile(tmpdir(), { symlinks: "follow" }).catch(
      (rejected: unknown) => rejected,
    );
    if (outcome === "keeps") expect(cause).toBe(failure);
    else expect(cause).toBeInstanceOf(NonRegularFileReadError);
  },
);

it("keeps cancellation that arrives during the non-regular metadata probe", async () => {
  const controller = new AbortController();
  const cancellation = new Error("cancelled during probe");
  mockOpen.mockImplementation(async () => {
    // The probe stats the path after this rejection; abort before it settles.
    queueMicrotask(() => controller.abort(cancellation));
    throw Object.assign(new Error("open ENXIO"), { code: "ENXIO", errno: -6 });
  });
  await expect(
    openRegularFile(tmpdir(), {
      symlinks: "follow",
      signal: controller.signal,
    }),
  ).rejects.toBe(cancellation);
});
