import { writeOrderedZip } from "../../tests/fixtures/artifactEntryOrder.js";
import { zipSymlinkMetadataFixture } from "../../tests/fixtures/zipSymlinkMetadata.js";
import { ArtifactReaderFailure, type ArtifactEntry } from "./ArtifactReader.js";
import { createDeferred } from "../../tests/fixtures/binarySession.js";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";

import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
  ZipReader,
} from "@zip.js/zip.js";
import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

import { ZipArtifactReader } from "./ZipArtifactReader.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import { MINIMUM_ARTIFACT_EXPANDED_BYTES } from "../domain/artifactExpansionBudget.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { hashReadable } from "./ArtifactHash.js";

/** Small real ZIP carriers with forged sizes; metadata-only controls, never decompressed. */
const writeZipWithDeclaredSize = async (
  directory: string,
  declaredBytes: readonly number[],
): Promise<string> => {
  const path = join(directory, "fixture.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [index] of declaredBytes.entries())
    await writer.add(
      `member-${index}.bin`,
      new TextReader("real member bytes"),
    );
  await writeFile(path, await writer.close());
  const bytes = await readFile(path);
  let offset = 0;
  for (const declared of declaredBytes) {
    const centralDirectory = bytes.indexOf(
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      offset,
    );
    if (centralDirectory < 0)
      throw new Error("Expected a ZIP central directory");
    // Metadata-only controls: these declarations do not describe valid member streams.
    bytes.writeUInt32LE(declared, centralDirectory + 24);
    offset = centralDirectory + 46;
  }
  await writeFile(path, bytes);
  return path;
};

const enumerate = async (reader: ZipArtifactReader): Promise<number> => {
  let files = 0;
  for await (const entry of reader.entries())
    if (entry.kind === "file") files += 1;
  return files;
};

/** Hold real zip.js finalization after its streaming work settles. */
const holdZipProducerSettlement = () => {
  const reached = createDeferred<void>();
  const release = createDeferred<void>();
  const original = ZipReader.prototype.getEntriesGenerator;
  const enumeration = vi
    .spyOn(ZipReader.prototype, "getEntriesGenerator")
    .mockImplementation(async function* (this: ZipReader<unknown>, options) {
      for await (const entry of original.call(this, options)) {
        if (!entry.directory) {
          const getData = entry.getData.bind(entry);
          entry.getData = async (writer, dataOptions) => {
            try {
              return await getData(writer, dataOptions);
            } finally {
              reached.resolve();
              await release.promise;
            }
          };
        }
        yield entry;
      }
      return true;
    });
  return { reached: reached.promise, release: release.resolve, enumeration };
};

const admittedZip = async () => {
  const directory = await createTestTempDirectory("rea-zip-short-read-");
  const path = join(directory, "valid.zip");
  const content = "Complete ZIP member bytes, including café.";
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("member.txt", new TextReader(content));
  await writeFile(path, await writer.close());
  const { handle, initial } = await openRegularFile(path, {
    symlinks: "reject",
  });
  // Keep the actual descriptor, but select the positional overload used by
  // the ZIP adapter so the spy does not infer FileHandle.read's options form.
  const positional: {
    read(
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ): Promise<{ bytesRead: number; buffer: Buffer }>;
  } = handle;
  return { path, content, handle, positional, initial };
};

describe("ZipArtifactReader positional reads", () => {
  it("enumerates and extracts a real ZIP when each descriptor read returns a short prefix", async () => {
    const fixture = await admittedZip();
    const nativeRead = fixture.positional.read.bind(fixture.handle);
    const reads = vi
      .spyOn(fixture.positional, "read")
      .mockImplementation(async (...args) => {
        const [buffer, offset, length, position] = args;
        return nativeRead(buffer, offset, Math.min(length, 3), position);
      });
    const reader = new ZipArtifactReader(
      fixture.path,
      "zip",
      undefined,
      fixture,
    );
    try {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      expect(entries.map(({ path }) => path)).toEqual(["member.txt"]);
      const entry = entries[0];
      if (entry === undefined) throw new Error("Expected a ZIP member");
      const chunks: Buffer[] = [];
      for await (const chunk of await reader.open(entry))
        chunks.push(Buffer.from(chunk));
      expect(
        Buffer.compare(Buffer.concat(chunks), Buffer.from(fixture.content)),
      ).toBe(0);
      expect(reads.mock.calls.length).toBeGreaterThan(3);
    } finally {
      reads.mockRestore();
      await reader.close();
      await fixture.handle.close();
    }
  });

  it("reports premature EOF inside the admitted extent as an integrity failure", async () => {
    const fixture = await admittedZip();
    const nativeRead = fixture.positional.read.bind(fixture.handle);
    let calls = 0;
    const reads = vi
      .spyOn(fixture.positional, "read")
      .mockImplementation(async (...args) => {
        const [buffer, offset, length, position] = args;
        if (calls++ > 0) return { buffer, bytesRead: 0 };
        return nativeRead(buffer, offset, Math.min(length, 3), position);
      });
    const reader = new ZipArtifactReader(
      fixture.path,
      "zip",
      undefined,
      fixture,
    );
    try {
      await expect(enumerate(reader)).rejects.toMatchObject({
        reason: "integrity",
      });
      expect(calls).toBe(2);
    } finally {
      reads.mockRestore();
      await reader.close();
      await fixture.handle.close();
    }
  });

  it("keeps metadata allocation admission ahead of short reads", async () => {
    const fixture = await admittedZip();
    const reads = vi.spyOn(fixture.positional, "read");
    const reader = new ZipArtifactReader(fixture.path, "zip", 2, fixture);
    try {
      await expect(enumerate(reader)).rejects.toMatchObject({
        reason: "limit",
      });
      expect(reads).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
      await reader.close();
      await fixture.handle.close();
    }
  });

  it("does not publish an entry cancelled during short metadata reads", async () => {
    const fixture = await admittedZip();
    const controller = new AbortController();
    const nativeRead = fixture.positional.read.bind(fixture.handle);
    const reads = vi
      .spyOn(fixture.positional, "read")
      .mockImplementation(async (...args) => {
        const [buffer, offset, length, position] = args;
        const result = await nativeRead(
          buffer,
          offset,
          Math.min(length, 3),
          position,
        );
        controller.abort();
        return result;
      });
    const reader = new ZipArtifactReader(
      fixture.path,
      "zip",
      undefined,
      fixture,
    );
    const iterator = reader.entries(controller.signal)[Symbol.asyncIterator]();
    try {
      await expect(iterator.next()).rejects.toMatchObject({
        reason: "cancelled",
      });
    } finally {
      await iterator.return?.();
      reads.mockRestore();
      await reader.close();
      await fixture.handle.close();
    }
  });

  it("rejects a changed admitted descriptor before reading ZIP bytes", async () => {
    const fixture = await admittedZip();
    await writeFile(fixture.path, Buffer.alloc(0));
    const reads = vi.spyOn(fixture.positional, "read");
    const reader = new ZipArtifactReader(
      fixture.path,
      "zip",
      undefined,
      fixture,
    );
    try {
      await expect(enumerate(reader)).rejects.toMatchObject({
        reason: "integrity",
      });
      expect(reads).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
      await reader.close();
      await fixture.handle.close();
    }
  });
});

it("refuses to open ZIP symlink entries even when unixMode is absent", async () => {
  const directory = await createTestTempDirectory("rea-zip-symlink-open-");
  const path = join(directory, "symlinks.zip");
  await writeFile(path, await zipSymlinkMetadataFixture());
  const reader = new ZipArtifactReader(path, "zip");
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    for (const logicalPath of ["type-only-link", "permissions-link"]) {
      const entry = entries.find((candidate) => candidate.path === logicalPath);
      expect(entry).toMatchObject({ kind: "symlink" });
      if (entry === undefined)
        throw new Error(`Missing ZIP symlink ${logicalPath}`);
      await expect(reader.open(entry)).rejects.toMatchObject({
        reason: "format",
        message: "ZIP entry is not a regular file",
      });
    }
  } finally {
    await reader.close();
  }
});

