import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { text } from "node:stream/consumers";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  buildWxapkg,
  wxapkgEncryptedBytes,
  type WxapkgMember,
} from "../../tests/fixtures/wxapkg.js";

import type {
  ArtifactEntry,
  ArtifactTraversalOptions,
} from "./ArtifactReader.js";
import { WxapkgArtifactReader } from "./WxapkgArtifactReader.js";

const writePackage = async (bytes: Buffer): Promise<string> => {
  const path = join(
    await createTestTempDirectory("rea-wxapkg-"),
    "package.wxapkg",
  );
  await writeFile(path, bytes);
  return path;
};

const list = async (
  reader: WxapkgArtifactReader,
  options?: ArtifactTraversalOptions,
): Promise<ArtifactEntry[]> => {
  const entries: ArtifactEntry[] = [];
  for await (const entry of reader.entries(undefined, options))
    entries.push(entry);
  return entries;
};

const withReader = async <T>(
  bytes: Buffer,
  use: (reader: WxapkgArtifactReader) => Promise<T>,
): Promise<T> => {
  const reader = new WxapkgArtifactReader(await writePackage(bytes));
  try {
    return await use(reader);
  } finally {
    await reader.close();
  }
};

const members: readonly WxapkgMember[] = [
  { path: "app-config.json", data: "{}" },
  { path: "pages/index/index.js", data: "module.exports={};" },
  { path: "empty.wxss", data: "" },
];

describe("WxapkgArtifactReader", () => {
  it("lists members and reads their declared bytes", async () => {
    await withReader(buildWxapkg(members), async (reader) => {
      const entries = await list(reader);
      expect(entries.map(({ path }) => path)).toEqual([
        "app-config.json",
        "pages/index/index.js",
        "empty.wxss",
      ]);
      expect(await text(await reader.open(entries[0]!))).toBe("{}");
      expect(await text(await reader.open(entries[1]!))).toBe(
        "module.exports={};",
      );
      expect(await text(await reader.open(entries[2]!))).toBe("");
    });
  });

  it("preserves member provenance on entries and metadata", async () => {
    await withReader(buildWxapkg(members), async (reader) => {
      const entries = await list(reader);
      const entry = entries[1]!;
      expect(entry).toMatchObject({
        path: "pages/index/index.js",
        sourcePath: "pages/index/index.js",
        kind: "file",
        declaredSize: 18,
        compressedSize: null,
        encrypted: false,
        declaredIntegrity: null,
        unpacked: false,
        adapterKey: "wxapkg-entry:1",
        formatMetadata: {
          kind: "wxapkg-entry",
          index: 1,
          source_path: "pages/index/index.js",
        },
      });
      // Member offsets are absolute carrier positions after the table.
      expect(entry.byteOffset).toBeGreaterThanOrEqual(18);
      expect(reader.formatMetadata()).toMatchObject({
        kind: "wxapkg",
        file_count: 3,
        directory_status: "available",
      });
    });
  });

  it("reads a member larger than the chunk size", async () => {
    const data = Buffer.alloc(200 * 1024, 0x61);
    await withReader(
      buildWxapkg([{ path: "big.bin", data }]),
      async (reader) => {
        const [entry] = await list(reader);
        const chunks: Buffer[] = [];
        for await (const chunk of await reader.open(entry!))
          chunks.push(chunk as Buffer);
        expect(Buffer.concat(chunks).equals(data)).toBe(true);
      },
    );
  });

  it("accepts consecutive dots and unicode names", async () => {
    await withReader(
      buildWxapkg([
        { path: "data..bin", data: "a" },
        { path: "页面/配置.json", data: "b" },
      ]),
      async (reader) => {
        const entries = await list(reader);
        expect(entries[0]?.path).toBe("data..bin");
        expect(entries[1]?.path).toBe("页面/配置.json");
        expect(await text(await reader.open(entries[1]!))).toBe("b");
      },
    );
  });

  it("exposes no members for a V1MMWX-encrypted package", async () => {
    await withReader(wxapkgEncryptedBytes(), async (reader) => {
      const coverage: {
        status?: string;
        limitations?: readonly string[];
      } = {};
      const entries = await list(reader, {
        onCoverage: (observation) => {
          coverage.status = observation.status;
          coverage.limitations = observation.limitations;
        },
      });
      expect(entries).toEqual([]);
      expect(coverage.status).toBe("unknown");
      expect(coverage.limitations?.join(" ")).toContain("V1MMWX");
      expect(reader.formatMetadata()).toMatchObject({
        kind: "wxapkg",
        directory_status: "encrypted",
        file_count: null,
      });
    });
  });
});

