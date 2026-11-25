import { collectEntries } from "./artifactEntries.js";
import { getDefaultHighWaterMark } from "node:stream";
import { buffer, text } from "node:stream/consumers";
import { finished } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactReader } from "../../src/resources/ArtifactReader.js";
import {
  openRegularFile,
  type StableRegularFileDescriptor,
} from "../../src/filesystem/RegularFile.js";
import { OwnedFileHandle } from "../../src/filesystem/OwnedFileHandle.js";
import { createTestTempFile } from "./temporaryDirectory.js";
import { createDeferred } from "./binarySession.js";
import { awaitAcknowledgement } from "./lifecycleAcknowledgement.js";

interface LifecycleFixture {
  readonly image: () => Buffer;
  readonly createReader: (
    path: string,
    admitted?: StableRegularFileDescriptor,
  ) => ArtifactReader;
}

const fixture = (bytes: Buffer): Promise<string> =>
  createTestTempFile("rea-reader-lifecycle-", "image", bytes);

const readerClosureCases = ({
  image,
  createReader,
}: LifecycleFixture): void => {
  it("does not complete paused inventory after its reader closes", async () => {
    const reader = createReader(await fixture(image()));
    const iterator = reader.entries()[Symbol.asyncIterator]();
    try {
      expect((await iterator.next()).done).toBe(false);
      await reader.close();
      await expect(iterator.next()).rejects.toMatchObject({
        reason: "unavailable",
      });
    } finally {
      await reader.close();
    }
  });

  it("retains failed descriptor cleanup for retry", async () => {
    const reader = createReader(await fixture(image()));
    try {
      const [entry] = await collectEntries(reader);
      const stream = await reader.open(entry!);
      const failure = new Error("artifact close denied");
      const close = vi
        .spyOn(OwnedFileHandle.prototype, "close")
        .mockRejectedValueOnce(failure);
      try {
        await expect(reader.close()).rejects.toBe(failure);
        await expect(reader.open(entry!)).rejects.toMatchObject({
          reason: "unavailable",
        });
        expect(stream.closed).toBe(true);
        await reader.close();
        expect(close).toHaveBeenCalledTimes(2);
      } finally {
        close.mockRestore();
      }
    } finally {
      await reader.close();
    }
  });
};

const consumptionCases = ({ image, createReader }: LifecycleFixture): void => {
  it.each(["cancel", "close"] as const)(
    "retires fully buffered, unconsumed member bytes on %s",
    async (action) => {
      const reader = createReader(await fixture(image()));
      const controller = new AbortController();
      const reason = new Error("cancel buffered member");
      try {
        // Unread bytes buffer fully only below the readable high-water mark.
        // Node's default is 16 KiB on Windows and 64 KiB elsewhere.
        const entry = (await collectEntries(reader)).find(
          ({ declaredSize }) =>
            declaredSize !== null &&
            declaredSize > 0 &&
            declaredSize < getDefaultHighWaterMark(false),
        );
        if (entry === undefined)
          throw new Error("fixture has no member that fits one stream buffer");
        const stream = await reader.open(entry, controller.signal);
        expect(entry.declaredSize).toBeLessThan(stream.readableHighWaterMark);
        await finished(stream, { readable: false, cleanup: true });
        await setImmediate();
        expect(stream.readableLength).toBeGreaterThan(0);
        if (action === "cancel") controller.abort(reason);
        else await reader.close();
        await expect(buffer(stream)).rejects.toMatchObject(
          action === "cancel"
            ? { reason: "cancelled", cause: reason }
            : { reason: "unavailable" },
        );
        expect(stream.destroyed).toBe(true);
      } finally {
        await reader.close();
      }
    },
  );
};