describe("ZipArtifactReader decompression budget", () => {
  it("refuses an archive whose entries declare more than its size can justify", async () => {
    const directory = await createTestTempDirectory("rea-zip-budget-bomb-");
    // A ~160-byte archive cannot declare 2 GiB of members without being a bomb.
    const path = await writeZipWithDeclaredSize(directory, [2_147_483_647]);
    const reader = new ZipArtifactReader(path, "zip");
    try {
      await expect(enumerate(reader)).rejects.toMatchObject({
        name: "ArtifactReaderFailure",
        reason: "limit",
      });
    } finally {
      await reader.close();
    }
  });

  it("charges all declarations in one traversal before yielding an over-budget member", async () => {
    const directory = await createTestTempDirectory("rea-zip-budget-total-");
    const half = MINIMUM_ARTIFACT_EXPANDED_BYTES / 2;
    const path = await writeZipWithDeclaredSize(directory, [half, half + 1]);
    const reader = new ZipArtifactReader(path, "zip");
    const iterator = reader.entries()[Symbol.asyncIterator]();
    try {
      expect((await iterator.next()).value?.declaredSize).toBe(half);
      await expect(iterator.next()).rejects.toMatchObject({ reason: "limit" });
    } finally {
      await iterator.return?.();
      await reader.close();
    }
  });

  it("keeps repeated and interleaved metadata traversals independently charged", async () => {
    const directory = await createTestTempDirectory(
      "rea-zip-budget-iterators-",
    );
    const path = await writeZipWithDeclaredSize(directory, [
      MINIMUM_ARTIFACT_EXPANDED_BYTES / 2,
      MINIMUM_ARTIFACT_EXPANDED_BYTES / 2,
    ]);
    const reader = new ZipArtifactReader(path, "zip");
    const first = reader.entries()[Symbol.asyncIterator]();
    const second = reader.entries()[Symbol.asyncIterator]();
    try {
      expect((await first.next()).done).toBe(false);
      expect((await second.next()).done).toBe(false);
      expect((await first.next()).done).toBe(false);
      expect((await second.next()).done).toBe(false);
      expect((await first.next()).done).toBe(true);
      expect((await second.next()).done).toBe(true);
      expect(await enumerate(reader)).toBe(2);
    } finally {
      await Promise.all([first.return?.(), second.return?.()]);
      await reader.close();
    }
  });

  it("streams a valid small member through open", async () => {
    const directory = await createTestTempDirectory("rea-zip-budget-valid-");
    const path = join(directory, "valid.zip");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("member.bin", new TextReader("valid member bytes"));
    await writeFile(path, await writer.close());
    const reader = new ZipArtifactReader(path, "zip");
    try {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      const entry = entries[0];
      if (entry === undefined) throw new Error("Expected a ZIP member");
      const chunks: Buffer[] = [];
      for await (const chunk of await reader.open(entry))
        chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe("valid member bytes");
    } finally {
      await reader.close();
    }
  });

  it("rejects under-declared member output before delivering its complete actual bytes", async () => {
    const directory = await createTestTempDirectory("rea-zip-underdeclared-");
    const path = join(directory, "underdeclared.zip");
    const content = new Uint8Array(128 * 1024);
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("member.bin", new Uint8ArrayReader(content), {
      dataDescriptor: false,
      bufferedWrite: true,
    });
    const bytes = Buffer.from(await writer.close());
    const local = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    if (local < 0 || central < 0) throw new Error("Expected ZIP entry headers");
    // Both headers agree and no descriptor remains: rejection must enforce
    // actual decompressed output, not merely detect conflicting metadata.
    expect(bytes.readUInt16LE(local + 6) & 8).toBe(0);
    expect(bytes.readUInt16LE(local + 8)).toBe(8);
    expect(bytes.readUInt32LE(local + 22)).toBe(content.length);
    expect(bytes.readUInt32LE(central + 24)).toBe(content.length);
    bytes.writeUInt32LE(1, local + 22);
    bytes.writeUInt32LE(1, central + 24);
    await writeFile(path, bytes);
    const reader = new ZipArtifactReader(path, "zip");
    try {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      const entry = entries[0];
      if (entry === undefined) throw new Error("Expected a ZIP member");
      expect(entry.declaredSize).toBe(1);
      let deliveredBytes = 0;
      await expect(
        (async () => {
          for await (const chunk of await reader.open(entry))
            deliveredBytes += Buffer.from(chunk).length;
        })(),
      ).rejects.toThrow("Invalid uncompressed size");
      expect(deliveredBytes).toBeLessThan(content.length);
    } finally {
      await reader.close();
    }
  });
});

