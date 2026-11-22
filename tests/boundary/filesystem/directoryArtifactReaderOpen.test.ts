import { lstat, rename, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";

import { describe, expect, it } from "vitest";

import type { ArtifactEntry } from "../../../src/resources/ArtifactReader.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { DirectoryArtifactReader } from "../../../src/resources/index.js";

const sampleEntry = async (
  reader: DirectoryArtifactReader,
): Promise<ArtifactEntry> => {
  for await (const entry of reader.entries()) {
    if (entry.path === "sample.txt") return entry;
  }
  throw new Error("Fixture omitted sample.txt");
};

const fixture = async () => {
  const root = await createTestTempDirectory("rea-dir-reader-open-");
  const path = join(root, "sample.txt");
  await writeFile(path, "test payload\n");
  return { path, reader: new DirectoryArtifactReader(root) };
};

describe("DirectoryArtifactReader.open", () => {
  it("preserves enumerated file identity through positional inspection and streaming", async () => {
    const { path, reader } = await fixture();
    try {
      const entry = await sampleEntry(reader);
      const metadata = await lstat(path, { bigint: true });
      expect(entry.sourceIdentity).toEqual({
        device: metadata.dev,
        inode: metadata.ino,
        size: metadata.size,
        mode: metadata.mode,
        mtimeNs: metadata.mtimeNs,
        ctimeNs: metadata.ctimeNs,
      });
      const inspected = await reader.inspectFile(entry, async (file) => {
        const opened = await file.stat({ bigint: true });
        return {
          device: opened.dev,
          inode: opened.ino,
          contents: await file.readFile("utf8"),
        };
      });
      expect(inspected).toEqual({
        device: metadata.dev,
        inode: metadata.ino,
        contents: "test payload\n",
      });
      expect((await buffer(await reader.open(entry))).toString("utf8")).toBe(
        inspected.contents,
      );
    } finally {
      await reader.close();
    }
  });

  it("rejects an actual file replacement after enumeration", async () => {
    const { path, reader } = await fixture();
    try {
      const entry = await sampleEntry(reader);
      await rename(path, `${path}.original`);
      await writeFile(path, "replacement payload\n");
      await expect(reader.open(entry)).rejects.toMatchObject({
        reason: "integrity",
      });
    } finally {
      await reader.close();
    }
  });

  it.each(["changed in place with a new size\n", "TEST PAYLOAD\n"])(
    "rejects an in-place file change after enumeration: %s",
    async (replacement) => {
      const { path, reader } = await fixture();
      try {
        const entry = await sampleEntry(reader);
        const before = await lstat(path);
        await writeFile(path, replacement);
        await utimes(path, before.atime, new Date(before.mtimeMs + 1000));
        const after = await lstat(path);
        expect(after.ino).toBe(before.ino);
        await expect(reader.open(entry)).rejects.toMatchObject({
          reason: "integrity",
          integrityCheck: "member-identity",
        });
      } finally {
        await reader.close();
      }
    },
  );

  it.each(["truncate", "grow"])(
    "rejects a same-file %s between streamed chunks within the captured byte bound",
    async (mutation) => {
      const root = await createTestTempDirectory("rea-dir-reader-mutate-");
      const path = join(root, "sample.txt");
      const originalBytes = 1024 * 1024;
      await writeFile(path, Buffer.alloc(originalBytes, 0x61));
      const reader = new DirectoryArtifactReader(root);
      try {
        const entry = await sampleEntry(reader);
        const stream = await reader.open(entry);
        const iterator = stream[Symbol.asyncIterator]();
        const first = await iterator.next();
        expect(first.done).toBe(false);
        let observedBytes =
          first.value === undefined ? 0 : Buffer.byteLength(first.value);
        await writeFile(
          path,
          mutation === "truncate"
            ? "short replacement\n"
            : Buffer.alloc(2 * originalBytes, 0x62),
        );
        let failure: unknown;
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            observedBytes += Buffer.byteLength(next.value);
          }
        } catch (cause: unknown) {
          failure = cause;
        }
        expect(failure).toMatchObject({
          reason: "integrity",
          integrityCheck: "member-identity",
        });
        expect(observedBytes).toBeLessThanOrEqual(originalBytes + 1);
      } finally {
        await reader.close();
      }
    },
  );
});

describe("DirectoryArtifactReader input identity", () => {
  it("refuses a different captured device, including zero when it differs", async () => {
    const { reader } = await fixture();
    try {
      const entry = await sampleEntry(reader);
      const identity = entry.sourceIdentity;
      if (identity === undefined)
        throw new Error("Fixture omitted source identity");
      const differentDevices = [0n, identity.device + 1n].filter(
        (device) => device !== identity.device,
      );
      for (const device of differentDevices)
        await expect(
          reader.open({ ...entry, sourceIdentity: { ...identity, device } }),
        ).rejects.toMatchObject({
          reason: "integrity",
          integrityCheck: "member-identity",
        });
    } finally {
      await reader.close();
    }
  });

  it("rejects a file without enumerated source identity", async () => {
    const { reader } = await fixture();
    try {
      const { sourceIdentity: _identity, ...entry } = await sampleEntry(reader);
      await expect(reader.open(entry)).rejects.toMatchObject({
        reason: "integrity",
        integrityCheck: "entry-metadata",
      });
    } finally {
      await reader.close();
    }
  });

  it("rejects entries that are not files", async () => {
    const { reader } = await fixture();
    try {
      const entry = await sampleEntry(reader);
      await expect(
        reader.open({ ...entry, kind: "directory" }),
      ).rejects.toMatchObject({ reason: "format" });
    } finally {
      await reader.close();
    }
  });
});
