import {
  link,
  mkdir,
  open,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  statPath: "",
  statFailure: undefined as Error | undefined,
  openPath: "",
  openFailure: undefined as Error | undefined,
  memberReadFailure: undefined as Error | undefined,
  memberCloseFailure: undefined as Error | undefined,
  onMemberClose: undefined as ((attempt: number) => void) | undefined,
  onOpenHandle: undefined as
    | ((path: string, handle: FileHandle) => void)
    | undefined,
  transformStats: undefined as
    | (<T extends object>(path: string, stats: T, bigint: boolean) => T)
    | undefined,
  dirReadFailure: undefined as Error | undefined,
  dirCloseFailure: undefined as Error | undefined,
  onDirClose: undefined as ((attempt: number) => void) | undefined,
  onOpendir: undefined as (() => void) | undefined,
  controller: undefined as AbortController | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    stat: async (...args: Parameters<typeof original.stat>) => {
      if (args[0] === fault.statPath && fault.statFailure !== undefined) {
        // The caller cancels while the failing metadata read is pending.
        fault.controller?.abort(new Error("caller cancelled admission"));
        throw fault.statFailure;
      }
      const observed = await original.stat(...args);
      if (
        observed !== undefined &&
        typeof args[0] === "string" &&
        fault.transformStats !== undefined
      ) {
        const bigint =
          typeof args[1] === "object" &&
          args[1] !== null &&
          "bigint" in args[1] &&
          args[1].bigint === true;
        return fault.transformStats(args[0], observed, bigint);
      }
      return observed;
    },
    open: async (...args: Parameters<typeof original.open>) => {
      if (args[0] === fault.openPath && fault.openFailure !== undefined)
        throw fault.openFailure;
      const handle = await original.open(...args);
      if (typeof args[0] === "string") fault.onOpenHandle?.(args[0], handle);
      if (
        args[0] === fault.openPath &&
        (fault.memberReadFailure !== undefined ||
          fault.memberCloseFailure !== undefined ||
          fault.onMemberClose !== undefined)
      ) {
        const originalClose = handle.close.bind(handle);
        let closeAttempt = 0;
        if (fault.memberReadFailure !== undefined) {
          handle.read = (() =>
            Promise.reject(fault.memberReadFailure)) as typeof handle.read;
        }
        if (
          fault.memberCloseFailure !== undefined ||
          fault.onMemberClose !== undefined
        ) {
          handle.close = async () => {
            closeAttempt += 1;
            fault.onMemberClose?.(closeAttempt);
            if (fault.memberCloseFailure !== undefined)
              throw fault.memberCloseFailure;
            await originalClose();
          };
        }
      }
      return handle;
    },
    opendir: async (...args: Parameters<typeof original.opendir>) => {
      fault.onOpendir?.();
      const directory = await original.opendir(...args);
      if (
        fault.dirReadFailure !== undefined ||
        fault.dirCloseFailure !== undefined ||
        fault.onDirClose !== undefined
      ) {
        const originalClose = directory.close.bind(directory);
        let closed = false;
        let closeAttempt = 0;
        if (fault.dirReadFailure !== undefined) {
          directory.read = (() =>
            Promise.reject(fault.dirReadFailure)) as typeof directory.read;
        }
        if (
          fault.dirCloseFailure !== undefined ||
          fault.onDirClose !== undefined
        ) {
          directory.close = (async () => {
            closeAttempt += 1;
            fault.onDirClose?.(closeAttempt);
            if (!closed) {
              closed = true;
              await originalClose();
            }
            if (fault.dirCloseFailure !== undefined)
              throw fault.dirCloseFailure;
          }) as typeof directory.close;
        }
      }
      return directory;
    },
  };
});

import { parseBinaryTarget } from "../../src/application/BinaryTargetResolver.js";
import { admitDebugCompanion } from "../../src/application/DebugCompanionAdmission.js";
import { RetainedRegularFileCleanupFailure } from "../../src/application/RegularFileRead.js";
import { AnalysisCleanupLease } from "../../src/artifacts/AnalysisCleanupLease.js";
import { ArtifactResourceScope } from "../../src/artifacts/ArtifactResourceScope.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
} from "../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../src/domain/analysisErrorProjection.js";
import { BinaryTargetError } from "../../src/domain/configurationErrors.js";
import {
  RegularFileChangedError,
  RegularFileOperationCancelled,
} from "../../src/filesystem/RegularFile.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

