import {
  lstat,
  appendFile,
  open,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { phaseGate } from "../../support/lifecycleHarness.js";
import {
  completedStableArtifactStream,
  readStableArtifact,
  streamStableArtifact,
} from "../../../src/resources/readStableArtifact.js";
import {
  artifactFileCompletion,
  ArtifactFileCleanupFailure,
  ArtifactFileCancelled,
  withArtifactFileHandle,
} from "../../../src/resources/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../../../src/resources/ArtifactResourceScope.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("reads an empty artifact and rejects symlink, size, and cancellation boundaries", async () => {
  const root = await createTestTempDirectory("rea-stable-artifact-");
  const path = join(root, "source.bin");
  await writeFile(path, Buffer.from([0, 255, 254]));
  await expect(readStableArtifact(path, 2)).rejects.toMatchObject({
    reason: "limit",
  });
  await writeFile(path, "");
  expect((await readStableArtifact(path, 0)).bytes.length).toBe(0);
  const real = join(root, "original.bin");
  await rename(path, real);
  await symlink(real, path);
  await expect(readStableArtifact(path, 3)).rejects.toMatchObject({
    reason: "path",
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    readStableArtifact(real, 3, controller.signal),
  ).rejects.toMatchObject({
    reason: "cancelled",
    cause: controller.signal.reason,
  });
});

it("observes all bytes across short reads and retains only the selected prefix during streaming", async () => {
  const root = await createTestTempDirectory("rea-stable-chunks-");
  const path = join(root, "source.bin");
  const bytes = Buffer.alloc(1_500_000);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = index % 251;
  await writeFile(path, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const snapshot = await readStableArtifact(path, bytes.length, undefined, {
    lstat: (selected) => lstat(selected, { bigint: true }),
    open: async (...args) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle);
      Object.defineProperty(handle, "read", {
        value: async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) =>
          read(
            buffer,
            offset,
            position === 0 ? Math.min(length, 65531) : length,
            position,
          ),
      });
      return handle;
    },
  });
  expect(snapshot.bytes.equals(bytes)).toBe(true);
  expect(snapshot.sha256).toBe(digest);

  const prefixLength = 17;
  let observed = 0;
  const stream = await streamStableArtifact(path, bytes.length, {
    retainBytes: () => prefixLength,
    onChunk: (chunk) => {
      expect(chunk.length).toBeLessThanOrEqual(65536);
      const end = observed + chunk.length;
      expect(chunk.equals(bytes.subarray(observed, end))).toBe(true);
      observed = end;
    },
  });
  expect(observed).toBe(bytes.length);
  expect(stream).toEqual({
    sha256: digest,
    size: bytes.length,
    prefix: bytes.subarray(0, prefixLength),
  });
});

it.each([-1, Number.NaN, "oversized"] as const)(
  "refuses malformed descriptor byte counts: %s",
  async (count) => {
    const root = await createTestTempDirectory("rea-stable-read-count-");
    const path = join(root, "source.bin");
    await writeFile(path, "base");
    await expect(
      readStableArtifact(path, 64, undefined, {
        lstat: (selected) => lstat(selected, { bigint: true }),
        open: async (...args) => {
          const handle = await open(...args);
          Object.defineProperty(handle, "read", {
            value: async (buffer: Buffer, _offset: number, length: number) => ({
              bytesRead: count === "oversized" ? length + 1 : count,
              buffer,
            }),
          });
          return handle;
        },
      }),
    ).rejects.toMatchObject({ reason: "format" });
  },
);

