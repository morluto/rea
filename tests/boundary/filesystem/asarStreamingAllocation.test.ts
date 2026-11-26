import { createHash } from "node:crypto";
import { fstatSync, type Stats } from "node:fs";
import {
  open as openFile,
  lstat,
  mkdir,
  rm,
  readdir,
  writeFile,
  truncate,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { createPackageWithOptions } from "@electron/asar";
import { describe, expect, it, onTestFinished } from "vitest";
import { scanArtifactInventory } from "../../fixtures/artifactInventory.js";
import { AsarArtifactReader } from "../../../src/artifacts/AsarArtifactReader.js";
import {
  readValidatedAsarEntry,
  readValidatedAsarRange,
} from "../../../src/artifacts/AsarEntryStream.js";
import { hashReadable } from "../../../src/artifacts/ArtifactHash.js";
import { ARTIFACT_CLASSIFICATION_PREFIX_BYTES } from "../../../src/artifacts/ArtifactClassificationProbe.js";
import { asarHeaderBytes } from "../../fixtures/asarHeader.js";
import { readArtifactFileChunks } from "../../../src/resources/readArtifactFileChunks.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const memberBytes = 64 * 1024 * 1024;
const maximumObservedChunkBytes = 1024 * 1024;
const expectedSha256 = (): string => {
  const hash = createHash("sha256");
  const zeros = Buffer.alloc(64 * 1024);
  for (let written = 0; written < memberBytes; written += zeros.length)
    hash.update(zeros);
  return hash.digest("hex");
};

const descriptorDirectory =
  process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd";

const matchingDescriptorCount = async (identity: Stats): Promise<number> => {
  const descriptors = await readdir(descriptorDirectory);
  return descriptors.filter((descriptor) => {
    if (!/^\d+$/u.test(descriptor)) return false;
    try {
      const observed = fstatSync(Number(descriptor));
      return observed.dev === identity.dev && observed.ino === identity.ino;
    } catch {
      return false;
    }
  }).length;
};

const waitForNoMatchingDescriptor = async (identity: Stats): Promise<void> => {
  await expect.poll(() => matchingDescriptorCount(identity)).toBe(0);
};

const createUnpackedFixture = async () => {
  const root = await createTestTempDirectory("rea-asar-unpacked-");
  const source = join(root, "source");
  const archive = join(root, "fixture.asar");
  await mkdir(source);
  await writeFile(join(source, "small.js"), "module.exports = 1;\n");
  await createPackageWithOptions(source, archive, { unpack: "small.js" });
  const unpackedPath = join(`${archive}.unpacked`, "small.js");
  return {
    archive,
    unpackedPath,
    identity: await lstat(unpackedPath),
  };
};

const unpackedMember = async (reader: AsarArtifactReader) => {
  const entries = [];
  for await (const entry of reader.entries()) entries.push(entry);
  const member = entries.find(({ path }) => path === "small.js");
  if (member === undefined) throw new Error("Expected unpacked ASAR member");
  return member;
};

const expectRetainedHandleRecovery = async (
  reader: AsarArtifactReader,
  identity: Stats,
  closeCount: () => number,
): Promise<void> => {
  expect(closeCount()).toBe(1);
  expect(await matchingDescriptorCount(identity)).toBeGreaterThan(0);
  await reader.close();
  expect(closeCount()).toBe(2);
  await waitForNoMatchingDescriptor(identity);
};

const packedContents = "module.exports = 1;\n";

const createPackedFixture = async () => {
  const root = await createTestTempDirectory("rea-asar-packed-");
  const archive = join(root, "fixture.asar");
  const payload = Buffer.from(packedContents);
  const header = asarHeaderBytes(
    JSON.stringify({
      files: {
        "empty.js": { size: 0, offset: "0" },
        "small.js": { size: payload.length, offset: "0" },
      },
    }),
  );
  await writeFile(archive, Buffer.concat([header, payload]));
  return archive;
};

describe("ASAR entry streaming", () => {
  it.skipIf(process.platform === "win32")(
    "reuses one snapshot descriptor across container and packed member streams until reader close",
    async () => {
      const archive = await createPackedFixture();
      let snapshotPath: string | undefined;
      let snapshotOpens = 0;
      const reader = new AsarArtifactReader(archive, {
        openFile: async (path, flags) => {
          if (path !== archive) {
            snapshotPath = path;
            snapshotOpens += 1;
          }
          return openFile(path, flags);
        },
      });

      try {
        const entries = [];
        for await (const entry of reader.entries()) {
          entries.push(entry);
        }
        const entry = entries.find(({ path }) => path === "small.js");
        if (entry === undefined) throw new Error("Expected packed ASAR member");
        if (snapshotPath === undefined)
          throw new Error("Expected snapshot acquisition");
        const identity = await lstat(snapshotPath);
        expect(snapshotOpens).toBe(1);
        expect(await matchingDescriptorCount(identity)).toBe(1);

        const snapshot = await reader.openContainer();
        await buffer(snapshot);
        expect(snapshotOpens).toBe(1);
        expect(await matchingDescriptorCount(identity)).toBe(1);

        const output = await reader.open(entry);
        expect(snapshotOpens).toBe(1);
        expect(await matchingDescriptorCount(identity)).toBe(1);
        const closed = new Promise<void>((resolve) =>
          output.once("close", resolve),
        );
        output.destroy();
        await closed;
        expect(output.destroyed).toBe(true);
        expect(await matchingDescriptorCount(identity)).toBe(1);

        const second = await reader.open(entry);
        expect((await buffer(second)).toString("utf8")).toBe(packedContents);
        expect(snapshotOpens).toBe(1);
        expect(await matchingDescriptorCount(identity)).toBe(1);

        await reader.close();
        await waitForNoMatchingDescriptor(identity);
      } finally {
        await reader.close();
      }
    },
  );

  it("closes an acquired snapshot handle before returning cancellation", async () => {
    const archive = await createPackedFixture();
    const cancellation = new Error("cancel at snapshot handle acquisition");
    let controller: AbortController | undefined;
    let snapshotHandle: FileHandle | undefined;
    const reader = new AsarArtifactReader(archive, {
      openFile: async (path, flags) => {
        const handle = await openFile(path, flags);
        if (path !== archive && controller !== undefined) {
          snapshotHandle = handle;
          controller.abort(cancellation);
        }
        return handle;
      },
    });
    try {
      await reader.prepareContainer();
      controller = new AbortController();
      await expect(
        reader.openContainer(controller.signal),
      ).rejects.toMatchObject({
        reason: "cancelled",
        cause: cancellation,
      });
      expect(snapshotHandle?.fd).toBe(-1);
    } finally {
      await reader.close();
    }
  });

  it.each(["missing", "replaced"] as const)(
    "reads captured empty and nonempty members when the original container is %s",
    async (change) => {
      const archive = await createPackedFixture();
      const reader = new AsarArtifactReader(archive);
      try {
        const entries = [];
        for await (const entry of reader.entries()) entries.push(entry);
        if (change === "missing") await rm(archive);
        else await writeFile(archive, "replacement container");

        const observed = [];
        for (const entry of entries)
          observed.push([
            entry.path,
            (await buffer(await reader.open(entry))).toString("utf8"),
          ]);
        expect(observed).toEqual([
          ["empty.js", ""],
          ["small.js", packedContents],
        ]);
      } finally {
        await reader.close();
      }
    },
  );
});

describe("ASAR range streaming", () => {
  it("propagates cancellation during an in-flight range read even under stream backpressure", async () => {
    const controller = new AbortController();
    const cancellation = new Error("abort during paused chunk");
    const chunkBytes = 256 * 1024;
    let readCalls = 0;
    const read = (async (target: Buffer, offset: number, length: number) => {
      readCalls += 1;
      controller.abort(cancellation);
      target.fill(0x61, offset, offset + length);
      return { bytesRead: length, buffer: target };
    }) as FileHandle["read"];
    const output = readValidatedAsarRange(
      { read },
      0,
      chunkBytes * 2,
      "large.bin",
      "/fixture/archive.asar",
      controller.signal,
    );
    const failed = new Promise<Error>((resolve) =>
      output.once("error", resolve),
    );
    output.pause();
    output.read(0);
    await expect(failed).resolves.toMatchObject({
      reason: "cancelled",
      cause: cancellation,
    });
    expect(readCalls).toBe(1);
  });

  it("rejects out-of-bounds range reads with declared-size integrity failure", async () => {
    const read = (async (target: Buffer, _offset: number, length: number) => ({
      bytesRead: length + 1,
      buffer: target,
    })) as FileHandle["read"];
    const output = readValidatedAsarRange(
      { read },
      0,
      16,
      "overread.bin",
      "/fixture/archive.asar",
    );
    await expect(buffer(output)).rejects.toMatchObject({
      reason: "integrity",
      integrityCheck: "declared-size",
    });
  });
});

describe("ASAR entry producer identity", () => {
  it.each([false, true] as const)(
    "rejects a copied entry with a changed unpacked flag for unpacked=%s",
    async (unpacked) => {
      const root = await createTestTempDirectory("rea-asar-entry-identity-");
      const source = join(root, "source");
      const archive = join(root, "fixture.asar");
      await mkdir(source);
      await writeFile(join(source, "small.js"), "module.exports = 1;\n");
      await createPackageWithOptions(
        source,
        archive,
        unpacked ? { unpack: "small.js" } : {},
      );
      const selectedPath = unpacked
        ? join(`${archive}.unpacked`, "small.js")
        : archive;
      const identity = await lstat(selectedPath);
      const reader = new AsarArtifactReader(archive);

      try {
        const entries = [];
        for await (const entry of reader.entries()) entries.push(entry);
        const entry = entries.find(({ path }) => path === "small.js");
        if (entry === undefined) throw new Error("Expected ASAR file entry");
        expect(entry.unpacked).toBe(unpacked);
        expect(await matchingDescriptorCount(identity)).toBe(0);
        if (entry.declaredSize === null)
          throw new Error("Expected ASAR file size metadata");

        for (const changedEntry of [
          { ...entry, unpacked: !entry.unpacked },
          { ...entry, path: `stale/${entry.path}` },
          { ...entry, declaredSize: entry.declaredSize + 1 },
        ])
          await expect(reader.open(changedEntry)).rejects.toMatchObject({
            name: "ArtifactReaderFailure",
            reason: "integrity",
            integrityCheck: "entry-metadata",
            message: expect.stringContaining(entry.path),
          });
        await waitForNoMatchingDescriptor(identity);
      } finally {
        await reader.close();
      }
    },
  );

  it.each([
    ["packed to unpacked", false],
    ["unpacked to packed", true],
  ] as const)(
    "rejects a retained %s entry after closing and recapturing the archive",
    async (_transition, wasUnpacked) => {
      const root = await createTestTempDirectory("rea-asar-entry-refresh-");
      const source = join(root, "source");
      const archive = join(root, "fixture.asar");
      const memberContents = "module.exports = 1;\n";
      await mkdir(source);
      await writeFile(join(source, "small.js"), memberContents);
      const reader = new AsarArtifactReader(archive);

      try {
        await createPackageWithOptions(
          source,
          archive,
          wasUnpacked ? { unpack: "small.js" } : {},
        );
        const firstEntries = [];
        for await (const entry of reader.entries()) firstEntries.push(entry);
        const retained = firstEntries.find(({ path }) => path === "small.js");
        if (retained === undefined)
          throw new Error("Expected first ASAR file entry");
        const copiedRetained = {
          ...retained,
          limitations: [...retained.limitations],
        };

        await createPackageWithOptions(
          source,
          archive,
          wasUnpacked ? {} : { unpack: "small.js" },
        );
        await reader.close();
        const currentEntries = [];
        for await (const entry of reader.entries()) currentEntries.push(entry);
        const current = currentEntries.find(({ path }) => path === "small.js");
        if (current === undefined)
          throw new Error("Expected refreshed ASAR file entry");
        expect(current.unpacked).toBe(!wasUnpacked);

        await expect(reader.open(copiedRetained)).rejects.toMatchObject({
          name: "ArtifactReaderFailure",
          reason: "integrity",
          integrityCheck: "entry-metadata",
        });
        expect((await buffer(await reader.open(current))).toString()).toBe(
          memberContents,
        );
      } finally {
        await reader.close();
      }
    },
  );
});

describe("ASAR read failures", () => {
  it.skipIf(process.platform === "win32")(
    "closes the opened unpacked file and retains ASAR context when handle stat fails",
    async () => {
      const { archive, unpackedPath, identity } = await createUnpackedFixture();
      const ioError = Object.assign(new Error("device stat failed"), {
        code: "EIO",
        errno: -5,
        syscall: "fstat",
      });
      const closeError = Object.assign(new Error("device close failed"), {
        code: "EIO",
        errno: -5,
        syscall: "close",
      });
      let closeCount = 0;
      const reader = new AsarArtifactReader(archive, {
        openUnpackedFile: async (path, flags) => {
          const handle = await openFile(path, flags);
          expect(await matchingDescriptorCount(identity)).toBeGreaterThan(0);
          return {
            get fd() {
              return handle.fd;
            },
            async stat() {
              throw ioError;
            },
            async close() {
              closeCount += 1;
              if (closeCount === 1) throw closeError;
              await handle.close();
            },
            read: handle.read.bind(handle),
          };
        },
      });

      try {
        const entry = await unpackedMember(reader);

        await expect(reader.open(entry)).rejects.toMatchObject({
          name: "ArtifactReaderFailure",
          reason: "io",
          message: expect.stringContaining(
            `Could not read ${entry.path} ASAR at ${archive}: device stat failed`,
          ),
          cause: {
            reason: "io",
            cause: { code: "EIO", errno: -5, syscall: "fstat" },
          },
          cleanup: {
            resources: [unpackedPath],
            reason: "device close failed",
          },
        });
        await expectRetainedHandleRecovery(reader, identity, () => closeCount);
      } finally {
        await reader.close();
      }
    },
  );
});

it.skipIf(process.platform === "win32")(
  "never treats an invalidated unpacked handle as proof of cleanup recovery",
  async () => {
    const { archive, unpackedPath, identity } = await createUnpackedFixture();
    const statFailure = Object.assign(new Error("unpacked metadata failed"), {
      code: "EIO",
      errno: -5,
      syscall: "fstat",
    });
    const closeFailure = new Error("native close outcome unavailable");
    let closeCount = 0;
    let snapshotRoot: string | undefined;
    const reader = new AsarArtifactReader(archive, {
      openFile: async (path, flags) => {
        if (path !== archive && snapshotRoot === undefined) {
          const root = dirname(path);
          snapshotRoot = root;
          // This fixture deliberately reports an unrecoverable close outcome.
          // Remove its retained snapshot only after testing reader ownership.
          onTestFinished(() => rm(root, { recursive: true, force: true }));
        }
        return openFile(path, flags);
      },
      openUnpackedFile: async (path, flags) => {
        const handle = await openFile(path, flags);
        return {
          get fd() {
            return handle.fd;
          },
          async stat() {
            throw statFailure;
          },
          async close() {
            closeCount += 1;
            // Model Node's invalidated-descriptor rejection without leaking a
            // native descriptor in the test process.
            await handle.close();
            throw closeFailure;
          },
          read: handle.read.bind(handle),
        };
      },
    });
    const entry = await unpackedMember(reader);
    await expect(reader.open(entry)).rejects.toMatchObject({
      reason: "io",
      message: expect.stringContaining("unpacked metadata failed"),
      cleanup: {
        resources: [unpackedPath],
        reason: "native close outcome unavailable",
      },
    });
    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(reader.close()).rejects.toMatchObject({
        cleanup: { resources: [unpackedPath] },
      });
    expect(closeCount).toBe(1);
    await waitForNoMatchingDescriptor(identity);
    if (snapshotRoot === undefined) throw new Error("Expected ASAR snapshot");
    expect((await lstat(snapshotRoot)).isDirectory()).toBe(true);
  },
);

it.skipIf(process.platform === "win32")(
  "retries cleanup when cancellation arrives immediately after unpacked stat",
  async () => {
    const { archive, unpackedPath, identity } = await createUnpackedFixture();
    const controller = new AbortController();
    let closeCount = 0;
    const reader = new AsarArtifactReader(archive, {
      openUnpackedFile: async (path, flags) => {
        const handle = await openFile(path, flags);
        return {
          get fd() {
            return handle.fd;
          },
          async stat() {
            const observed = await handle.stat();
            controller.abort();
            return observed;
          },
          async close() {
            closeCount += 1;
            if (closeCount === 1) throw new Error("first close failed");
            await handle.close();
          },
          read: handle.read.bind(handle),
        };
      },
    });

    try {
      const entry = await unpackedMember(reader);

      await expect(reader.open(entry, controller.signal)).rejects.toMatchObject(
        {
          reason: "cancelled",
          cleanup: {
            resources: [unpackedPath],
            reason: "first close failed",
          },
        },
      );
      await expectRetainedHandleRecovery(reader, identity, () => closeCount);
    } finally {
      await reader.close();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "preserves an unpacked identity failure when closing its handle fails",
  async () => {
    const { archive, unpackedPath, identity } = await createUnpackedFixture();
    const closeError = new Error("first close failed");
    let closeCount = 0;
    const reader = new AsarArtifactReader(archive, {
      openUnpackedFile: async (path, flags) => {
        const handle = await openFile(path, flags);
        return {
          get fd() {
            return handle.fd;
          },
          async stat() {
            const observed = await handle.stat();
            return Object.assign(Object.create(observed), {
              ino: observed.ino + 1,
            });
          },
          async close() {
            closeCount += 1;
            if (closeCount === 1) throw closeError;
            await handle.close();
          },
          read: handle.read.bind(handle),
        };
      },
    });

    try {
      const entry = await unpackedMember(reader);

      await expect(reader.open(entry)).rejects.toMatchObject({
        name: "ArtifactReaderFailure",
        reason: "integrity",
        integrityCheck: "unpacked-entry-identity",
        message: expect.stringContaining(entry.path),
        cleanup: {
          resources: [unpackedPath],
          reason: "first close failed",
        },
      });
      await expectRetainedHandleRecovery(reader, identity, () => closeCount);
    } finally {
      await reader.close();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "retains unpacked handles before retrying snapshot cleanup failures",
  async () => {
    const { archive, unpackedPath, identity } = await createUnpackedFixture();
    const closeError = new Error("unpacked close denied");
    const snapshotError = new Error("snapshot removal denied");
    let closeCount = 0;
    const snapshotPaths: string[] = [];
    const reader = new AsarArtifactReader(archive, {
      openUnpackedFile: async (path, flags) => {
        const handle = await openFile(path, flags);
        return {
          get fd() {
            return handle.fd;
          },
          async stat() {
            throw Object.assign(new Error("device stat failed"), {
              code: "EIO",
              errno: -5,
              syscall: "fstat",
            });
          },
          async close() {
            closeCount += 1;
            if (closeCount < 3) throw closeError;
            await handle.close();
          },
          read: handle.read.bind(handle),
        };
      },
      removeSnapshot: async (path) => {
        snapshotPaths.push(path);
        if (snapshotPaths.length === 1) throw snapshotError;
        await rm(path, { recursive: true, force: true });
      },
    });

    try {
      const entry = await unpackedMember(reader);

      await expect(reader.open(entry)).rejects.toMatchObject({
        reason: "io",
        cleanup: { resources: [unpackedPath] },
      });
      expect(closeCount).toBe(1);

      const cleanupFailure = await reader.close().then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(cleanupFailure).toMatchObject({
        cleanup: {
          resources: [unpackedPath],
          reason: expect.stringContaining("unpacked close denied"),
        },
      });
      expect(closeCount).toBe(2);
      expect(snapshotPaths).toEqual([]);
      expect(await matchingDescriptorCount(identity)).toBeGreaterThan(0);

      await expect(reader.close()).rejects.toMatchObject({
        message: snapshotError.message,
        cleanup: { resources: [expect.any(String)] },
      });
      expect(closeCount).toBe(3);
      await waitForNoMatchingDescriptor(identity);
      const snapshotRoot = snapshotPaths[0];
      if (snapshotRoot === undefined)
        throw new Error("Expected owned ASAR snapshot root");
      expect(snapshotPaths).toEqual([snapshotRoot]);
      expect((await lstat(snapshotRoot)).isDirectory()).toBe(true);

      await reader.close();
      expect(closeCount).toBe(3);
      expect(snapshotPaths).toEqual([snapshotRoot, snapshotRoot]);
      await waitForNoMatchingDescriptor(identity);
      await expect(lstat(snapshotRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await reader.close();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "releases unpacked handles after stream completion and cancellation",
  async () => {
    const { archive, identity } = await createUnpackedFixture();
    const reader = new AsarArtifactReader(archive);

    try {
      const entry = await unpackedMember(reader);
      expect((await buffer(await reader.open(entry))).toString()).toBe(
        "module.exports = 1;\n",
      );
      await waitForNoMatchingDescriptor(identity);

      const controller = new AbortController();
      const output = await reader.open(entry, controller.signal);
      const reading = buffer(output);
      controller.abort();
      await expect(reading).rejects.toMatchObject({ reason: "cancelled" });
      await waitForNoMatchingDescriptor(identity);
    } finally {
      await reader.close();
    }
  },
);

it("preserves filesystem errors raised while consuming a member stream", async () => {
  const ioError = Object.assign(new Error("device read failed"), {
    code: "EIO",
    errno: -5,
    syscall: "read",
  });
  let delivered = false;
  const read = (async (target: Buffer) => {
    if (delivered) throw ioError;
    delivered = true;
    const partial = Buffer.from("partial");
    partial.copy(target);
    return { bytesRead: partial.length, buffer: target };
  }) as FileHandle["read"];
  const source = readArtifactFileChunks({ read });
  const output = readValidatedAsarEntry(
    source,
    undefined,
    "nested/member.bin",
    "/tmp/source.asar",
  );

  await expect(async () => {
    for await (const _chunk of output) {
      // Consume through the source failure.
    }
  }).rejects.toMatchObject({
    name: "ArtifactReaderFailure",
    reason: "io",
    message: expect.stringContaining(
      "Could not read nested/member.bin ASAR at /tmp/source.asar",
    ),
    cause: { code: "EIO", errno: -5, syscall: "read" },
  });
});

describe("ASAR entry streaming", () => {
  it("matches ASAR after a long JSON prefix without retaining it in the classification prefix", async () => {
    const bytes = asarHeaderBytes(`${" ".repeat(9_000)}{"files":{}}`);
    const observed = await hashReadable(
      Readable.from(
        (async function* () {
          for (const byte of bytes) yield Buffer.of(byte);
        })(),
      ),
    );

    expect(observed.prefix).toHaveLength(ARTIFACT_CLASSIFICATION_PREFIX_BYTES);
    expect(observed.asarHeader).toMatchObject({
      state: "matched",
      signatureOffset: 16 + 9_000,
      extents: {
        jsonBytes: Buffer.byteLength(`${" ".repeat(9_000)}{"files":{}}`),
      },
    });
    expect(observed.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  });

  it("reports the observed digest when an unpacked member changes size", async () => {
    const { archive, unpackedPath } = await createUnpackedFixture();
    const changed = "changed();\n";
    await writeFile(unpackedPath, changed);

    await expect(scanArtifactInventory(archive)).rejects.toMatchObject({
      reason: "integrity",
      details: {
        logicalPath: "small.js",
        calculatedSha256: createHash("sha256").update(changed).digest("hex"),
        unpacked: true,
      },
    });
  });

  it.each(["packed", "unpacked"] as const)(
    "streams a %s member in bounded chunks with its complete digest",
    async (kind) => {
      const root = await createTestTempDirectory("rea-asar-streaming-");
      const archive = join(root, "fixture.asar");
      const unpacked = kind === "unpacked";
      const header = asarHeaderBytes(
        JSON.stringify({
          files: { "large.bin": { size: memberBytes, offset: "0", unpacked } },
        }),
      );
      await writeFile(archive, header);
      if (unpacked) {
        const companion = `${archive}.unpacked`;
        await mkdir(companion);
        const member = join(companion, "large.bin");
        await writeFile(member, "");
        await truncate(member, memberBytes);
      } else {
        await truncate(archive, header.length + memberBytes);
      }

      const reader = new AsarArtifactReader(archive);
      try {
        const entries = [];
        for await (const entry of reader.entries()) entries.push(entry);
        const entry = entries.find(({ path }) => path === "large.bin");
        if (entry === undefined) throw new Error("Expected large ASAR member");
        expect(entry.unpacked).toBe(unpacked);

        const stream = await reader.open(entry);
        let largestChunkBytes = 0;
        const measuredStream = Readable.from(
          (async function* () {
            for await (const chunk of stream) {
              largestChunkBytes = Math.max(largestChunkBytes, chunk.byteLength);
              yield chunk;
            }
          })(),
        );
        const observed = await hashReadable(measuredStream);

        expect(largestChunkBytes).toBeLessThanOrEqual(
          maximumObservedChunkBytes,
        );
        expect(observed).toMatchObject({
          sha256: expectedSha256(),
          bytes: memberBytes,
        });
      } finally {
        await reader.close();
      }
    },
  );
});
