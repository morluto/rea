import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  backupImage,
  backupTar,
  encryptedBackupImage,
  paxRecord,
  tarChecksum,
} from "../../tests/fixtures/androidBackup.js";
import {
  AndroidBackupArtifactReader,
  ANDROID_BACKUP_MAX_BYTES,
} from "./AndroidBackupArtifactReader.js";
import { artifactFormatMetadataSchema } from "../domain/artifactFormatMetadata.js";
import { parseAndroidBackupHeader } from "../domain/androidBackup.js";
import type { ArtifactEntry } from "./ArtifactReader.js";

const withReader = async (
  image: Buffer,
  check: (reader: AndroidBackupArtifactReader, path: string) => Promise<void>,
): Promise<void> => {
  const directory = await createTestTempDirectory("rea-ab-");
  const path = join(directory, "input.ab");
  await writeFile(path, image);
  const reader = new AndroidBackupArtifactReader(path);
  try {
    await check(reader, path);
  } finally {
    await reader.close();
  }
};
const list = async (
  reader: AndroidBackupArtifactReader,
): Promise<ArtifactEntry[]> => {
  const entries: ArtifactEntry[] = [];
  for await (const entry of reader.entries()) entries.push(entry);
  return entries;
};
const content = async (
  reader: AndroidBackupArtifactReader,
  entry: ArtifactEntry,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of await reader.open(entry))
    chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

describe("offline Android backup reader", () => {
  it.each(
    [1, 2, 3, 4, 5].flatMap((version) =>
      [false, true].map((compressed) => ({ version, compressed })),
    ),
  )(
    "reads version $version, compressed=$compressed without running ADB",
    async (options) => {
      const tar = backupTar([
        { path: "apps/sample/f/", type: "5" },
        { path: "apps/sample/f/state.txt", data: "retained bytes" },
      ]);
      await withReader(backupImage(tar, options), async (reader) => {
        const entries = await list(reader);
        expect(entries.map(({ path }) => path)).toEqual([
          "apps/sample/f",
          "apps/sample/f/state.txt",
        ]);
        expect((await content(reader, entries[1]!)).toString()).toBe(
          "retained bytes",
        );
        expect(entries[1]).toMatchObject({
          sourcePath: "apps/sample/f/state.txt",
          declaredSize: 14,
          encrypted: false,
          byteOffset: options.compressed ? null : 24 + 1024,
          formatMetadata: {
            kind: "android-backup-entry",
            tar_header_offset: 512,
            tar_data_offset: 1024,
            mode: 0o600,
            pax: {},
          },
        });
        expect(
          artifactFormatMetadataSchema.safeParse(reader.formatMetadata())
            .success,
        ).toBe(true);
        expect(
          artifactFormatMetadataSchema.safeParse(entries[1]!.formatMetadata)
            .success,
        ).toBe(true);
        expect(reader.provenance()).toEqual([]);
      });
    },
  );

  it("reads empty archives, zero-byte files, USTAR prefixes and local PAX paths", async () => {
    await withReader(backupImage(backupTar([])), async (reader) =>
      expect(await list(reader)).toEqual([]),
    );
    const longPath = `apps/sample/f/${"x".repeat(150)}.json`;
    const pax = paxRecord("path", longPath) + paxRecord("mtime", "1.25");
    await withReader(
      backupImage(
        backupTar([
          { path: "empty", prefix: "apps/sample/f" },
          { path: "PaxHeader", type: "x", data: pax },
          { path: "fallback", data: "{}", mode: 0o700 },
        ]),
      ),
      async (reader) => {
        const entries = await list(reader);
        expect(entries.map(({ path }) => path)).toEqual([
          "apps/sample/f/empty",
          longPath,
        ]);
        expect((await content(reader, entries[0]!)).length).toBe(0);
        expect(entries[1]).toMatchObject({
          executable: true,
          formatMetadata: { pax: { path: longPath, mtime: "1.25" } },
        });
      },
    );
  });

  it("retains encrypted directory uncertainty rather than claiming an empty backup", async () => {
    const image = encryptedBackupImage();
    expect(parseAndroidBackupHeader(image)).toMatchObject({
      ok: true,
      value: { encryption: "AES-256", payloadOffset: null },
    });
    await withReader(image, async (reader) => {
      const coverage: unknown[] = [];
      for await (const _entry of reader.entries(undefined, {
        onCoverage: (value) => coverage.push(value),
      }))
        expect.fail("no decrypted entries");
      expect(reader.formatMetadata()).toMatchObject({
        encryption: "AES-256",
        directory_status: "encrypted",
        payload_offset: null,
      });
      expect(coverage).toEqual([
        {
          status: "unknown",
          limitations: [expect.stringContaining("No decryption was attempted")],
        },
      ]);
    });
  });
});