it.each([null, { caller: "opaque ZIP interruption" }])(
  "preserves the exact ZIP cancellation reason at enumeration and open: %j",
  async (reason) => {
    const root = await createTestTempDirectory("rea-zip-cancellation-");
    const path = join(root, "fixture.zip");
    await writeOrderedZip(path, ["member.txt"]);
    const reader = new ZipArtifactReader(path, "zip");
    const caller = new AbortController();
    try {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      const entry = entries[0];
      if (entry === undefined) throw new Error("Expected real ZIP member");
      caller.abort(reason);
      for (const run of [
        () => reader.entries(caller.signal)[Symbol.asyncIterator]().next(),
        async () => reader.open(entry, caller.signal),
      ]) {
        const error: unknown = await run().catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(ArtifactReaderFailure);
        if (!(error instanceof ArtifactReaderFailure))
          throw new Error("Expected ZIP cancellation");
        expect(error.reason).toBe("cancelled");
        expect(error.cancellation?.reason).toBe(reason);
        expect(error.cause).toBe(reason);
      }
    } finally {
      await reader.close();
    }
  },
);

describe("ZipArtifactReader producer ownership", () => {
  it.each(["unread", "abandoned", "cancelled"] as const)(
    "joins late extraction settlement for an %s stream before closing its source",
    async (mode) => {
      const directory = await createTestTempDirectory("rea-zip-producer-");
      const path = join(directory, "member.zip");
      const writer = new ZipWriter(new Uint8ArrayWriter());
      await writer.add(
        "member.bin",
        new Uint8ArrayReader(new Uint8Array(256 * 1024)),
        {
          level: 0,
        },
      );
      await writeFile(path, await writer.close());
      const held = holdZipProducerSettlement();
      const fileClose = vi.spyOn(OwnedFileHandle.prototype, "close");
      const reader = new ZipArtifactReader(path, "zip");
      const caller = new AbortController();
      try {
        const entries: ArtifactEntry[] = [];
        for await (const entry of reader.entries()) entries.push(entry);
        const stream = await reader.open(entries[0]!, caller.signal);
        await once(stream, "readable");
        const reason = { caller: "ZIP owner cancellation" };
        if (mode === "cancelled") {
          const digest = hashReadable(stream, caller.signal);
          caller.abort(reason);
          await expect(digest).rejects.toMatchObject({
            reason: "cancelled",
            cause: reason,
          });
        } else if (mode === "abandoned") {
          for await (const _chunk of stream) break;
        }
        const closing = reader.close();
        expect(reader.close()).toBe(closing);
        await held.reached;
        expect(stream.destroyed).toBe(true);
        expect(fileClose).not.toHaveBeenCalled();
        let closed = false;
        void closing.then(() => {
          closed = true;
        });
        await Promise.resolve();
        expect(closed).toBe(false);
        held.release();
        await closing;
        expect(fileClose).toHaveBeenCalledTimes(1);
        await reader.close();
        expect(fileClose).toHaveBeenCalledTimes(1);
        expect(() => reader.open(entries[0]!)).toThrow("ZIP reader is closed");
      } finally {
        held.release();
        await reader.close();
        held.enumeration.mockRestore();
        fileClose.mockRestore();
      }
    },
  );

  it("retires completed buffered output and retries a failed descriptor close", async () => {
    const directory = await createTestTempDirectory("rea-zip-buffered-close-");
    const path = join(directory, "small.zip");
    await writeOrderedZip(path, ["member.txt"]);
    const held = holdZipProducerSettlement();
    const reader = new ZipArtifactReader(path, "zip");
    try {
      const entries: ArtifactEntry[] = [];
      for await (const entry of reader.entries()) entries.push(entry);
      const stream = await reader.open(entries[0]!);
      await held.reached;
      held.release();
      // getData has finished, but this tiny member remains buffered and unread.
      await Promise.resolve();
      const closeFailure = new Error("ZIP descriptor close denied");
      const close = vi
        .spyOn(OwnedFileHandle.prototype, "close")
        .mockRejectedValueOnce(closeFailure);
      try {
        await expect(reader.close()).rejects.toBe(closeFailure);
        expect(stream.destroyed).toBe(true);
        await reader.close();
        expect(close).toHaveBeenCalledTimes(2);
      } finally {
        close.mockRestore();
      }
    } finally {
      held.release();
      await reader.close();
      held.enumeration.mockRestore();
    }
  });
});