beforeEach(() => {
  fault.statPath = "";
  fault.statFailure = undefined;
  fault.openPath = "";
  fault.openFailure = undefined;
  fault.memberReadFailure = undefined;
  fault.memberCloseFailure = undefined;
  fault.onMemberClose = undefined;
  fault.onOpenHandle = undefined;
  fault.transformStats = undefined;
  fault.dirReadFailure = undefined;
  fault.dirCloseFailure = undefined;
  fault.onDirClose = undefined;
  fault.onOpendir = undefined;
  fault.controller = undefined;
});

const UUID = "11111111-2222-3333-4444-555555555555";

const uuidImage = (): Buffer => {
  const bytes = Buffer.alloc(56);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x01000007, 4);
  bytes.writeUInt32LE(3, 8);
  bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(0x1b, 32);
  bytes.writeUInt32LE(24, 36);
  Buffer.from(UUID.replaceAll("-", ""), "hex").copy(bytes, 40);
  return bytes;
};

const admissionFixture = async () => {
  const root = await createTestTempDirectory("rea-dsym-admission-io-");
  const dsymPath = join(root, "selected.dSYM");
  const directory = join(dsymPath, "Contents", "Resources", "DWARF");
  await mkdir(directory, { recursive: true });
  const member = join(directory, "member");
  await writeFile(member, uuidImage());
  const target = join(root, "target");
  await writeFile(target, uuidImage());
  const admit = async (signal?: AbortSignal) => {
    const targetHandle = await open(target, "r");
    try {
      return await admitDebugCompanion({
        dsymPath,
        targetHandle,
        targetSize: 56,
        architecture: "x86_64",
        ...(signal === undefined ? {} : { signal }),
      });
    } finally {
      await targetHandle.close();
    }
  };
  return { dsymPath, directory, member, target, admit };
};

const errno = (code: string): Error =>
  Object.assign(new Error(`controlled ${code}`), { code });

it("keeps an observed bundle I/O failure primary over a later cancellation", async () => {
  const fixture = await admissionFixture();
  const controller = new AbortController();
  const failure = errno("EIO");
  fault.controller = controller;
  fault.statPath = fixture.dsymPath;
  fault.statFailure = failure;
  const rejection: unknown = await fixture.admit(controller.signal).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(rejection).toBeInstanceOf(BinaryTargetError);
  expect(rejection).toMatchObject({
    path: fixture.dsymPath,
    cause: failure,
  });
});

it("reports cancellation instead of caller input when a missing bundle races an abort", async () => {
  const fixture = await admissionFixture();
  const controller = new AbortController();
  fault.controller = controller;
  fault.statPath = fixture.dsymPath;
  fault.statFailure = errno("ENOENT");
  await expect(fixture.admit(controller.signal)).rejects.toBeInstanceOf(
    AnalysisCancelledError,
  );
});

it.each(["EMFILE", "EIO"])(
  "attributes a %s while opening a DWARF member to that member",
  async (code) => {
    const fixture = await admissionFixture();
    fault.openPath = fixture.member;
    fault.openFailure = errno(code);
    const rejection: unknown = await fixture.admit().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(rejection).toBeInstanceOf(BinaryTargetError);
    expect(rejection).toMatchObject({
      path: fixture.member,
      message: expect.stringContaining(code),
    });
  },
);

it("still skips an unreadable DWARF candidate as caller data", async () => {
  const fixture = await admissionFixture();
  fault.openPath = fixture.member;
  fault.openFailure = errno("EACCES");
  expect(await fixture.admit()).toMatchObject({
    ok: false,
    error: {
      diagnostics: {
        dsym_path: fixture.dsymPath,
        architecture: "x86_64",
        target_uuid: UUID,
        rejection: "uuid_mismatch",
      },
    },
  });
});