it.each(["complete", "fail"] as const)(
  "joins an admitted descriptor read before cancellation finalization: %s",
  async (outcome) => {
    const root = await createTestTempDirectory("rea-stable-read-cancel-");
    const path = join(root, "source.bin");
    const bytes = Buffer.from("base");
    await writeFile(path, bytes);
    const controller = new AbortController();
    const reason = { request: "cancelled while descriptor read was pending" };
    const physical = Object.assign(new Error("pending physical read failed"), {
      code: "EIO",
    });
    const stableRead = phaseGate();
    let descriptor: Awaited<ReturnType<typeof open>> | undefined;
    const reading = readStableArtifact(path, 64, controller.signal, {
      lstat: (selected) => lstat(selected, { bigint: true }),
      open: async (...args) => {
        const handle = await open(...args);
        descriptor = handle;
        Object.defineProperty(handle, "read", {
          value: async (buffer: Buffer, offset: number) => {
            await stableRead.hold();
            buffer.set(bytes, offset);
            return { bytesRead: bytes.length, buffer };
          },
        });
        return handle;
      },
    });
    let settled = false;
    const result = reading
      .catch((cause: unknown) => cause)
      .finally(() => {
        settled = true;
      });
    try {
      await stableRead.reached(result, "stable artifact read");
      controller.abort(reason);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(descriptor?.fd).toBeGreaterThanOrEqual(0);
      if (outcome === "fail") stableRead.reject(physical);
      else stableRead.release();
      const failure = await result;
      if (outcome === "fail") expect(failure).toBe(physical);
      else
        expect(failure).toMatchObject({ reason: "cancelled", cause: reason });
      expect(artifactFileCompletion(failure)).toBeUndefined();
      expect(descriptor?.fd).toBe(-1);
    } finally {
      controller.abort(reason);
      stableRead.release();
      await result;
    }
  },
);

it.each(["integrity", "limit", "io"] as const)(
  "preserves %s precedence after growth beyond the initial snapshot size",
  async (outcome) => {
    const root = await createTestTempDirectory("rea-stable-growth-");
    const path = join(root, "source.bin");
    await writeFile(path, "base");
    const extra = Buffer.from("expanded");
    const physical = Object.assign(new Error("late physical read failure"), {
      code: "EIO",
    });
    const reading = readStableArtifact(
      path,
      outcome === "limit" ? 12 : 1024,
      undefined,
      {
        lstat: (selected) => lstat(selected, { bigint: true }),
        open: async (...args) => {
          const handle = await open(...args);
          const read = handle.read.bind(handle);
          let appended = 0;
          Object.defineProperty(handle, "read", {
            value: async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number,
            ) => {
              if (appended < 2 && position >= 4 + appended * extra.length) {
                await appendFile(path, extra);
                appended += 1;
              }
              if (outcome === "io" && position >= 4 + 2 * extra.length)
                throw physical;
              return read(buffer, offset, length, position);
            },
          });
          return handle;
        },
      },
    );
    if (outcome === "io") await expect(reading).rejects.toBe(physical);
    else
      await expect(reading).rejects.toMatchObject({
        reason: outcome,
        ...(outcome === "limit" ? { boundary: "file-size" } : {}),
      });
  },
);

it("bounds allocation when the opened descriptor exceeds the selected byte budget", async () => {
  const root = await createTestTempDirectory("rea-stable-admission-race-");
  const path = join(root, "source.bin");
  await writeFile(path, "base");
  await expect(
    readStableArtifact(path, 64, undefined, {
      lstat: (selected) => lstat(selected, { bigint: true }),
      open: async (...args) => {
        const handle = await open(...args);
        const stat = handle.stat.bind(handle);
        Object.defineProperty(handle, "stat", {
          value: async () =>
            Object.assign(await stat({ bigint: true }), { size: 1n << 62n }),
        });
        return handle;
      },
    }),
  ).rejects.toMatchObject({ reason: "integrity" });
});

it("does not start a read when cancellation arrives during descriptor admission", async () => {
  const root = await createTestTempDirectory("rea-stable-admission-cancel-");
  const path = join(root, "source.bin");
  await writeFile(path, "base");
  const controller = new AbortController();
  const reason = { request: "cancelled while admitting descriptor" };
  let reads = 0;
  const reading = readStableArtifact(path, 64, controller.signal, {
    lstat: (selected) => lstat(selected, { bigint: true }),
    open: async (...args) => {
      const handle = await open(...args);
      const stat = handle.stat.bind(handle);
      const read = handle.read.bind(handle);
      Object.defineProperty(handle, "stat", {
        value: async () => {
          const facts = await stat({ bigint: true });
          controller.abort(reason);
          return facts;
        },
      });
      Object.defineProperty(handle, "read", {
        value: async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          reads += 1;
          return read(buffer, offset, length, position);
        },
      });
      return handle;
    },
  });
  await expect(reading).rejects.toMatchObject({
    reason: "cancelled",
    cause: reason,
  });
  expect(reads).toBe(0);
});