const descriptorCases = ({ image, createReader }: LifecycleFixture): void => {
  it("joins a member's outstanding positional read before descriptor closure", async () => {
    const path = await fixture(image());
    const admitted = await openRegularFile(path, { symlinks: "reject" });
    const reader = createReader(path, admitted);
    const reached = createDeferred<void>(),
      release = createDeferred<void>();
    const nativeRead = admitted.handle.read.bind(admitted.handle);
    const reads = vi.spyOn(admitted.handle, "read");
    let outcome: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    try {
      const [entry] = await collectEntries(reader);
      reads.mockImplementation((async (...args: unknown[]) => {
        reached.resolve();
        await release.promise;
        return Reflect.apply(nativeRead, admitted.handle, args);
      }) as typeof admitted.handle.read);
      const stream = await reader.open(entry!);
      outcome = buffer(stream).then(
        () => ({ ok: true }),
        (cause: unknown) => ({ ok: false, cause }),
      );
      await awaitAcknowledgement(
        reached.promise,
        outcome,
        "member positional read",
      );
      let closed = false;
      closing = reader.close().then(() => {
        closed = true;
      });
      await setImmediate();
      expect(closed).toBe(false);
      release.resolve();
      await closing;
      expect(stream.closed).toBe(true);
    } finally {
      release.resolve();
      await outcome;
      await closing;
      await reader.close();
      reads.mockRestore();
      await admitted.handle.close();
    }
  });
};

const validationCases = ({ image, createReader }: LifecycleFixture): void => {
  it.each(["cancel", "cancel-with-validation-error", "close"] as const)(
    "joins final freshness validation during %s",
    async (action) => {
      const path = await fixture(image());
      const admitted = await openRegularFile(path, { symlinks: "reject" });
      const reader = createReader(path, admitted);
      const reached = createDeferred<void>(),
        release = createDeferred<void>();
      const nativeStat = admitted.handle.stat.bind(admitted.handle);
      const nativeRead = admitted.handle.read.bind(admitted.handle);
      const reads = vi.spyOn(admitted.handle, "read");
      const stats = vi.spyOn(admitted.handle, "stat");
      const controller = new AbortController(),
        reason = new Error("cancel final validation");
      const validationFailure = new Error("final descriptor stat failed");
      let outcome: Promise<unknown> | undefined;
      let closing: Promise<void> | undefined;
      try {
        const [entry] = await collectEntries(reader);
        const memberEnd = BigInt(entry!.byteOffset! + entry!.declaredSize!);
        let memberReadComplete = false;
        reads.mockImplementation((async (...args: unknown[]) => {
          const result = (await Reflect.apply(
            nativeRead,
            admitted.handle,
            args,
          )) as {
            bytesRead: number;
            buffer: Buffer;
          };
          if (typeof args[3] === "bigint")
            memberReadComplete =
              args[3] + BigInt(result.bytesRead) === memberEnd;
          return result;
        }) as typeof admitted.handle.read);
        stats.mockImplementation((async (...args: unknown[]) => {
          const result = await Reflect.apply(nativeStat, admitted.handle, args);
          if (memberReadComplete) {
            memberReadComplete = false;
            reached.resolve();
            await release.promise;
            if (action === "cancel-with-validation-error")
              throw validationFailure;
          }
          return result;
        }) as typeof admitted.handle.stat);
        const stream = await reader.open(entry!, controller.signal);
        outcome = buffer(stream).then(
          () => ({ ok: true }) as const,
          (cause: unknown) => ({ ok: false, cause }) as const,
        );
        await awaitAcknowledgement(
          reached.promise,
          outcome,
          "post-read freshness validation",
        );
        let closed = false;
        if (action !== "close") controller.abort(reason);
        else
          closing = reader.close().then(() => {
            closed = true;
          });
        await setImmediate();
        expect(closed).toBe(false);
        release.resolve();
        expect(await outcome).toMatchObject({
          ok: false,
          cause:
            action === "cancel-with-validation-error"
              ? validationFailure
              : action === "cancel"
                ? { reason: "cancelled", cause: reason }
                : { reason: "unavailable" },
        });
        await closing;
      } finally {
        release.resolve();
        await outcome;
        await closing;
        await reader.close();
        stats.mockRestore();
        reads.mockRestore();
        await admitted.handle.close();
      }
    },
  );
};