describe("WxapkgArtifactReader malformed inputs", () => {
  it.each([
    ["wrong first mark", { firstMark: 0x00 }],
    ["wrong last mark", { lastMark: 0x00 }],
    ["file count above the row count", { declaredFileCount: 4 }],
    ["index length below the rows", { declaredIndexLength: 10 }],
    ["declared name exceeds the row", { nameLength: 1024 }],
    ["zero-length declared name", { nameLength: 0 }],
  ])("rejects %s as a typed failure", async (_name, options) => {
    await withReader(buildWxapkg(members, options), async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({
        reason: expect.stringMatching(/^(format|limit)$/),
      });
    });
  });

  it("rejects a member offset into the header region", async () => {
    await withReader(
      buildWxapkg([{ path: "evil.bin", data: "x", offset: 4 }]),
      async (reader) => {
        await expect(list(reader)).rejects.toMatchObject({
          reason: "format",
        });
      },
    );
  });

  it("rejects a member extent beyond the file", async () => {
    await withReader(
      buildWxapkg([{ path: "evil.bin", data: "x", size: 1 << 20 }]),
      async (reader) => {
        await expect(list(reader)).rejects.toMatchObject({
          reason: "format",
        });
      },
    );
  });

  it("rejects a truncated package before the declared table ends", async () => {
    const bytes = buildWxapkg(members);
    await withReader(bytes.subarray(0, 30), async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "format" });
    });
  });

  it("rejects a non-UTF-8 member name as a typed format failure", async () => {
    const bytes = buildWxapkg(members);
    bytes[26] = 0xff; // first byte of the first member name
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "format" });
    });
  });

  it("rejects a forged foreign entry with an integrity failure", async () => {
    await withReader(buildWxapkg(members), async (reader) => {
      const [entry] = await list(reader);
      await expect(
        reader.open({ ...entry!, adapterKey: "wxapkg-entry:9" }),
      ).rejects.toMatchObject({ reason: "integrity" });
    });
  });
});

describe("WxapkgArtifactReader lifecycle", () => {
  it("aborts member reads when the caller cancels", async () => {
    const data = Buffer.alloc(300 * 1024, 0x62);
    await withReader(
      buildWxapkg([{ path: "big.bin", data }]),
      async (reader) => {
        const [entry] = await list(reader);
        const controller = new AbortController();
        const stream = await reader.open(entry!, controller.signal);
        let delivered = 0;
        await expect(
          (async () => {
            for await (const chunk of stream) {
              delivered += (chunk as Buffer).length;
              controller.abort();
            }
          })(),
        ).rejects.toThrow();
        expect(delivered).toBeLessThan(data.length);
      },
    );
  });

  it("survives a destroyed member stream and serves the next entry", async () => {
    await withReader(buildWxapkg(members), async (reader) => {
      const entries = await list(reader);
      const abandoned = await reader.open(entries[0]!);
      abandoned.destroy();
      await expect(text(await reader.open(entries[1]!))).resolves.toBe(
        "module.exports={};",
      );
    });
  });

  it("fails streams and later reads after close", async () => {
    const reader = new WxapkgArtifactReader(
      await writePackage(buildWxapkg(members)),
    );
    const entries: ArtifactEntry[] = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const stream = await reader.open(entries[0]!);
    const consumed = text(stream).catch((error: unknown) => error);
    await reader.close();
    expect(await consumed).toBeInstanceOf(Error);
    await expect(reader.open(entries[1]!)).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  it("bounds concurrent member streams", async () => {
    await withReader(buildWxapkg(members), async (reader) => {
      const [entry] = await list(reader);
      const streams = await Promise.all(
        [0, 1, 2, 3].map(() => reader.open(entry!)),
      );
      await expect(reader.open(entry!)).rejects.toMatchObject({
        reason: "limit",
      });
      for (const stream of streams) stream.destroy();
    });
  });
});