it("does not deadlock when a pending cleanup owner is retained while parseBinaryTarget admits a dSYM", async () => {
  const fixture = await admissionFixture();
  const resources = new ArtifactResourceScope();
  fault.onOpendir = () => {
    const resource = `${fixture.member}-retained`;
    resources.retain({
      kind: "lease",
      resource,
      lease: new AnalysisCleanupLease(() => Promise.resolve(), [resource]),
    });
  };
  const resolved = await parseBinaryTarget(fixture.target, {
    dsymPath: fixture.dsymPath,
    resources,
  });
  expect(resolved).toMatchObject({
    ok: true,
    value: {
      format: "mach-o",
      debugCompanion: { uuid: UUID },
    },
  });
  await resources.close();
});

it("preserves a changed-member primary failure and binds the cleanup lease when member handle close also fails", async () => {
  const fixture = await admissionFixture();
  const resources = new ArtifactResourceScope();
  fault.openPath = fixture.member;
  fault.memberReadFailure = new RegularFileChangedError(fixture.member);
  fault.memberCloseFailure = errno("EIO");
  const resolved = await parseBinaryTarget(fixture.target, {
    dsymPath: fixture.dsymPath,
    resources,
  });
  expect(resolved.ok).toBe(false);
  if (resolved.ok) return;
  expect(resolved.error).toBeInstanceOf(BinaryTargetError);
  expect(resolved.error.cleanupPrimary).toBeInstanceOf(
    AnalysisArtifactChangedError,
  );
  expect(resolved.error.cleanupIncomplete).toBe(true);
  fault.memberCloseFailure = undefined;
  await resources.close();
  expect(resolved.error.cleanupIncomplete).toBe(false);
});

it("preserves a DWARF directory enumeration failure and binds the cleanup lease when directory close also fails", async () => {
  const fixture = await admissionFixture();
  const resources = new ArtifactResourceScope();
  fault.dirReadFailure = errno("EIO");
  fault.dirCloseFailure = errno("EIO");
  const resolved = await parseBinaryTarget(fixture.target, {
    dsymPath: fixture.dsymPath,
    resources,
  });
  expect(resolved.ok).toBe(false);
  if (resolved.ok) return;
  expect(resolved.error).toBeInstanceOf(BinaryTargetError);
  expect(resolved.error.cleanupPrimary).toBeInstanceOf(BinaryTargetError);
  expect(resolved.error.cleanupPrimary?.message).toContain("EIO");
  expect(resolved.error.cleanupIncomplete).toBe(true);
  expect(resolved.error.cleanupResources).toEqual([fixture.directory]);
  await expect(resources.close()).rejects.toThrow(
    "Artifact cleanup remains incomplete",
  );
});

