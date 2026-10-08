import { lstat, open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";

import { describe, expect, it } from "vitest";

import { type ArtifactEntry } from "../../../src/artifacts/ArtifactReader.js";
import { DirectoryArtifactReader } from "../../../src/artifacts/DirectoryArtifactReader.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

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
  it("preserves native path and handle identity while streaming an unchanged file", async () => {
    const { path, reader } = await fixture();
    try {
      const entry = await sampleEntry(reader);
      const metadata = await lstat(path);
      const handle = await open(path, "r");
      try {
        const observed = await handle.stat();
        expect(entry.sourceIdentity).toEqual({
          device: metadata.dev,
          inode: metadata.ino,
        });
        expect({ device: observed.dev, inode: observed.ino }).toEqual(
          entry.sourceIdentity,
        );
        console.info(
          JSON.stringify({
            platform: process.platform,
            node: process.version,
            pathDevice: metadata.dev,
            handleDevice: observed.dev,
            pathInode: metadata.ino,
            handleInode: observed.ino,
          }),
        );
      } finally {
        await handle.close();
      }
      expect((await buffer(await reader.open(entry))).toString("utf8")).toBe(
        "test payload\n",
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

  it.each(["zero", "another"] as const)(
    "requires the enumerated %s device to match the opened file",
    async (kind) => {
      const { reader } = await fixture();
      try {
        const entry = await sampleEntry(reader);
        const identity = entry.sourceIdentity;
        if (identity === undefined)
          throw new Error("Fixture omitted source identity");
        if (kind === "zero" && identity.device === 0) {
          expect(
            (await buffer(await reader.open(entry))).toString("utf8"),
          ).toBe("test payload\n");
          return;
        }
        const device = kind === "zero" ? 0 : identity.device === 1 ? 2 : 1;
        await expect(
          reader.open({ ...entry, sourceIdentity: { ...identity, device } }),
        ).rejects.toMatchObject({ reason: "integrity" });
      } finally {
        await reader.close();
      }
    },
  );

  it("rejects a file without enumerated source identity", async () => {
    const { reader } = await fixture();
    try {
      const { sourceIdentity: _identity, ...entry } = await sampleEntry(reader);
      await expect(reader.open(entry)).rejects.toMatchObject({
        reason: "integrity",
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