/** UnityFS and wxapkg admit four concurrent member streams per reader. */
export const boundedArchiveStreamCases = (
  buildImage: (members: readonly { path: string; data: string }[]) => Buffer,
  createReader: LifecycleFixture["createReader"],
): void => {
  const image = () =>
    buildImage([
      { path: "x", data: "bytes" },
      { path: "y", data: "bytes" },
    ]);
  readerClosureCases({ image, createReader });

  it("preserves a pending read failure when cancellation overlaps it", async () => {
    const path = await fixture(image());
    const admitted = await openRegularFile(path, { symlinks: "reject" });
    const reader = createReader(path, admitted);
    const reached = createDeferred<void>();
    const release = createDeferred<void>();
    const failure = new Error("member read failed");
    const controller = new AbortController();
    const [entry] = await collectEntries(reader);
    const reads = vi
      .spyOn(admitted.handle, "read")
      .mockImplementation((async () => {
        reached.resolve();
        await release.promise;
        throw failure;
      }) as typeof admitted.handle.read);
    let consumed: Promise<Buffer> | undefined;
    try {
      consumed = buffer(await reader.open(entry!, controller.signal));
      await awaitAcknowledgement(reached.promise, consumed, "member read");
      controller.abort(new Error("caller cancelled"));
      release.resolve();
      await expect(consumed).rejects.toBe(failure);
    } finally {
      release.resolve();
      await consumed?.catch(() => undefined);
      reads.mockRestore();
      await reader.close();
      await admitted.handle.close();
    }
  });

  it("bounds active streams and releases capacity after abandonment", async () => {
    const reader = createReader(await fixture(image()));
    try {
      const [entry] = await collectEntries(reader);
      const streams = await Promise.all(
        Array.from({ length: 4 }, () => reader.open(entry!)),
      );
      await expect(reader.open(entry!)).rejects.toMatchObject({
        reason: "limit",
        boundary: "capacity",
      });
      const closed = new Promise<void>((resolve) => {
        streams[0]!.once("close", resolve);
      });
      streams[0]!.destroy();
      await closed;
      expect(await text(await reader.open(entry!))).toBe("bytes");
    } finally {
      await reader.close();
    }
  });
};

/** Stored-member readers share ownership and native I/O regression oracles.
 * The fixture must have a nonempty first entry with a physical byte range,
 * and a nonempty entry smaller than Node's default stream buffer.
 */
export const artifactReaderLifecycleCases = (setup: LifecycleFixture): void => {
  describe("stored member lifecycle", () => {
    readerClosureCases(setup);
    consumptionCases(setup);
    descriptorCases(setup);
    validationCases(setup);
  });
};

/** An interrupted preparation belongs to its caller, not concurrent readers. */
export const artifactPreparationRecoveryCases = ({
  image,
  createReader,
}: LifecycleFixture): void => {
  it.each(["cancelled", "physical failure"] as const)(
    "preserves independent preparation after %s",
    async (scenario) => {
      const path = await fixture(image());
      const admitted = await openRegularFile(path, { symlinks: "reject" });
      const reader = createReader(path, admitted);
      const controller = new AbortController();
      const reason = { request: "first inventory" };
      const physical = Object.assign(new Error("controlled read failure"), {
        code: "EIO",
      });
      const reached = createDeferred<void>();
      const release = createDeferred<void>();
      const nativeRead = admitted.handle.read.bind(admitted.handle);
      let blocked = false;
      const read = vi.spyOn(admitted.handle, "read").mockImplementation((async (
        ...args: unknown[]
      ) => {
        const result = await Reflect.apply(nativeRead, admitted.handle, args);
        if (!blocked) {
          blocked = true;
          reached.resolve();
          await release.promise;
          if (scenario === "physical failure") throw physical;
        }
        return result;
      }) as typeof admitted.handle.read);
      const pending: Promise<unknown>[] = [];
      try {
        const first = (async () => {
          for await (const _ of reader.entries(controller.signal)) {
          }
        })();
        pending.push(first);
        void first.catch(() => undefined);
        await awaitAcknowledgement(reached.promise, first, "preparation read");
        const peer = collectEntries(reader);
        pending.push(peer);
        void peer.catch(() => undefined);
        controller.abort(reason);
        release.resolve();
        if (scenario === "physical failure") {
          await expect(first).rejects.toBe(physical);
          await expect(peer).rejects.toBe(physical);
        } else {
          await expect(first).rejects.toMatchObject({
            reason: "cancelled",
            cause: reason,
          });
          const recovered = await peer;
          expect(recovered.length).toBeGreaterThan(0);
          expect(
            (await buffer(await reader.open(recovered[0]!))).length,
          ).toBeGreaterThan(0);
        }
      } finally {
        release.resolve();
        await Promise.allSettled(pending);
        read.mockRestore();
        await reader.close();
        await admitted.handle.close();
      }
    },
  );
};