const checkChange = async (
  stage: "before-open" | "after-read" | "symlink-replacement",
): Promise<void> => {
  const root = await createTestTempDirectory("rea-stable-read-");
  const path = join(root, "selected");
  await writeFile(path, "original evidence");
  let inspected = 0;
  const reading = readStableArtifact(path, 1024, undefined, {
    async lstat(selected) {
      inspected++;
      if (stage === "after-read" && inspected === 2) await unlink(selected);
      const metadata = await lstat(selected, { bigint: true });
      if (inspected === 1 && stage !== "after-read") {
        await unlink(selected);
        if (stage === "symlink-replacement") await symlink("missing", selected);
      }
      return metadata;
    },
    open,
  });
  await expect(reading).rejects.toMatchObject({ reason: "integrity" });
};

it.each(["before-open", "after-read"] as const)(
  "retains an actual post-validation %s change as integrity failure",
  checkChange,
);

it.skipIf(process.platform === "win32")(
  "retains a post-validation symlink replacement as an integrity failure",
  () => checkChange("symlink-replacement"),
);

it("keeps initially missing inputs distinguishable from later changes", async () => {
  const root = await createTestTempDirectory("rea-stable-missing-");
  await expect(
    readStableArtifact(join(root, "missing"), 1024),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

const heldDescriptor = async () => {
  const root = await createTestTempDirectory("rea-stable-close-owner-");
  const path = join(root, "selected.bin");
  const bytes = Buffer.from([0, 255, 1, 254]);
  await writeFile(path, bytes);
  const handle = await open(path, "r");
  const nativeClose = handle.close.bind(handle);
  const closeFailure = new Error("controlled descriptor close failure");
  let allowClose = false;
  handle.close = async () => {
    if (!allowClose) throw closeFailure;
    await nativeClose();
  };
  onTestFinished(async () => {
    if (handle.fd >= 0) await nativeClose();
  });
  return {
    path,
    bytes,
    handle,
    nativeClose,
    closeFailure,
    release: () => {
      allowClose = true;
    },
    fileSystem: {
      lstat: (selected: string) => lstat(selected, { bigint: true }),
      open: async () => handle,
    },
  };
};

it.each(["scoped", "transferred"])(
  "keeps incomplete private bytes unavailable through %s close failure",
  async (ownership) => {
    const file = await heldDescriptor();
    const read = file.handle.read.bind(file.handle);
    Object.defineProperty(file.handle, "read", {
      value: async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) =>
        position >= 2
          ? { bytesRead: 0, buffer }
          : read(buffer, offset, Math.min(length, 2 - position), position),
    });
    const scope =
      ownership === "scoped" ? new ArtifactResourceScope() : undefined;
    const failure = await readStableArtifact(
      file.path,
      1024,
      undefined,
      file.fileSystem,
      scope,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
    if (!(failure instanceof ArtifactFileCleanupFailure))
      throw new Error("Missing incomplete read owner");
    expect(failure.fileCleanupFailure.outcome).toMatchObject({
      kind: "failed",
      cause: { reason: "integrity" },
    });
    expect(artifactFileCompletion(failure)).toBeUndefined();
    file.release();
    if (scope !== undefined) await scope.close();
    else await failure.cleanupLease.release();
    expect(file.handle.fd).toBe(-1);
  },
);

it.each(["scoped", "transferred"])(
  "retains exact completed bytes and descriptor cleanup under %s ownership",
  async (ownership) => {
    const file = await heldDescriptor();
    const scope =
      ownership === "scoped" ? new ArtifactResourceScope() : undefined;
    const failure = await readStableArtifact(
      file.path,
      1024,
      undefined,
      file.fileSystem,
      scope,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
    if (!(failure instanceof ArtifactFileCleanupFailure))
      throw new Error("Missing descriptor owner");
    expect(failure.fileCleanupFailure.owner.handle).toBe(file.handle);
    expect(failure.fileCleanupFailure.cleanupCause).toBe(file.closeFailure);
    expect(artifactFileCompletion(failure)).toEqual({
      kind: "completed",
      value: {
        bytes: file.bytes,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
      },
      cancellation: undefined,
    });
    expect(file.handle.fd).toBeGreaterThanOrEqual(0);
    expect(failure.cleanup?.resources).toEqual([file.path]);
    expect(scope?.hasPending ?? false).toBe(ownership === "scoped");
    file.release();
    if (scope !== undefined) await scope.close();
    else await failure.cleanupLease.release();
    expect(file.handle.fd).toBe(-1);
  },
);

it.each([new Error("primary read failure"), undefined, null])(
  "preserves the explicit failed read outcome %j through close rejection",
  async (primary) => {
    const file = await heldDescriptor();
    file.handle.stat = async () => {
      throw primary;
    };
    const scope = new ArtifactResourceScope();
    const failure = await readStableArtifact(
      file.path,
      1024,
      undefined,
      file.fileSystem,
      scope,
    ).catch((cause: unknown) => cause);
    if (!(failure instanceof ArtifactFileCleanupFailure))
      throw new Error("Missing typed read outcome");
    expect(failure.fileCleanupFailure.outcome).toEqual({
      kind: "failed",
      cause: primary,
    });
    expect(failure.fileCleanupFailure.cleanupCause).toBe(file.closeFailure);
    expect(artifactFileCompletion(failure)).toBeUndefined();
    file.release();
    await scope.close();
    expect(file.handle.fd).toBe(-1);
  },
);

it.each(["confirmed close", "failed close"] as const)(
  "retains completed read facts and cancellation during %s",
  async (outcome) => {
    const file = await heldDescriptor();
    const controller = new AbortController();
    const reason = new Error("cancelled during descriptor finalization");
    file.handle.close = async () => {
      controller.abort(reason);
      if (outcome === "failed close") throw file.closeFailure;
      await file.nativeClose();
    };
    const failure = await readStableArtifact(
      file.path,
      1024,
      controller.signal,
      file.fileSystem,
    ).catch((cause: unknown) => cause);
    const completed = artifactFileCompletion(failure);
    expect(completed).toMatchObject({
      kind: "completed",
      value: { bytes: file.bytes },
    });
    expect(completed?.cancellation?.reason).toBe(reason);
    if (outcome === "failed close") {
      if (!(failure instanceof ArtifactFileCleanupFailure))
        throw new Error("Missing cleanup ownership");
      expect(failure.fileCleanupFailure.cleanupCause).toBe(file.closeFailure);
      expect(file.handle.fd).toBeGreaterThanOrEqual(0);
      file.handle.close = file.nativeClose;
      await failure.cleanupLease.release();
    } else {
      if (!(failure instanceof ArtifactFileCancelled))
        throw new Error("Missing late cancellation");
      expect(failure.cause).toBe(reason);
    }
    expect(file.handle.fd).toBe(-1);
  },
);

it("transfers the exact owner even when the caller's retention boundary rejects it", async () => {
  const file = await heldDescriptor();
  const retentionFailure = new Error("controlled owner-retention failure");
  class RejectingScope extends ArtifactResourceScope {
    override retain(): void {
      throw retentionFailure;
    }
  }
  const failure = await readStableArtifact(
    file.path,
    1024,
    undefined,
    file.fileSystem,
    new RejectingScope(),
  ).catch((cause: unknown) => cause);
  if (!(failure instanceof ArtifactFileCleanupFailure))
    throw new Error("Lost cleanup capability after retention failure");
  expect(failure.fileCleanupFailure.retention).toEqual({
    kind: "callback_threw",
    cause: retentionFailure,
  });
  expect(failure.fileCleanupFailure.cleanupCause).toBe(file.closeFailure);
  expect(failure.fileCleanupFailure.owner.handle).toBe(file.handle);
  file.release();
  await failure.cleanupLease.release();
  expect(file.handle.fd).toBe(-1);
});

it("does not turn a retention callback abort into completed-file cancellation", async () => {
  const file = await heldDescriptor();
  const controller = new AbortController();
  class AbortingScope extends ArtifactResourceScope {
    override retain(
      owner: Parameters<ArtifactResourceScope["retain"]>[0],
    ): void {
      controller.abort(null);
      super.retain(owner);
    }
  }
  const scope = new AbortingScope();
  try {
    const failure: unknown = await withArtifactFileHandle(
      file.path,
      file.handle,
      scope,
      controller.signal,
      async () => file.bytes,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
    if (!(failure instanceof ArtifactFileCleanupFailure))
      throw new Error("Missing file cleanup owner");
    expect(failure.fileCleanupFailure.outcome).toEqual({
      kind: "completed",
      value: file.bytes,
    });
    expect(artifactFileCompletion(failure)?.cancellation).toBeUndefined();
    expect(failure.reason).not.toBe("cancelled");
    file.release();
    await failure.cleanupLease.release();
    expect(file.handle.fd).toBe(-1);
  } finally {
    file.release();
    await scope.close();
  }
});

it("keeps a completed void operation distinct from a failed operation and arbitrary error payloads", async () => {
  const file = await heldDescriptor();
  const scope = new ArtifactResourceScope();
  try {
    const failure: unknown = await withArtifactFileHandle(
      file.path,
      file.handle,
      scope,
      undefined,
      async () => undefined,
    ).catch((cause: unknown) => cause);
    expect(artifactFileCompletion(failure)).toEqual({
      kind: "completed",
      value: undefined,
      cancellation: undefined,
    });
    expect(artifactFileCompletion({ cause: failure })).toBeUndefined();
    file.release();
    await scope.close();
    expect(file.handle.fd).toBe(-1);
  } finally {
    file.release();
    await scope.close();
  }
});

describe("streamStableArtifact async chunks and custom chunkBytes", () => {
  it("awaits each async callback before admitting another physical read", async () => {
    const root = await createTestTempDirectory("rea-stable-async-stream-");
    const path = join(root, "streamed.bin");
    const payload = Buffer.alloc(300, 0x41);
    payload.write("tail", payload.length - 4);
    await writeFile(path, payload);
    const firstChunk = phaseGate();
    let admittedReads = 0;
    const seenSizes: number[] = [];
    const reading = streamStableArtifact(path, payload.length, {
      chunkBytes: 128,
      retainBytes: () => 16,
      fileSystem: {
        lstat: (selected) => lstat(selected, { bigint: true }),
        open: async (...args) => {
          const handle = await open(...args);
          const read = handle.read.bind(handle);
          Object.defineProperty(handle, "read", {
            value: (...params: Parameters<typeof read>) => {
              admittedReads += 1;
              return read(...params);
            },
          });
          return handle;
        },
      },
      onChunk: async (chunk) => {
        seenSizes.push(chunk.length);
        if (seenSizes.length === 1) await firstChunk.hold();
      },
    });
    try {
      await firstChunk.reached(reading, "first streamed artifact callback");
      expect(admittedReads).toBe(1);
      firstChunk.release();
      expect(await reading).toEqual({
        size: payload.length,
        prefix: payload.subarray(0, 16),
        sha256: createHash("sha256").update(payload).digest("hex"),
      });
      expect(seenSizes).toEqual([16, 128, 128, 28]);
    } finally {
      firstChunk.release();
      await Promise.allSettled([reading]);
    }
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "rejects invalid chunkBytes (%j) with format failure",
    async (chunkBytes) => {
      const root = await createTestTempDirectory("rea-stable-bad-chunk-");
      const path = join(root, "sample.bin");
      await writeFile(path, "abc");
      await expect(
        streamStableArtifact(path, 3, {
          chunkBytes,
          retainBytes: () => 0,
          onChunk: async () => {},
        }),
      ).rejects.toMatchObject({ reason: "format" });
    },
  );

  it("retains streamed identity when handle close fails after async onChunk", async () => {
    const file = await heldDescriptor();
    const scope = new ArtifactResourceScope();
    const failure = await streamStableArtifact(file.path, file.bytes.length, {
      chunkBytes: 2,
      retainBytes: () => 2,
      resourceScope: scope,
      fileSystem: file.fileSystem,
      onChunk: async () => {
        await Promise.resolve();
      },
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
    const completed = completedStableArtifactStream(failure);
    expect(completed).toBeDefined();
    expect(completed?.size).toBe(file.bytes.length);
    expect(
      Buffer.compare(
        completed?.prefix ?? Buffer.alloc(0),
        file.bytes.subarray(0, 2),
      ),
    ).toBe(0);
    expect(completed?.sha256).toBe(
      createHash("sha256").update(file.bytes).digest("hex"),
    );

    file.release();
    if (failure instanceof ArtifactFileCleanupFailure)
      await failure.cleanupLease.release();
    await scope.close();
  });
});