it.each([1, 2])(
  "preserves the caller abort reason when member read succeeds, close attempt %i cancels, and both close attempts fail",
  async (cancelAttempt) => {
    const fixture = await admissionFixture();
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const abortReason = new Error(`cancelled on member close ${cancelAttempt}`);
    fault.openPath = fixture.member;
    fault.memberCloseFailure = errno("EIO");
    fault.onMemberClose = (attempt) => {
      if (attempt === cancelAttempt) controller.abort(abortReason);
    };
    const resolved = await parseBinaryTarget(fixture.target, {
      dsymPath: fixture.dsymPath,
      resources,
      signal: controller.signal,
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBeInstanceOf(BinaryTargetError);
    expect(resolved.error.cleanupPrimary).toBeInstanceOf(
      AnalysisCancelledError,
    );
    expect(resolved.error.cleanupPrimary?.cause).toBe(abortReason);
    expect(resolved.error.cleanupIncomplete).toBe(true);
    fault.memberCloseFailure = undefined;
    await resources.close();
    expect(resolved.error.cleanupIncomplete).toBe(false);
  },
);

it.each([true, false])(
  "preserves the caller abort reason when DWARF directory enumeration succeeds, directory close cancels, and close fails (scoped=%s)",
  async (useResources) => {
    const fixture = await admissionFixture();
    const resources = useResources ? new ArtifactResourceScope() : undefined;
    const controller = new AbortController();
    const abortReason = new Error("cancelled during DWARF directory close");
    fault.dirCloseFailure = errno("EIO");
    fault.onDirClose = (attempt) => {
      if (attempt === 1) controller.abort(abortReason);
    };
    const resolved = await parseBinaryTarget(fixture.target, {
      dsymPath: fixture.dsymPath,
      ...(resources === undefined ? {} : { resources }),
      signal: controller.signal,
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBeInstanceOf(BinaryTargetError);
    expect(resolved.error.cleanupPrimary).toBeInstanceOf(
      AnalysisCancelledError,
    );
    expect(resolved.error.cleanupPrimary?.cause).toBe(abortReason);
    expect(resolved.error.cleanupIncomplete).toBe(true);
    expect(resolved.error.cleanupResources).toEqual([fixture.directory]);
    if (resources !== undefined) {
      await expect(resources.close()).rejects.toThrow(
        "Artifact cleanup remains incomplete",
      );
      expect(resolved.error.cleanupIncomplete).toBe(true);
    }
  },
);

it("preserves an earlier DWARF directory refusal over cancellation during a failing directory close", async () => {
  const fixture = await admissionFixture();
  const emptyDsym = join(fixture.dsymPath, "..", "empty.dSYM");
  const emptyDwarf = join(emptyDsym, "Contents", "Resources", "DWARF");
  await mkdir(emptyDwarf, { recursive: true });
  const resources = new ArtifactResourceScope();
  const controller = new AbortController();
  fault.dirCloseFailure = errno("EIO");
  fault.onDirClose = (attempt) => {
    if (attempt === 1)
      controller.abort(new Error("cancelled after empty-directory refusal"));
  };
  const resolved = await parseBinaryTarget(fixture.target, {
    dsymPath: emptyDsym,
    resources,
    signal: controller.signal,
  });
  expect(resolved.ok).toBe(false);
  if (resolved.ok) return;
  expect(resolved.error).toBeInstanceOf(BinaryTargetError);
  expect(resolved.error.cleanupPrimary).toBeInstanceOf(BinaryTargetError);
  expect(resolved.error.cleanupPrimary).toMatchObject({
    constraint: "debug_companion_rejected",
    message: expect.stringContaining("contains no DWARF member file"),
  });
  expect(resolved.error.cleanupIncomplete).toBe(true);
  await expect(resources.close()).rejects.toThrow(
    "Artifact cleanup remains incomplete",
  );
});

it("preserves an earlier DWARF directory refusal over cancellation during a succeeding directory close", async () => {
  const fixture = await admissionFixture();
  const emptyDsym = join(fixture.dsymPath, "..", "empty-ok-close.dSYM");
  const emptyDwarf = join(emptyDsym, "Contents", "Resources", "DWARF");
  await mkdir(emptyDwarf, { recursive: true });
  const resources = new ArtifactResourceScope();
  const controller = new AbortController();
  fault.onDirClose = (attempt) => {
    if (attempt === 1)
      controller.abort(
        new Error("cancelled during succeeding directory close"),
      );
  };
  const resolved = await parseBinaryTarget(fixture.target, {
    dsymPath: emptyDsym,
    resources,
    signal: controller.signal,
  });
  expect(resolved).toMatchObject({
    ok: false,
    error: {
      constraint: "debug_companion_rejected",
      message: expect.stringContaining("contains no DWARF member file"),
    },
  });
  await resources.close();
});

const duplicateSliceMember = (): Buffer => {
  const first = uuidImage();
  Buffer.from(
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".replaceAll("-", ""),
    "hex",
  ).copy(first, 40);
  const second = uuidImage();
  const container = Buffer.alloc(128 + first.length + second.length);
  container.writeUInt32BE(0xcafebabe, 0);
  container.writeUInt32BE(2, 4);
  container.writeInt32BE(0x01000007, 8);
  container.writeInt32BE(3, 12);
  container.writeUInt32BE(64, 16);
  container.writeUInt32BE(first.length, 20);
  container.writeUInt32BE(3, 24);
  container.writeInt32BE(0x01000007, 28);
  container.writeInt32BE(3, 32);
  container.writeUInt32BE(128, 36);
  container.writeUInt32BE(second.length, 40);
  container.writeUInt32BE(3, 44);
  first.copy(container, 64);
  second.copy(container, 128);
  return container;
};

it.each(["none", "initial", "both"] as const)(
  "preserves a member refusal over final-close cancellation (close failure=%s)",
  async (failMode) => {
    const fixture = await admissionFixture();
    await writeFile(fixture.member, duplicateSliceMember());
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    fault.openPath = fixture.member;
    if (failMode !== "none") fault.memberCloseFailure = errno("EIO");
    fault.onMemberClose = (attempt) => {
      if (attempt === 1)
        controller.abort(
          new Error(`cancelled during member close (${failMode})`),
        );
      if (failMode === "initial" && attempt === 2)
        fault.memberCloseFailure = undefined;
    };
    const resolved = await parseBinaryTarget(fixture.target, {
      dsymPath: fixture.dsymPath,
      resources,
      signal: controller.signal,
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBeInstanceOf(BinaryTargetError);
    if (failMode === "both") {
      expect(resolved.error.cleanupPrimary).toBeInstanceOf(BinaryTargetError);
      expect(resolved.error.cleanupPrimary).toMatchObject({
        constraint: "debug_companion_rejected",
        diagnostics: { rejection: "ambiguous_member_slice" },
      });
      expect(resolved.error.cleanupIncomplete).toBe(true);
      fault.memberCloseFailure = undefined;
      await resources.close();
      expect(resolved.error.cleanupIncomplete).toBe(false);
      return;
    }
    expect(resolved.error).toMatchObject({
      constraint: "debug_companion_rejected",
      diagnostics: { rejection: "ambiguous_member_slice" },
    });
    await resources.close();
  },
);

it("preserves a conflicting_matching_members refusal when the conflicting member cancels during close", async () => {
  const fixture = await admissionFixture();
  const conflicting = join(fixture.directory, "zz-conflicting");
  await writeFile(
    conflicting,
    Buffer.concat([uuidImage(), Buffer.alloc(16, 0x90)]),
  );
  const resources = new ArtifactResourceScope();
  const controller = new AbortController();
  fault.openPath = conflicting;
  fault.onMemberClose = (attempt) => {
    if (attempt === 1)
      controller.abort(new Error("cancelled closing conflicting member"));
  };
  const resolved = await parseBinaryTarget(fixture.target, {
    dsymPath: fixture.dsymPath,
    resources,
    signal: controller.signal,
  });
  expect(resolved).toMatchObject({
    ok: false,
    error: {
      constraint: "debug_companion_rejected",
      diagnostics: { rejection: "conflicting_matching_members" },
    },
  });
  await resources.close();
});

it("normalizes RegularFileOperationCancelled and read faults across member close failures and succeeded close retries", async () => {
  const fixture = await admissionFixture();
  const reason = new Error("cancelled inside regular-file read");
  fault.openPath = fixture.member;
  fault.memberReadFailure = new RegularFileOperationCancelled(reason);
  fault.memberCloseFailure = errno("EIO");

  let caught: unknown;
  try {
    await fixture.admit();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RetainedRegularFileCleanupFailure);
  if (!(caught instanceof RetainedRegularFileCleanupFailure)) return;
  expect(caught.outcome).toMatchObject({
    kind: "failed",
    cause: expect.any(AnalysisCancelledError),
  });
  if (caught.outcome.kind === "failed")
    expect((caught.outcome.cause as AnalysisCancelledError).cause).toBe(reason);
  fault.memberCloseFailure = undefined;
  await caught.owner.close();

  // With borrowed resources, when initial close fails and retry succeeds after a
  // read or stability fault (including an admission-path code such as EACCES once
  // the member handle has been admitted), readMemberWithBorrowedResources must
  // rethrow the normalized error rather than returning ok(null) / uuid_mismatch.
  for (const readFault of [
    errno("EIO"),
    errno("EACCES"),
    new RegularFileChangedError(fixture.member),
  ]) {
    const resources = new ArtifactResourceScope();
    fault.openPath = fixture.member;
    fault.memberReadFailure = readFault;
    fault.memberCloseFailure = errno("EIO");
    fault.onMemberClose = (attempt) => {
      if (attempt === 2) fault.memberCloseFailure = undefined;
    };
    const retried = await parseBinaryTarget(fixture.target, {
      dsymPath: fixture.dsymPath,
      resources,
    });
    expect(retried.ok).toBe(false);
    if (retried.ok) return;
    if (readFault instanceof RegularFileChangedError) {
      expect(retried.error).toBeInstanceOf(AnalysisArtifactChangedError);
      expect(retried.error).toMatchObject({ path: fixture.member });
    } else {
      expect(retried.error).toBeInstanceOf(BinaryTargetError);
      expect(retried.error).toMatchObject({
        path: fixture.member,
        message: expect.stringContaining(
          `reading the dSYM DWARF member failed with ${String((readFault as { code?: string }).code)}`,
        ),
      });
    }
    await resources.close();
  }

  // Conversely, when openRegularFile rejects a non-regular entry before reading
  // (NonRegularFileReadError) and its initial close fails while retry close
  // succeeds, readMemberWithBorrowedResources returns ok(null) so the caller skips
  // that entry and still admits the matching DWARF member.
  const nonRegularEntry = join(fixture.directory, "00-non-regular");
  await writeFile(nonRegularEntry, Buffer.alloc(8));
  const resources = new ArtifactResourceScope();
  fault.openPath = nonRegularEntry;
  fault.memberReadFailure = undefined;
  fault.memberCloseFailure = errno("EIO");
  fault.onMemberClose = (attempt) => {
    if (attempt === 2) fault.memberCloseFailure = undefined;
  };
  fault.onOpenHandle = (openedPath, handle) => {
    if (openedPath !== nonRegularEntry) return;
    const originalStat = handle.stat.bind(handle);
    handle.stat = (async (options?: { bigint?: boolean }) => {
      const stats = await originalStat(options as never);
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
        isFile: () => false,
        isDirectory: () => false,
      });
    }) as typeof handle.stat;
  };
  const admittedAfterSkip = await parseBinaryTarget(fixture.target, {
    dsymPath: fixture.dsymPath,
    resources,
  });
  expect(admittedAfterSkip).toMatchObject({
    ok: true,
    value: {
      format: "mach-o",
      debugCompanion: {
        memberPath: fixture.member,
        uuid: UUID,
      },
    },
  });
  await resources.close();
});

it("deduplicates hard-linked member digests by exact 64-bit inode identity without colliding on zero or >2^53 inodes", async () => {
  const fixture = await admissionFixture();
  const hardlink = join(fixture.directory, "member-hardlink");
  await link(fixture.member, hardlink);
  let digestReads = 0;
  fault.onOpenHandle = (openedPath, handle) => {
    if (openedPath !== fixture.member && openedPath !== hardlink) return;
    const originalRead = handle.read.bind(handle) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    handle.read = (async (...args: unknown[]) => {
      // Prefix UUID read requests 56 bytes (clamped to fileSize); digestOpenHandle
      // passes a 64 KiB buffer at position 0.
      if (
        args[0] instanceof Uint8Array &&
        args[2] === 64 * 1024 &&
        args[3] === 0
      )
        digestReads += 1;
      return await originalRead(...args);
    }) as typeof handle.read;
  };
  const admitted = await fixture.admit();
  expect(admitted).toMatchObject({ ok: true });
  expect(digestReads).toBe(1);

  // Two distinct matching members of identical size (72 bytes) with differing
  // trailing DWARF bytes must never collide when ino === 0n or when 64-bit inodes
  // exceed Number.MAX_SAFE_INTEGER (e.g. 2^53 vs 2^53 + 1 on NTFS).
  for (const mode of ["zero-inode", "ntfs-high-inode"] as const) {
    const conflictFixture = await admissionFixture();
    const firstBytes = Buffer.concat([uuidImage(), Buffer.alloc(16, 0xaa)]);
    const secondBytes = Buffer.concat([uuidImage(), Buffer.alloc(16, 0xbb)]);
    const secondMember = join(conflictFixture.directory, "member-second");
    await writeFile(conflictFixture.member, firstBytes);
    await writeFile(secondMember, secondBytes);
    fault.transformStats = (statPath, stats, bigint) => {
      if (statPath !== conflictFixture.member && statPath !== secondMember)
        return stats;
      const isSecond = statPath === secondMember;
      return Object.assign(
        Object.create(Object.getPrototypeOf(stats)),
        stats,
        bigint
          ? {
              dev: 1n,
              ino:
                mode === "zero-inode"
                  ? 0n
                  : isSecond
                    ? 9007199254740993n
                    : 9007199254740992n,
            }
          : {
              dev: 1,
              ino: mode === "zero-inode" ? 0 : 9007199254740992,
            },
      );
    };
    fault.onOpenHandle = (openedPath, handle) => {
      if (openedPath !== conflictFixture.member && openedPath !== secondMember)
        return;
      const originalStat = handle.stat.bind(handle);
      handle.stat = (async (options?: { bigint?: boolean }) => {
        const stats = await originalStat(options as never);
        return fault.transformStats!(
          openedPath,
          stats,
          options?.bigint === true,
        );
      }) as typeof handle.stat;
    };
    const rejected = await conflictFixture.admit();
    expect(rejected).toMatchObject({
      ok: false,
      error: {
        diagnostics: { rejection: "conflicting_matching_members" },
      },
    });
  }
});

it.each(["member", "directory"] as const)(
  "retains both companion %s and executable cleanup owners when both handles fail to close",
  async (companionKind) => {
    const fixture = await admissionFixture();
    if (companionKind === "member") {
      const handle = await open(fixture.member, "r+");
      try {
        await handle.truncate(1024 * 1024 * 1024 + 1);
      } finally {
        await handle.close();
      }
    }
    const resources = new ArtifactResourceScope();
    let denyTargetClose = true;
    let denyCompanionClose = true;
    const companionResource =
      companionKind === "member" ? fixture.member : fixture.directory;
    if (companionKind === "directory") {
      fault.dirReadFailure = errno("EIO");
      fault.dirCloseFailure = errno("EIO");
    }
    fault.onOpenHandle = (openedPath, handle) => {
      if (
        openedPath !== fixture.target &&
        !(companionKind === "member" && openedPath === fixture.member)
      )
        return;
      const originalClose = handle.close.bind(handle);
      let closed = false;
      handle.close = async () => {
        const denied =
          openedPath === fixture.target ? denyTargetClose : denyCompanionClose;
        if (denied)
          throw new Error(
            openedPath === fixture.target
              ? "target close denied"
              : "member close denied",
          );
        if (!closed) {
          closed = true;
          await originalClose();
        }
      };
    };
    try {
      const resolved = await parseBinaryTarget(fixture.target, {
        dsymPath: fixture.dsymPath,
        resources,
      });
      expect(resolved.ok).toBe(false);
      if (resolved.ok) return;
      expect(resolved.error.cleanupIncomplete).toBe(true);
      expect(resolved.error.cleanupResources).toEqual([
        companionResource,
        fixture.target,
      ]);
      expect(projectAnalysisError(resolved.error)).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          resources: [companionResource, fixture.target],
        },
      });

      // Releasing only the executable handle must leave cleanupIncomplete true
      // and narrow reported resources to the remaining companion handle.
      denyTargetClose = false;
      await expect(resources.retryCleanup()).rejects.toThrow(
        "Artifact cleanup remains incomplete",
      );
      expect(resolved.error.cleanupIncomplete).toBe(true);
      expect(resolved.error.cleanupResources).toEqual([companionResource]);
      expect(projectAnalysisError(resolved.error)).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          resources: [companionResource],
        },
      });

      if (companionKind === "member") {
        // Releasing the retryable member handle resolves the composed error and
        // reveals the underlying member-size rejection.
        denyCompanionClose = false;
        await resources.retryCleanup();
        expect(resolved.error.cleanupIncomplete).toBe(false);
        expect(resolved.error.cleanupResources).toEqual([]);
        expect(projectAnalysisError(resolved.error)).toMatchObject({
          code: "invalid_request",
          details: {
            diagnostics: { limit: "dsym_member_size_bytes" },
          },
        });
      } else {
        // OwnedDirectoryHandle cannot be retried after Dir.close() fails; scope
        // close keeps the composed error incomplete for the directory handle.
        await expect(resources.close()).rejects.toThrow(
          "Artifact cleanup remains incomplete",
        );
        expect(resolved.error.cleanupIncomplete).toBe(true);
        expect(resolved.error.cleanupResources).toEqual([fixture.directory]);
      }
    } finally {
      denyTargetClose = false;
      denyCompanionClose = false;
      fault.dirCloseFailure = undefined;
      if (companionKind === "member") await resources.close();
    }
  },
);