it("joins an admitted ZIP enumeration before reader close completes", async () => {
  const fixture = await admittedZip();
  const reached = createDeferred<void>();
  const release = createDeferred<void>();
  const nativeRead = fixture.positional.read.bind(fixture.positional);
  const reads = vi
    .spyOn(fixture.positional, "read")
    .mockImplementation(async (...args) => {
      reached.resolve();
      await release.promise;
      return nativeRead(...args);
    });
  const reader = new ZipArtifactReader(fixture.path, "zip", undefined, fixture);
  const traversal = reader.entries()[Symbol.asyncIterator]();
  const next = traversal.next();
  try {
    await reached.promise;
    let closed = false;
    const closing = reader.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    await expect(next).rejects.toMatchObject({
      reason: "unavailable",
      message: "ZIP reader is closed",
    });
    await closing;
    const completedReads = reads.mock.calls.length;
    await expect(
      reader.entries()[Symbol.asyncIterator]().next(),
    ).rejects.toThrow("ZIP reader is closed");
    expect(reads).toHaveBeenCalledTimes(completedReads);
  } finally {
    release.resolve();
    await next.catch(() => undefined);
    await reader.close();
    reads.mockRestore();
    await fixture.handle.close();
  }
});

it("joins a late ZIP producer and closes the source despite an enumeration cleanup failure", async () => {
  const directory = await createTestTempDirectory("rea-zip-mixed-cleanup-");
  const path = join(directory, "mixed.zip");
  await writeOrderedZip(path, ["member.txt"]);
  const held = holdZipProducerSettlement();
  const enumerate = held.enumeration.getMockImplementation()!;
  const failure = new Error("ZIP enumeration finalization denied");
  held.enumeration.mockImplementation(function (
    this: ZipReader<unknown>,
    options,
  ) {
    const source = enumerate.call(this, options);
    const finish = source.return.bind(source);
    vi.spyOn(source, "return").mockImplementationOnce(async (value) => {
      await finish(value);
      throw failure;
    });
    return source;
  });
  const fileClose = vi.spyOn(OwnedFileHandle.prototype, "close");
  const reader = new ZipArtifactReader(path, "zip");
  const traversal = reader.entries()[Symbol.asyncIterator]();
  try {
    const first = await traversal.next();
    if (first.done) throw new Error("Expected ZIP member");
    await reader.open(first.value);
    await held.reached;
    const closing = reader.close();
    const failureCheck = expect(closing).rejects.toBe(failure);
    await Promise.resolve();
    expect(fileClose).not.toHaveBeenCalled();
    held.release();
    await failureCheck;
    expect(fileClose).toHaveBeenCalledTimes(1);
    await reader.close();
    expect(fileClose).toHaveBeenCalledTimes(1);
  } finally {
    held.release();
    await reader.close();
    await traversal.return?.();
    held.enumeration.mockRestore();
    fileClose.mockRestore();
  }
});