describe("Android backup refusal and ownership boundaries", () => {
  it.each([
    [
      "unsupported version",
      backupImage(backupTar([]), { version: 6 }),
      "unavailable",
    ],
    [
      "unknown encryption",
      backupImage(backupTar([]), { encryption: "other" }),
      "unavailable",
    ],
    ["truncated header", Buffer.from("ANDROID BACKUP\n5\n0\nnone"), "format"],
    [
      "invalid compression",
      Buffer.from("ANDROID BACKUP\n5\n2\nnone\n"),
      "format",
    ],
    [
      "truncated zlib",
      backupImage(backupTar([]), { compressed: true }).subarray(0, -1),
      "format",
    ],
    [
      "trailing zlib bytes",
      Buffer.concat([
        backupImage(backupTar([]), { compressed: true }),
        Buffer.from("extra"),
      ]),
      "format",
    ],
    [
      "missing tar end",
      backupImage(backupTar([{ path: "data", data: "x" }]).subarray(0, -1024)),
      "format",
    ],
    [
      "truncated member",
      backupImage(backupTar([{ path: "data", data: "x" }]).subarray(0, 513)),
      "format",
    ],
    [
      "symlink",
      backupImage(backupTar([{ path: "link", type: "2" }])),
      "unavailable",
    ],
    ["traversal", backupImage(backupTar([{ path: "../outside" }])), "path"],
    ["absolute path", backupImage(backupTar([{ path: "/outside" }])), "path"],
    [
      "duplicate",
      backupImage(backupTar([{ path: "same" }, { path: "same" }])),
      "path",
    ],
    [
      "prefix conflict",
      backupImage(backupTar([{ path: "same" }, { path: "same/child" }])),
      "path",
    ],
    [
      "malformed PAX",
      backupImage(backupTar([{ path: "Pax", type: "x", data: "99 path=x\n" }])),
      "format",
    ],
  ])("refuses %s", async (_name, image, reason) => {
    await withReader(image as Buffer, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason });
    });
  });

  it("verifies TAR checksums and numeric extents", async () => {
    const badChecksum = backupTar([{ path: "file" }]);
    badChecksum[0] = 0x78;
    const badSize = backupTar([{ path: "file" }]);
    badSize.write("77777777777\0", 124, "ascii");
    tarChecksum(badSize.subarray(0, 512));
    for (const tar of [badChecksum, badSize])
      await withReader(backupImage(tar), async (reader) =>
        expect(list(reader)).rejects.toMatchObject({ reason: "format" }),
      );
  });

  it("refuses decompression expansion before retaining an oversized TAR", async () => {
    const image = backupImage(Buffer.alloc(ANDROID_BACKUP_MAX_BYTES + 1), {
      compressed: true,
    });
    await withReader(image, async (reader) =>
      expect(list(reader)).rejects.toMatchObject({ reason: "limit" }),
    );
  });

  it("keeps cached member bytes private and rechecks carrier identity", async () => {
    await withReader(
      backupImage(backupTar([{ path: "file", data: "original" }])),
      async (reader, path) => {
        const [entry] = await list(reader);
        const first = await content(reader, entry!);
        first.fill(0);
        expect((await content(reader, entry!)).toString()).toBe("original");
        await expect(
          reader.open({ ...entry!, path: "changed" }),
        ).rejects.toMatchObject({ reason: "integrity" });
        await writeFile(path, "changed carrier length");
        await expect(reader.open(entry!)).rejects.toMatchObject({
          reason: "integrity",
        });
        const controller = new AbortController();
        const cause = new Error("selected cancellation");
        controller.abort(cause);
        await expect(
          reader.open(entry!, controller.signal),
        ).rejects.toMatchObject({ reason: "cancelled", cause });
      },
    );
  });
});

