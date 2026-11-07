import type { BigIntStats, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  isSelectedRegularFileError,
  NonRegularFileReadError,
  openRegularFile,
  RegularFileAdmissionFailure,
  RegularFileOperationCancelled,
  RegularFileSymlinkRefusalError,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

const { mockOpen } = vi.hoisted(() => ({ mockOpen: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  open: mockOpen,
}));

afterEach(() => mockOpen.mockReset());

it("returns the original validated metadata snapshot with its actual descriptor", async () => {
  const { open } =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const root = await createTestTempDirectory("rea-admission-snapshot-");
  const path = join(root, "selected.bin");
  const original = Buffer.from("admitted α测试\0\n");
  await writeFile(path, original);
  let validated: Stats | undefined;
  let opened: FileHandle | undefined;
  mockOpen.mockImplementationOnce(async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    opened = handle;
    const stat = handle.stat.bind(handle);
    vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
      validated = await stat();
      return validated;
    });
    return handle;
  });
  const descriptor = await openRegularFile(path, { symlinks: "reject" });
  try {
    expect(descriptor.handle).toBe(opened);
    expect(descriptor.initial).toBe(validated);
    expect(descriptor.initial.size).toBe(original.length);
    await writeFile(
      path,
      "a later, longer replacement extent on the same inode",
    );
    expect(descriptor.initial).toBe(validated);
    expect(descriptor.initial.size).toBe(original.length);
    expect(descriptor.handle.stat).toHaveBeenCalledOnce();
  } finally {
    await descriptor.handle.close();
  }
});

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
    else {
      expect(cause.cause).toBeInstanceOf(RegularFileOperationCancelled);
      expect(cause.cause).toMatchObject({ reason: cancellation });
    }
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

it("preserves the non-regular admission failure when cancellation arrives during its metadata probe", async () => {
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
  ).rejects.toBeInstanceOf(NonRegularFileReadError);
});

/** Run one admission against the real filesystem despite the mocked `open`. */
const openRealFile = async (path: string) => {
  const { open } =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  mockOpen.mockImplementationOnce(async (...args: Parameters<typeof open>) =>
    open(...args),
  );
  return openRegularFile(path, { symlinks: "reject" });
};

it("names the resolved regular file for a single selected symlink", async () => {
  const root = await createTestTempDirectory("rea-admission-symlink-");
  const real = join(root, "real.bin");
  await writeFile(real, "regular file bytes");
  const link = join(root, "one-link.bin");
  await symlink(real, link);

  const cause = await openRealFile(link).catch((failure: unknown) => failure);
  expect(cause).toBeInstanceOf(RegularFileSymlinkRefusalError);
  if (!(cause instanceof RegularFileSymlinkRefusalError))
    throw new Error("Expected a typed symlink refusal");
  expect(cause.kind).toBe("single");
  expect(cause.code).toBe("ELOOP");
  expect(cause.path).toBe(link);
  expect(cause.resolvedPath).toBe(real);
  expect(cause.cause).toMatchObject({
    code: "ELOOP",
    syscall: "open",
    path: link,
  });
  expect(cause.errno).toBe(Reflect.get(cause.cause as object, "errno"));
  expect(cause.syscall).toBe("open");
  // The category-defining classification is unchanged.
  expect(isSelectedRegularFileError(cause)).toBe(true);
});

it("distinguishes a genuine symlink loop from a single link", async () => {
  const root = await createTestTempDirectory("rea-admission-loop-");
  await symlink("loop-b.bin", join(root, "loop-a.bin"));
  await symlink("loop-a.bin", join(root, "loop-b.bin"));

  const cause = await openRealFile(join(root, "loop-a.bin")).catch(
    (failure: unknown) => failure,
  );
  expect(cause).toBeInstanceOf(RegularFileSymlinkRefusalError);
  if (!(cause instanceof RegularFileSymlinkRefusalError))
    throw new Error("Expected a typed symlink refusal");
  expect(cause.kind).toBe("loop");
  expect(cause.code).toBe("ELOOP");
  expect(cause.resolvedPath).toBeUndefined();
  expect(cause.path).toBe(join(root, "loop-a.bin"));
  expect(isSelectedRegularFileError(cause)).toBe(true);
});

