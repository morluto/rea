import { createHash } from "node:crypto";
import { open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { finished } from "node:stream/promises";
import type { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { InesArtifactReader } from "../../../src/artifacts/InesArtifactReader.js";
import { scanReader } from "../../../src/artifacts/inventory/scanReader.js";
import { hashStableRootArtifactHandle } from "../../../src/artifacts/inventory/hashStableRootArtifact.js";
import { inventoryArtifact } from "../../fixtures/artifactInventory.js";
import { inesFixture } from "../../fixtures/ines.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { RetainedRegularFileCleanupFailure } from "../../../src/application/RegularFileRead.js";

import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import {
  artifactFileCompletion,
  artifactFilePrimaryFacts,
  ArtifactFileCleanupFailure,
  withArtifactFileHandle,
} from "../../../src/artifacts/ArtifactFileOperation.js";
import { readFileHandlePrefix } from "../../../src/filesystem/readFileHandlePrefix.js";
import { abortIfNeeded } from "../../../src/artifacts/ArtifactHash.js";
import * as regularFile from "../../../src/filesystem/RegularFile.js";

// Complete the real I/O, then cancel while its caller is still awaiting it.
const cancelAfterNextStat = (
  handle: FileHandle,
  controller: AbortController,
  mutate?: () => Promise<void>,
) => {
  const original = handle.stat.bind(handle);
  const stat = vi
    .spyOn(handle, "stat")
    .mockImplementationOnce(async (...args) => {
      await mutate?.();
      const observed = await original(...args);
      controller.abort();
      return observed;
    });
  return () => stat.mockRestore();
};

const malformed = (format: string) => {
  if (format === "UNIF") return Buffer.from("UNIF");
  const bytes = inesFixture();
  if (format === "NES 2.0") {
    bytes[7] = 8;
    return bytes;
  }
  return bytes.subarray(0, 20);
};

it.each(["default", "caller-error", "failed-close"])(
  "preserves cancellation and descriptor ownership during %s admission",
  async (reasonKind) => {
    const root = await createTestTempDirectory("rea-ines-cancel-admission-");
    const path = join(root, "source.nes");
    await writeFile(path, inesFixture());
    const sample = await open(path, "r");
    const prototype = Object.getPrototypeOf(sample) as Pick<FileHandle, "stat">;
    await sample.close();
    const original = prototype.stat;
    const controller = new AbortController();
    let admitted: FileHandle | undefined;
    const cleanupFailure = new Error("descriptor close failed");
    const callerReason = new Error("caller stopped admission");
    let restoreClose = () => {};
    const stat = vi
      .spyOn(prototype, "stat")
      .mockImplementationOnce(async function (this: FileHandle, ...args) {
        admitted = this;
        const observed = await original.call(this, ...args);
        if (reasonKind === "failed-close") {
          const close = vi
            .spyOn(this, "close")
            .mockRejectedValueOnce(cleanupFailure);
          restoreClose = () => close.mockRestore();
        }
        controller.abort(
          reasonKind === "caller-error" ? callerReason : undefined,
        );
        return observed;
      });
    try {
      const result = parseBinaryTarget(path, { signal: controller.signal });
      if (reasonKind === "failed-close") {
        const failure = await result;
        if (failure.ok) throw new Error("Expected a retained cleanup failure");
        expect(failure.error.cleanupIncomplete).toBe(true);
        expect(failure.error.cause).toBeInstanceOf(
          RetainedRegularFileCleanupFailure,
        );
        const retained = failure.error
          .cause as RetainedRegularFileCleanupFailure;
        expect(retained.cleanupCause).toBe(cleanupFailure);
        expect(retained.outcome).toMatchObject({ kind: "failed" });
        await retained.cleanupLease.release();
        expect(failure.error.cleanupIncomplete).toBe(false);
      } else {
        const cancelled = await result;
        expect(cancelled).toMatchObject({
          ok: false,
          error: {
            _tag: "AnalysisCancelledError",
            operation: "resolve_binary_target",
          },
        });
        if (cancelled.ok) throw new Error("Expected cancellation");
        if (reasonKind === "caller-error")
          expect(cancelled.error.cause).toBe(callerReason);
      }
      if (admitted === undefined)
        throw new Error("Admission descriptor was not observed");
      await expect(admitted.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      restoreClose();
      stat.mockRestore();
    }
  },
);

it.each([
  ["truncated", "read"],
  ["NES 2.0", "read"],
  ["UNIF", "read"],
  ["truncated", "validation"],
  ["NES 2.0", "validation"],
  ["UNIF", "validation"],
])("honors cancellation during %s root prefix %s", async (format, phase) => {
  const root = await createTestTempDirectory("rea-ines-cancel-prefix-");
  const path = join(root, "source.nes");
  await writeFile(path, malformed(format));
  const sample = await open(path, "r");
  const prototype = Object.getPrototypeOf(sample) as Pick<FileHandle, "read">;
  await sample.close();
  const original = prototype.read;
  const controller = new AbortController();
  let admitted: FileHandle | undefined;
  let restoreStat = () => {};
  const read = vi
    .spyOn(prototype, "read")
    .mockImplementationOnce(async function (this: FileHandle, ...args) {
      admitted = this;
      const observed = await original.call(this, ...args);
      if (phase === "read") controller.abort();
      else restoreStat = cancelAfterNextStat(this, controller);
      return observed;
    });
  try {
    await expect(
      inventoryArtifact(path, { signal: controller.signal }),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(controller.signal.aborted).toBe(true);
    if (admitted === undefined)
      throw new Error("Prefix descriptor was not observed");
    await expect(admitted.stat()).rejects.toMatchObject({ code: "EBADF" });
  } finally {
    restoreStat();
    read.mockRestore();
  }
});

it("honors cancellation during malformed reader header validation", async () => {
  const root = await createTestTempDirectory("rea-ines-cancel-header-");
  const path = join(root, "source.nes");
  await writeFile(path, malformed("truncated"));
  const handle = await open(path, "r");
  const reader = new InesArtifactReader(path, {
    handle,
    initial: await handle.stat(),
  });
  const controller = new AbortController();
  const original = handle.read.bind(handle);
  let restoreStat = () => {};
  const read = vi
    .spyOn(handle, "read")
    .mockImplementationOnce(async (...args) => {
      const observed = await original(...args);
      restoreStat = cancelAfterNextStat(handle, controller);
      return observed;
    });
  try {
    await expect(
      reader.entries(controller.signal)[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(controller.signal.aborted).toBe(true);
  } finally {
    restoreStat();
    read.mockRestore();
    await reader.close();
    await handle.close();
  }
});

it.each(["stream", "reconstruction"])(
  "does not complete %s after cancellation in the final region validation",
  async (operation) => {
    const root = await createTestTempDirectory("rea-ines-cancel-region-");
    const path = join(root, "source.nes");
    const bytes = inesFixture();
    await writeFile(path, bytes);
    const handle = await open(path, "r");
    const reader = new InesArtifactReader(path, {
      handle,
      initial: await handle.stat(),
    });
    const controller = new AbortController();
    let restoreStat = () => {};
    const original = handle.read.bind(handle);
    const read = vi
      .spyOn(handle, "read")
      .mockImplementation(async (...args) => {
        const observed = await original(...args);
        const arguments_: readonly unknown[] = args;
        const position = arguments_[3];
        if (
          (typeof position === "number" || typeof position === "bigint") &&
          observed.bytesRead > 0 &&
          Number(position) + observed.bytesRead === bytes.length
        )
          restoreStat = cancelAfterNextStat(handle, controller);
        return observed;
      });
    try {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      const last = entries.at(-1);
      if (last === undefined) throw new Error("Missing last iNES region");
      const result =
        operation === "reconstruction"
          ? (async () => {
              const { inesRegionScan } = await scanReader(
                reader,
                [reader],
                controller.signal,
              );
              if (inesRegionScan === undefined)
                throw new Error("Missing region scan");
              return reader.verifyReconstruction(
                createHash("sha256").update(bytes).digest("hex"),
                inesRegionScan,
                controller.signal,
              );
            })()
          : (async () => {
              for await (const chunk of await reader.open(
                last,
                controller.signal,
              ))
                expect(Buffer.isBuffer(chunk)).toBe(true);
            })();
      await expect(result).rejects.toMatchObject({ reason: "cancelled" });
      expect(controller.signal.aborted).toBe(true);
    } finally {
      restoreStat();
      read.mockRestore();
      await reader.close();
      await handle.close();
    }
  },
);

it("does not publish a root digest cancelled during its final state check", async () => {
  const root = await createTestTempDirectory("rea-ines-cancel-hash-");
  const path = join(root, "source.nes");
  await writeFile(path, inesFixture());
  const handle = await open(path, "r");
  const initial = await handle.stat();
  const controller = new AbortController();
  const restore = cancelAfterNextStat(handle, controller);
  try {
    await expect(
      hashStableRootArtifactHandle(path, handle, initial, controller.signal),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(controller.signal.aborted).toBe(true);
  } finally {
    restore();
    await handle.close();
  }
});

it.each([
  ["prefix", false],
  ["prefix", true],
  ["hash", false],
  ["hash", true],
] as const)(
  "cancels target %s validation with concurrent change=%s",
  async (phase, changed) => {
    const root = await createTestTempDirectory("rea-ines-cancel-target-");
    const path = join(root, "source.nes");
    await writeFile(path, inesFixture());
    const sample = await open(path, "r");
    const prototype = Object.getPrototypeOf(sample) as Pick<FileHandle, "read">;
    await sample.close();
    const original = prototype.read;
    const controller = new AbortController();
    let admitted: FileHandle | undefined;
    let restoreStat = () => {};
    const read = vi.spyOn(prototype, "read").mockImplementation(async function (
      this: FileHandle,
      ...args
    ) {
      const observed = await original.call(this, ...args);
      if (
        admitted === undefined &&
        (phase === "prefix" || observed.bytesRead === 0)
      ) {
        admitted = this;
        restoreStat = cancelAfterNextStat(
          this,
          controller,
          changed ? () => writeFile(path, "changed cartridge") : undefined,
        );
      }
      return observed;
    });
    try {
      expect(
        await parseBinaryTarget(path, { signal: controller.signal }),
      ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
      expect(controller.signal.aborted).toBe(true);
      if (admitted === undefined)
        throw new Error("Hash descriptor was not observed");
      await expect(admitted.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      restoreStat();
      read.mockRestore();
    }
  },
);

it.each(
  (["header-read", "read", "stat"] as const).flatMap((phase) =>
    [false, true].map((sameReason) => [phase, sameReason] as const),
  ),
)(
  "preserves an iNES descriptor %s failure concurrent with cancellation (same reason=%s)",
  async (phase, sameReason) => {
    const root = await createTestTempDirectory("rea-ines-physical-failure-");
    const path = join(root, "source.nes");
    await writeFile(path, inesFixture());
    const handle = await open(path, "r");
    const reader = new InesArtifactReader(path, {
      handle,
      initial: await handle.stat(),
    });
    const controller = new AbortController();
    const physical = Object.assign(new Error("descriptor I/O failed"), {
      code: "EIO",
    });
    let restore = () => {};
    try {
      if (phase === "header-read") {
        const spy = vi
          .spyOn(handle, "read")
          .mockImplementationOnce(async () => {
            controller.abort(sameReason ? physical : "caller stopped");
            throw physical;
          });
        restore = () => spy.mockRestore();
        await expect(
          reader.entries(controller.signal)[Symbol.asyncIterator]().next(),
        ).rejects.toBe(physical);
        return;
      }
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      const entry = entries[0];
      if (entry === undefined) throw new Error("Missing iNES region");
      if (phase === "stat") {
        const spy = vi
          .spyOn(handle, "stat")
          .mockImplementationOnce(async () => {
            controller.abort(sameReason ? physical : "caller stopped");
            throw physical;
          });
        restore = () => spy.mockRestore();
        await expect(reader.open(entry, controller.signal)).rejects.toBe(
          physical,
        );
      } else {
        const stream = await reader.open(entry, controller.signal);
        const spy = vi
          .spyOn(handle, "read")
          .mockImplementationOnce(async () => {
            controller.abort(sameReason ? physical : "caller stopped");
            throw physical;
          });
        restore = () => spy.mockRestore();
        await expect(
          (async () => {
            for await (const _ of stream) {
              /* consume */
            }
          })(),
        ).rejects.toMatchObject({ reason: "io", cause: physical });
      }
    } finally {
      restore();
      await reader.close();
      await handle.close();
    }
  },
);

it("preserves the caller reason when a completed iNES read observes cancellation", async () => {
  const root = await createTestTempDirectory("rea-ines-stream-cancel-");
  const path = join(root, "source.nes");
  await writeFile(path, inesFixture());
  const handle = await open(path, "r");
  const reader = new InesArtifactReader(path, {
    handle,
    initial: await handle.stat(),
  });
  const controller = new AbortController();
  const reason = { source: "caller" };
  let restore = () => {};
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const entry = entries[0];
    if (entry === undefined) throw new Error("Missing iNES region");
    const stream = await reader.open(entry, controller.signal);
    const original = handle.read.bind(handle);
    const spy = vi
      .spyOn(handle, "read")
      .mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        controller.abort(reason);
        return result;
      });
    restore = () => spy.mockRestore();
    await expect(
      (async () => {
        for await (const _ of stream) {
          /* consume */
        }
      })(),
    ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
  } finally {
    restore();
    await reader.close();
    await handle.close();
  }
});

it.each(["classification", "hash", "region"] as const)(
  "preserves physical failure and concurrent cancellation through %s inventory",
  async (phase) => {
    const root = await createTestTempDirectory("rea-ines-inventory-io-");
    const path = join(root, "source.nes");
    await writeFile(path, inesFixture());
    const sample = await open(path, "r");
    const prototype = Object.getPrototypeOf(sample) as FileHandle;
    await sample.close();
    const originalRead = prototype.read;
    const originalStat = prototype.stat;
    const controller = new AbortController();
    const physical = Object.assign(new Error("inventory descriptor failure"), {
      code: "EIO",
    });
    let afterRead = false;
    let statCount = 0;
    const read = vi.spyOn(prototype, "read").mockImplementation(async function (
      this: FileHandle,
      ...args
    ) {
      const arguments_: readonly unknown[] = args;
      const position = arguments_[3];
      if (
        phase === "region" &&
        afterRead &&
        (typeof position === "number" || typeof position === "bigint") &&
        Number(position) === 16
      ) {
        controller.abort("caller stopped");
        throw physical;
      }
      const value = await originalRead.call(this, ...args);
      afterRead = true;
      return value;
    });
    const stat = vi.spyOn(prototype, "stat").mockImplementation(async function (
      this: FileHandle,
      ...args
    ) {
      if (
        afterRead &&
        ++statCount ===
          (phase === "classification" ? 2 : phase === "hash" ? 3 : -1)
      ) {
        controller.abort("caller stopped");
        throw physical;
      }
      return originalStat.call(this, ...args);
    });
    try {
      const failure = await inventoryArtifact(path, {
        signal: controller.signal,
      }).catch((cause: unknown) => cause);
      expect(controller.signal.aborted).toBe(true);
      expect(failure).not.toMatchObject({ reason: "cancelled" });
      if (phase === "region")
        expect(failure).toMatchObject({ reason: "io", cause: physical });
      else expect(failure).toBe(physical);
    } finally {
      read.mockRestore();
      stat.mockRestore();
    }
  },
);

it.each([
  ["failed", false],
  ["failed", true],
  ["completed", false],
  ["completed", true],
] as const)(
  "retains the physical %s prefix outcome through late abort and final close (close fails=%s)",
  async (outcome, closeFails) => {
    const root = await createTestTempDirectory("rea-prefix-completion-");
    const path = join(root, "source.nes");
    const bytes = inesFixture();
    await writeFile(path, bytes);
    const handle = await open(path, "r");
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const physical = Object.assign(new Error("physical prefix EIO"), {
      code: "EIO",
    });
    const reason = outcome === "failed" ? physical : { phase: "prefix close" };
    const cleanupFailure = new Error("prefix close temporarily failed");
    const nativeClose = handle.close.bind(handle);
    const close = vi.spyOn(handle, "close").mockImplementationOnce(async () => {
      controller.abort(reason);
      if (closeFails) throw cleanupFailure;
      await nativeClose();
    });
    const read =
      outcome === "failed"
        ? vi.spyOn(handle, "read").mockImplementationOnce(async () => {
            controller.abort(physical);
            throw physical;
          })
        : undefined;
    try {
      const observed = await withArtifactFileHandle(
        path,
        handle,
        resources,
        controller.signal,
        (file) =>
          readFileHandlePrefix(file, 16, () =>
            abortIfNeeded(controller.signal),
          ),
      ).catch((cause: unknown) => cause);
      if (outcome === "failed") {
        expect(artifactFilePrimaryFacts(observed).cause).toBe(physical);
        expect(artifactFileCompletion(observed)).toBeUndefined();
      } else {
        const completion = artifactFileCompletion(observed);
        expect(completion).toMatchObject({
          kind: "completed",
          value: bytes.subarray(0, 16),
        });
        expect(completion?.cancellation?.reason).toBe(reason);
      }
      expect(resources.hasPending).toBe(closeFails);
      if (closeFails) {
        expect(observed).toBeInstanceOf(ArtifactFileCleanupFailure);
        expect(resources.cleanupResources).toEqual([path]);
        expect(handle.fd).toBeGreaterThanOrEqual(0);
      }
      await resources.close();
      expect(handle.fd).toBe(-1);
      expect(resources.hasPending).toBe(false);
    } finally {
      read?.mockRestore();
      close.mockRestore();
      await resources.close();
      if (handle.fd >= 0) await handle.close();
    }
  },
);

it.each(
  [true, false].flatMap((owned) =>
    [false, true].flatMap((failed) =>
      (["read", "validation"] as const).flatMap((phase) =>
        [false, ...(owned && !failed ? [true] : [])].map((consumerEnds) => ({
          owned,
          failed,
          phase,
          consumerEnds,
        })),
      ),
    ),
  ),
)(
  "joins admitted iNES $phase before close (owned=$owned, failed=$failed, consumer ends=$consumerEnds)",
  async ({ owned, failed, phase, consumerEnds }) => {
    const root = await createTestTempDirectory("rea-ines-close-read-");
    const path = join(root, "source.nes");
    await writeFile(path, inesFixture());
    const handle = await open(path, "r");
    const reader = new InesArtifactReader(
      path,
      { handle, initial: await handle.stat() },
      owned ? new OwnedFileHandle(handle) : undefined,
    );
    const physical = Object.assign(new Error("held region read failed"), {
      code: "EIO",
    });
    let acknowledge = () => {};
    let release = () => {};
    const reached = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closing: Promise<void> | undefined;
    let completion: Promise<unknown> | undefined;
    let stream: Readable | undefined;
    let restore = () => {};
    try {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      const original = handle.read.bind(handle);
      const originalStat = handle.stat.bind(handle);
      let regionRead = false;
      let heldValidation = false;
      const read = vi
        .spyOn(handle, "read")
        .mockImplementationOnce(async (...args) => {
          const result = await original(...args);
          regionRead = true;
          if (phase === "read") {
            acknowledge();
            await gate;
            if (failed) throw physical;
          }
          return result;
        });
      const stat = vi
        .spyOn(handle, "stat")
        .mockImplementation(async (...args) => {
          const result = await originalStat(...args);
          if (phase === "validation" && regionRead && !heldValidation) {
            heldValidation = true;
            acknowledge();
            await gate;
            if (failed) throw physical;
          }
          return result;
        });
      restore = () => {
        read.mockRestore();
        stat.mockRestore();
      };
      stream = await reader.open(entries[0]!);
      completion = finished(stream, { cleanup: true }).then(
        () => ({ kind: "success" }),
        (cause: unknown) => cause,
      );
      if (phase === "validation") stream.resume();
      else stream.read(0);
      await awaitAcknowledgement(reached, completion, `iNES ${phase} boundary`);
      if (consumerEnds) stream.destroy();
      let closed = false;
      closing = reader.close().then(() => {
        closed = true;
      });
      await setImmediate();
      expect(closed).toBe(false);
      await expect(handle.stat()).resolves.toBeDefined();
      release();
      const outcome = await completion;
      await closing;
      if (!consumerEnds)
        expect(outcome).toMatchObject(
          failed
            ? { reason: "io", cause: physical }
            : { reason: "unavailable" },
        );
      expect(stream.closed).toBe(true);
      if (owned)
        await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
      else await expect(handle.stat()).resolves.toBeDefined();
    } finally {
      release();
      stream?.destroy();
      await completion;
      await closing;
      restore();
      await reader.close();
      if (!owned) await handle.close();
    }
  },
);

it.each(["unread", "buffered"] as const)(
  "retires an iNES %s stream while preserving its borrowed descriptor",
  async (phase) => {
    const root = await createTestTempDirectory("rea-ines-close-buffer-");
    const path = join(root, "source.nes");
    await writeFile(path, inesFixture());
    const handle = await open(path, "r");
    const reader = new InesArtifactReader(path, {
      handle,
      initial: await handle.stat(),
    });
    let stream: Readable | undefined;
    let completion: Promise<unknown> | undefined;
    try {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      stream = await reader.open(entries[0]!);
      completion = finished(stream, { cleanup: true }).catch(
        (cause: unknown) => cause,
      );
      if (phase === "buffered") {
        const buffered = new Promise<void>((resolve) =>
          stream!.once("readable", resolve),
        );
        stream.read(0);
        await awaitAcknowledgement(
          buffered,
          completion,
          "iNES buffered region bytes",
        );
        expect(stream.readableLength).toBe(16);
      }
      await reader.close();
      expect(stream.destroyed).toBe(true);
      expect(await completion).toMatchObject({ reason: "unavailable" });
      expect(stream.closed).toBe(true);
      await expect(handle.stat()).resolves.toBeDefined();
      await expect(reader.open(entries[0]!)).rejects.toMatchObject({
        reason: "unavailable",
      });
      await reader.close();
    } finally {
      stream?.destroy();
      await completion;
      await reader.close();
      await handle.close();
    }
  },
);

it("refuses to complete a paused iNES inventory after reader close", async () => {
  const root = await createTestTempDirectory("rea-ines-close-iteration-");
  const path = join(root, "source.nes");
  await writeFile(path, inesFixture());
  const handle = await open(path, "r");
  const reader = new InesArtifactReader(path, {
    handle,
    initial: await handle.stat(),
  });
  const iterator = reader.entries()[Symbol.asyncIterator]();
  try {
    expect((await iterator.next()).done).toBe(false);
    await reader.close();
    await expect(iterator.next()).rejects.toMatchObject({
      reason: "unavailable",
    });
    await expect(handle.stat()).resolves.toBeDefined();
  } finally {
    await iterator.return?.();
    await reader.close();
    await handle.close();
  }
});

it.each(["close", "cancel"] as const)(
  "refuses a region when %s follows completed source validation",
  async (action) => {
    const root = await createTestTempDirectory("rea-ines-open-retirement-");
    const path = join(root, "source.nes");
    await writeFile(path, inesFixture());
    const handle = await open(path, "r");
    const reader = new InesArtifactReader(path, {
      handle,
      initial: await handle.stat(),
    });
    const controller = new AbortController();
    const reason = new Error("caller cancelled after source validation");
    let closing: Promise<void> | undefined;
    let stream: Readable | undefined;
    let completion: Promise<unknown> | undefined;
    let restore = () => {};
    try {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      const original = regularFile.assertStableRegularFileIdentity;
      const validation = vi
        .spyOn(regularFile, "assertStableRegularFileIdentity")
        .mockImplementationOnce(async (...args) => {
          await original(...args);
          // Let #verifySource complete its final state check, then retire the
          // reader/caller before the awaiting open operation resumes.
          queueMicrotask(() =>
            queueMicrotask(() => {
              if (action === "close") closing = reader.close();
              else controller.abort(reason);
            }),
          );
        });
      restore = () => validation.mockRestore();
      const opened = reader
        .open(entries[0]!, controller.signal)
        .then((value) => {
          stream = value;
          completion = finished(value, { cleanup: true }).catch(
            (cause: unknown) => cause,
          );
          return value;
        });
      await expect(opened).rejects.toMatchObject(
        action === "close"
          ? { reason: "unavailable" }
          : { reason: "cancelled", cause: reason },
      );
      await expect(handle.stat()).resolves.toBeDefined();
    } finally {
      restore();
      stream?.destroy();
      await completion;
      await closing;
      await reader.close();
      await handle.close();
    }
  },
);

it.each(["close", "cancel"] as const)(
  "preserves region EIO when %s precedes stream error forwarding",
  async (action) => {
    const root = await createTestTempDirectory("rea-ines-rejection-forward-");
    const path = join(root, "source.nes");
    await writeFile(path, inesFixture());
    const handle = await open(path, "r");
    const reader = new InesArtifactReader(
      path,
      { handle, initial: await handle.stat() },
      new OwnedFileHandle(handle),
    );
    const controller = new AbortController();
    const physical = Object.assign(new Error("region descriptor read failed"), {
      code: "EIO",
    });
    let closing: Promise<void> | undefined;
    let restore = () => {};
    try {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      const stream = await reader.open(entries[0]!, controller.signal);
      const read = vi.spyOn(handle, "read").mockImplementationOnce(async () => {
        queueMicrotask(() =>
          queueMicrotask(() => {
            if (action === "close") closing = reader.close();
            else controller.abort(physical);
          }),
        );
        throw physical;
      });
      restore = () => read.mockRestore();
      const completed = finished(stream, { cleanup: true }).catch(
        (cause: unknown) => cause,
      );
      stream.resume();
      const outcome = await completed;
      expect(outcome).toMatchObject({ reason: "io", cause: physical });
      await reader.close();
      expect(handle.fd).toBe(-1);
    } finally {
      restore();
      await closing;
      await reader.close();
    }
  },
);
