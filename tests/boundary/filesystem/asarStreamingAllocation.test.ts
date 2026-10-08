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
import { join } from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { createPackageWithOptions } from "@electron/asar";
import { describe, expect, it } from "vitest";
import { scanArtifactInventory } from "../../../src/artifacts/inventory/ArtifactInventory.js";
import { AsarArtifactReader } from "../../../src/artifacts/AsarArtifactReader.js";
import {
  closeAsarHandle,
  readValidatedAsarEntry,
} from "../../../src/artifacts/AsarEntryStream.js";
import { hashReadable } from "../../../src/artifacts/ArtifactHash.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const memberBytes = 64 * 1024 * 1024;
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await matchingDescriptorCount(identity)) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await matchingDescriptorCount(identity)).toBe(0);
};

describe("ASAR entry streaming", () => {
  it.skipIf(process.platform === "win32")(
    "closes a packed member handle when its unopened output stream is destroyed",
    async () => {
      const root = await createTestTempDirectory(
        "rea-asar-destroy-before-read-",
      );
      const source = join(root, "source");
      const archive = join(root, "fixture.asar");
      await mkdir(source);
      await writeFile(join(source, "small.js"), "module.exports = 1;\n");
      await createPackageWithOptions(source, archive, {});

      const identity = await lstat(archive);
      const probe = await openFile(archive, "r");
      expect(await matchingDescriptorCount(identity)).toBeGreaterThan(0);
      await probe.close();
      await waitForNoMatchingDescriptor(identity);
      const reader = new AsarArtifactReader(archive);

      try {
        const entries = [];
        for await (const entry of reader.entries()) {
          entries.push(entry);
        }
        const entry = entries.find(({ path }) => path === "small.js");
        if (entry === undefined) throw new Error("Expected packed ASAR member");
        expect(await matchingDescriptorCount(identity)).toBe(0);
        const output = await reader.open(entry);
        expect(await matchingDescriptorCount(identity)).toBeGreaterThan(0);
        const closed = new Promise<void>((resolve) =>
          output.once("close", resolve),
        );
        output.destroy();
        await closed;
        await waitForNoMatchingDescriptor(identity);
      } finally {
        await reader.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "closes a packed member handle when cancellation arrives during open",
    async () => {
      const root = await createTestTempDirectory("rea-asar-abort-during-stat-");
      const source = join(root, "source");
      const archive = join(root, "fixture.asar");
      await mkdir(source);
      await writeFile(join(source, "small.js"), "module.exports = 1;\n");
      await createPackageWithOptions(source, archive, {});

      const identity = await lstat(archive);
      const reader = new AsarArtifactReader(archive);

      try {
        const entries = [];
        for await (const entry of reader.entries()) entries.push(entry);
        const entry = entries.find(({ path }) => path === "small.js");
        if (entry === undefined) throw new Error("Expected packed ASAR member");
        const controller = new AbortController();
        const opening = reader.open(entry, controller.signal);
        controller.abort();
        await expect(opening).rejects.toMatchObject({ reason: "cancelled" });
        await waitForNoMatchingDescriptor(identity);
      } finally {
        await reader.close();
      }
    },
  );

  it("classifies a missing packed member container as an I/O failure", async () => {
    const root = await createTestTempDirectory("rea-asar-missing-member-");
    const source = join(root, "source");
    const archive = join(root, "fixture.asar");
    await mkdir(source);
    await writeFile(join(source, "small.js"), "module.exports = 1;\n");
    await createPackageWithOptions(source, archive, {});

    const reader = new AsarArtifactReader(archive);
    try {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      const entry = entries.find(({ path }) => path === "small.js");
      if (entry === undefined) throw new Error("Expected packed ASAR member");
      await rm(archive);
      await expect(reader.open(entry)).rejects.toMatchObject({
        reason: "io",
        cause: { code: "ENOENT" },
      });
    } finally {
      await reader.close();
    }
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
            message: expect.stringContaining(
              `ASAR entry metadata changed since inventory: ${entry.path}`,
            ),
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
    "rejects a retained %s entry after a new entries pass",
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
        const currentEntries = [];
        for await (const entry of reader.entries()) currentEntries.push(entry);
        const current = currentEntries.find(({ path }) => path === "small.js");
        if (current === undefined)
          throw new Error("Expected refreshed ASAR file entry");
        expect(current.unpacked).toBe(!wasUnpacked);

        await expect(reader.open(copiedRetained)).rejects.toMatchObject({
          name: "ArtifactReaderFailure",
          reason: "integrity",
          message: expect.stringContaining(
            "ASAR entry metadata changed since inventory",
          ),
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
    "checks cancellation after closing an empty member handle",
    async () => {
      const root = await createTestTempDirectory("rea-asar-empty-close-");
      const archive = join(root, "container.asar");
      await writeFile(archive, "container bytes");
      const identity = await lstat(archive);
      const handle = await openFile(archive, "r");
      try {
        expect(await matchingDescriptorCount(identity)).toBeGreaterThan(0);
        const controller = new AbortController();

        await expect(
          closeAsarHandle(async () => {
            await handle.close();
            controller.abort();
          }, controller.signal),
        ).rejects.toMatchObject({ reason: "cancelled" });
        await waitForNoMatchingDescriptor(identity);
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "closes the opened unpacked file and retains ASAR context when handle stat fails",
    async () => {
      const root = await createTestTempDirectory("rea-asar-unpacked-stat-");
      const source = join(root, "source");
      const archive = join(root, "fixture.asar");
      await mkdir(source);
      await writeFile(join(source, "small.js"), "module.exports = 1;\n");
      await createPackageWithOptions(source, archive, { unpack: "small.js" });
      const unpackedPath = join(`${archive}.unpacked`, "small.js");
      const identity = await lstat(unpackedPath);
      const ioError = Object.assign(new Error("device stat failed"), {
        code: "EIO",
        errno: -5,
        syscall: "fstat",
      });
      let closeCount = 0;
      const reader = new AsarArtifactReader(archive, async (path, flags) => {
        const handle = await openFile(path, flags);
        expect(await matchingDescriptorCount(identity)).toBeGreaterThan(0);
        let statCount = 0;
        return {
          async stat() {
            statCount += 1;
            if (statCount === 2) throw ioError;
            return handle.stat();
          },
          async close() {
            closeCount += 1;
            await handle.close();
          },
          createReadStream: (options) => handle.createReadStream(options),
        };
      });

      try {
        const entries = [];
        for await (const entry of reader.entries()) entries.push(entry);
        const entry = entries.find(({ path }) => path === "small.js");
        if (entry === undefined)
          throw new Error("Expected unpacked ASAR member");

        await expect(reader.open(entry)).rejects.toMatchObject({
          name: "ArtifactReaderFailure",
          reason: "io",
          message: expect.stringContaining(
            `Could not read ${entry.path} ASAR at ${archive}: device stat failed`,
          ),
          cause: { code: "EIO", errno: -5, syscall: "fstat" },
        });
        expect(closeCount).toBe(1);
        await waitForNoMatchingDescriptor(identity);
      } finally {
        await reader.close();
      }
    },
  );

  it.each(["missing", "replaced"] as const)(
    "validates the container before returning a zero-length member when it is %s",
    async (change) => {
      const root = await createTestTempDirectory("rea-asar-empty-member-");
      const source = join(root, "source");
      const archive = join(root, "fixture.asar");
      await mkdir(source);
      await writeFile(join(source, "empty.js"), "");
      await createPackageWithOptions(source, archive, {});
      const reader = new AsarArtifactReader(archive);

      try {
        const entries = [];
        for await (const entry of reader.entries()) entries.push(entry);
        const entry = entries.find(({ path }) => path === "empty.js");
        if (entry === undefined) throw new Error("Expected empty ASAR member");
        if (change === "missing") await rm(archive);
        else await writeFile(archive, "replacement container");

        await expect(reader.open(entry)).rejects.toMatchObject(
          change === "missing"
            ? { reason: "io", cause: { code: "ENOENT" } }
            : { reason: "integrity" },
        );
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
    const source = Readable.from(
      (async function* () {
        yield Buffer.from("partial");
        throw ioError;
      })(),
    );
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
});

describe("ASAR entry streaming", () => {
  it("reports the observed digest when an unpacked member changes size", async () => {
    const root = await createTestTempDirectory(
      "rea-asar-unpacked-size-change-",
    );
    const source = join(root, "source");
    const archive = join(root, "fixture.asar");
    const original = join(source, "small.js");
    const changed = "changed();\n";
    await mkdir(source);
    await writeFile(original, "module.exports = 1;\n");
    await createPackageWithOptions(source, archive, { unpack: "small.js" });
    await writeFile(join(`${archive}.unpacked`, "small.js"), changed);

    await expect(scanArtifactInventory(archive)).rejects.toMatchObject({
      reason: "integrity",
      details: {
        logicalPath: "small.js",
        calculatedSha256: createHash("sha256").update(changed).digest("hex"),
        unpacked: true,
      },
    });
  });

  it.each([
    ["packed", {}],
    ["unpacked", { unpack: "large.bin" }],
  ] as const)(
    "opens a %s member without allocating its full contents",
    async (_kind, options) => {
      const root = await createTestTempDirectory("rea-asar-streaming-");
      const source = join(root, "source");
      const archive = join(root, "fixture.asar");
      const member = join(source, "large.bin");
      await mkdir(source);
      await writeFile(member, Buffer.alloc(0));
      await truncate(member, memberBytes);
      await createPackageWithOptions(source, archive, options);

      const reader = new AsarArtifactReader(archive);
      try {
        const entries = [];
        for await (const entry of reader.entries()) entries.push(entry);
        const entry = entries.find(({ path }) => path === "large.bin");
        if (entry === undefined) throw new Error("Expected large ASAR member");

        const before = process.memoryUsage().arrayBuffers;
        const stream = await reader.open(entry);
        const afterOpen = process.memoryUsage().arrayBuffers;
        const observed = await hashReadable(stream);
        const allocation = afterOpen - before;

        expect(allocation).toBeLessThan(memberBytes / 2);
        expect(observed).toMatchObject({
          sha256: expectedSha256(),
          bytes: memberBytes,
        });
      } finally {
        await reader.close();
      }
    },
    120_000,
  );
});