it("names the missing target of a dangling symlink", async () => {
  const root = await createTestTempDirectory("rea-admission-dangling-");
  const missing = join(root, "no-such-file.bin");
  const link = join(root, "dangling.bin");
  await symlink(missing, link);

  const cause = await openRealFile(link).catch((failure: unknown) => failure);
  expect(cause).toBeInstanceOf(RegularFileSymlinkRefusalError);
  if (!(cause instanceof RegularFileSymlinkRefusalError))
    throw new Error("Expected a typed symlink refusal");
  expect(cause.kind).toBe("dangling");
  expect(cause.code).toBe("ELOOP");
  expect(cause.linkTarget).toBe(missing);
  expect(isSelectedRegularFileError(cause)).toBe(true);
});

it("names the resolved target when a symlink points at a directory", async () => {
  const root = await createTestTempDirectory("rea-admission-link-dir-");
  const directory = join(root, "real-dir");
  await mkdir(directory);
  const link = join(root, "link-dir");
  await symlink(directory, link);

  const cause = await openRealFile(link).catch((failure: unknown) => failure);
  expect(cause).toBeInstanceOf(RegularFileSymlinkRefusalError);
  if (!(cause instanceof RegularFileSymlinkRefusalError))
    throw new Error("Expected a typed symlink refusal");
  expect(cause.kind).toBe("non-regular-target");
  expect(cause.resolvedPath).toBe(directory);
  expect(isSelectedRegularFileError(cause)).toBe(true);
});

it("retains the known symlink and lookup failure when a target cannot be traversed", async () => {
  const root = await createTestTempDirectory("rea-admission-unresolved-link-");
  const file = join(root, "file");
  await writeFile(file, "file");
  const link = join(root, "link");
  await symlink(join(file, "child"), link);
  const failure = await openRealFile(link).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RegularFileSymlinkRefusalError);
  if (!(failure instanceof RegularFileSymlinkRefusalError))
    throw new Error("Expected a typed symlink refusal");
  expect(failure).toMatchObject({
    kind: "unresolved",
    path: link,
    code: "ELOOP",
    lookupCause: { code: "ENOTDIR" },
  });
  expect(failure.cause).toMatchObject({
    code: "ELOOP",
    syscall: "open",
    path: link,
  });
  expect(isSelectedRegularFileError(failure)).toBe(true);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "retains a permission failure while identifying the refused symlink",
  async () => {
    const root = await createTestTempDirectory("rea-admission-denied-link-");
    const blocked = join(root, "blocked");
    await mkdir(blocked);
    await writeFile(join(blocked, "file"), "data");
    const link = join(root, "link");
    await symlink(join(blocked, "file"), link);
    await chmod(blocked, 0);
    try {
      const failure = await openRealFile(link).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        kind: "unresolved",
        path: link,
        code: "ELOOP",
        lookupCause: { code: "EACCES" },
      });
    } finally {
      await chmod(blocked, 0o700);
    }
  },
);

it("retains an original ELOOP when following symlinks is allowed", async () => {
  const root = await createTestTempDirectory("rea-admission-follow-loop-");
  const link = join(root, "link");
  await symlink("link", link);
  const failure = Object.assign(new Error("open failed"), { code: "ELOOP" });
  mockOpen.mockRejectedValueOnce(failure);
  await expect(openRegularFile(link, { symlinks: "follow" })).rejects.toBe(
    failure,
  );
});

it("keeps the raw errno when a loop sits in a parent component", async () => {
  const root = await createTestTempDirectory("rea-admission-parent-loop-");
  await symlink("loop-b", join(root, "loop-a"));
  await symlink("loop-a", join(root, "loop-b"));

  const cause = await openRealFile(join(root, "loop-a", "file.bin")).catch(
    (failure: unknown) => failure,
  );
  expect(cause).not.toBeInstanceOf(RegularFileSymlinkRefusalError);
  expect(cause).toMatchObject({ code: "ELOOP" });
  expect(isSelectedRegularFileError(cause)).toBe(true);
});