describe("Android backup capacity and stream retirement", () => {
  it("honors the local PAX size when the base header uses a placeholder", async () => {
    const tar = backupTar([
      { path: "Pax", type: "x", data: paxRecord("size", "2") },
      { path: "file", data: "{}" },
    ]);
    const header = tar.subarray(1024, 1536);
    header.write("00000000001\0", 124, "ascii");
    tarChecksum(header);
    await withReader(backupImage(tar), async (reader) => {
      const [entry] = await list(reader);
      expect(entry?.declaredSize).toBe(2);
      expect((await content(reader, entry!)).toString()).toBe("{}");
    });
  });

  it("refuses an oversized encoded payload before reading it", async () => {
    await withReader(backupImage(Buffer.alloc(0)), async (reader, path) => {
      await truncate(path, 24 + ANDROID_BACKUP_MAX_BYTES + 1);
      await expect(list(reader)).rejects.toMatchObject({ reason: "limit" });
    });
  });

  it("bounds PAX representation before decoding its text", async () => {
    const pax = paxRecord("path", "a".repeat(1_400_000));
    await withReader(
      backupImage(backupTar([{ path: "Pax", type: "x", data: pax }])),
      async (reader) => {
        await expect(list(reader)).rejects.toMatchObject({ reason: "limit" });
      },
    );
  });

  it("preserves unusual source spelling while refusing normalized duplicates", async () => {
    await withReader(
      backupImage(
        backupTar([
          { path: "\ufefffile", data: "one" },
          { path: "file ", data: "two" },
        ]),
      ),
      async (reader) => {
        expect(
          (await list(reader)).map(({ sourcePath }) => sourcePath),
        ).toEqual(["\ufefffile", "file "]);
      },
    );
    await withReader(
      backupImage(backupTar([{ path: "e\u0301" }, { path: "é" }])),
      async (reader) => {
        await expect(list(reader)).rejects.toMatchObject({ reason: "path" });
      },
    );
  });

  it("bounds open streams and retires paused readers on close", async () => {
    const payload = Buffer.alloc(150_000, 0x61);
    await withReader(
      backupImage(backupTar([{ path: "large", data: payload }]), {
        compressed: true,
      }),
      async (reader) => {
        const [entry] = await list(reader);
        expect((await content(reader, entry!)).equals(payload)).toBe(true);
        const streams = await Promise.all(
          Array.from({ length: 4 }, () => reader.open(entry!)),
        );
        await expect(reader.open(entry!)).rejects.toMatchObject({
          reason: "limit",
          boundary: "capacity",
        });
        await reader.close();
        expect(streams.every((stream) => stream.destroyed)).toBe(true);
        await expect(list(reader)).rejects.toMatchObject({
          reason: "unavailable",
        });
      },
    );
  });

  it("joins initialization when close starts before its first read completes", async () => {
    await withReader(backupImage(backupTar([])), async (reader) => {
      const preparing = list(reader);
      const closing = reader.close();
      await expect(preparing).rejects.toMatchObject({ reason: "unavailable" });
      await closing;
    });
  });
});
