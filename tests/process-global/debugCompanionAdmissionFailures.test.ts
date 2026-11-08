import { mkdir, open, writeFile } from "node:fs/promises";
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
  dirReadFailure: undefined as Error | undefined,
  dirCloseFailure: undefined as Error | undefined,
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
      return await original.stat(...args);
    },
    open: async (...args: Parameters<typeof original.open>) => {
      if (args[0] === fault.openPath && fault.openFailure !== undefined)
        throw fault.openFailure;
      const handle = await original.open(...args);
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
        fault.dirCloseFailure !== undefined
      ) {
        const originalClose = directory.close.bind(directory);
        let closed = false;
        if (fault.dirReadFailure !== undefined) {
          directory.read = (() =>
            Promise.reject(fault.dirReadFailure)) as typeof directory.read;
        }
        if (fault.dirCloseFailure !== undefined) {
          directory.close = (async () => {
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
import { AnalysisCleanupLease } from "../../src/artifacts/AnalysisCleanupLease.js";
import { ArtifactResourceScope } from "../../src/artifacts/ArtifactResourceScope.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
} from "../../src/domain/analysisErrorCore.js";
import { BinaryTargetError } from "../../src/domain/configurationErrors.js";
import { RegularFileChangedError } from "../../src/filesystem/RegularFile.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

beforeEach(() => {
  fault.statPath = "";
  fault.statFailure = undefined;
  fault.openPath = "";
  fault.openFailure = undefined;
  fault.memberReadFailure = undefined;
  fault.memberCloseFailure = undefined;
  fault.onMemberClose = undefined;
  fault.dirReadFailure = undefined;
  fault.dirCloseFailure = undefined;
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