it.each([false, true])(
  "rejects ZIP carrier mutation after enumeration (borrowed=%s)",
  async (borrowed) => {
    const fixture = await admittedZip();
    const reader = new ZipArtifactReader(
      fixture.path,
      "zip",
      undefined,
      borrowed ? fixture : undefined,
    );
    try {
      const entries: ArtifactEntry[] = [];
      for await (const entry of reader.entries()) entries.push(entry);
      expect(entries).toHaveLength(1);
      // Trailing bytes leave the real member and its cached CRC unchanged, but
      // change the carrier from which the inventory was produced.
      await appendFile(fixture.path, "changed carrier");
      await expect(
        hashReadable(await reader.open(entries[0]!)),
      ).rejects.toMatchObject({ reason: "integrity" });
    } finally {
      await reader.close();
      await fixture.handle.close();
    }
  },
);

it("rejects ZIP carrier mutation while a directory traversal is paused", async () => {
  const fixture = await admittedZip();
  const reader = new ZipArtifactReader(fixture.path, "zip");
  const entries = reader.entries()[Symbol.asyncIterator]();
  try {
    expect((await entries.next()).done).toBe(false);
    await appendFile(fixture.path, "changed carrier");
    await expect(entries.next()).rejects.toMatchObject({ reason: "integrity" });
  } finally {
    await entries.return?.();
    await reader.close();
    await fixture.handle.close();
  }
});

it("rejects ZIP carrier mutation during member streaming", async () => {
  const directory = await createTestTempDirectory("rea-zip-stream-mutation-");
  const path = join(directory, "stream.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(
    "member.bin",
    new Uint8ArrayReader(new Uint8Array(512 * 1024)),
    { level: 0 },
  );
  await writeFile(path, await writer.close());
  const reader = new ZipArtifactReader(path, "zip");
  try {
    const entries: ArtifactEntry[] = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const stream = await reader.open(entries[0]!);
    const consume = async () => {
      let mutated = false;
      for await (const _chunk of stream) {
        if (!mutated) {
          mutated = true;
          await appendFile(path, "changed carrier");
        }
      }
    };
    await expect(consume()).rejects.toMatchObject({ reason: "integrity" });
  } finally {
    await reader.close();
  }
});
