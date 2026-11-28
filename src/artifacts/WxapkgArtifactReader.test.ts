import { buffer, text } from "node:stream/consumers";

import { describe, expect, it } from "vitest";

import { createTestTempFile } from "../../tests/fixtures/temporaryDirectory.js";
import {
  buildWxapkg,
  wxapkgEncryptedBytes,
  type WxapkgMember,
} from "../../tests/fixtures/wxapkg.js";

import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactTraversalOptions,
} from "../resources/ArtifactReader.js";
import { hasWxapkgHeader } from "../domain/wxapkgFormat.js";
import { WxapkgArtifactReader } from "./WxapkgArtifactReader.js";

const writePackage = (bytes: Buffer): Promise<string> =>
  createTestTempFile("rea-wxapkg-", "package.wxapkg", bytes);

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
        expect((await buffer(await reader.open(entry!))).equals(data)).toBe(
          true,
        );
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

  it("translates producer root prefixes while keeping declared names", async () => {
    await withReader(
      buildWxapkg([
        { path: "/app-config.json", data: "{}" },
        { path: "/pages/index/index.js", data: "x=1;" },
      ]),
      async (reader) => {
        const entries = await list(reader);
        expect(entries.map((entry) => entry.path)).toEqual([
          "app-config.json",
          "pages/index/index.js",
        ]);
        expect(entries[1]).toMatchObject({
          sourcePath: "/pages/index/index.js",
          formatMetadata: { source_path: "/pages/index/index.js" },
        });
        expect(await text(await reader.open(entries[0]!))).toBe("{}");
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
        info: null,
      });
    });
  });

  it("reports cancellation during encrypted-directory coverage", async () => {
    await withReader(wxapkgEncryptedBytes(), async (reader) => {
      const controller = new AbortController();
      const entries = reader
        .entries(controller.signal, {
          onCoverage: () => controller.abort(),
        })
        [Symbol.asyncIterator]();
      await expect(entries.next()).rejects.toMatchObject({
        reason: "cancelled",
      });
    });
  });
});

describe("WxapkgArtifactReader coverage", () => {
  const coverageOf = (bytes: Buffer) =>
    withReader(bytes, async (reader) => {
      let observed: { status: string; limitations: readonly string[] } = {
        status: "none",
        limitations: [],
      };
      await list(reader, {
        onCoverage: ({ status, limitations }) => {
          observed = { status, limitations: [...limitations] };
        },
      });
      return observed;
    });
  const unaccounted = (bytes: number, ranges: number, first: number) =>
    `${String(bytes)} byte(s) in ${String(ranges)} range(s), the first at offset ${String(first)}, lie outside the member table and every member and were not exposed as entries.`;

  it("is complete when members tile the data region, including aliases", async () => {
    for (const bytes of [
      buildWxapkg(members),
      buildWxapkg(
        [
          { path: "a.js", data: "AAAA" },
          { path: "b.js", data: "AA" },
        ],
        { aliasOffsets: true },
      ),
    ])
      expect(await coverageOf(bytes)).toEqual({
        status: "complete",
        limitations: [],
      });
  });

  it("stays unknown when bytes follow the last member", async () => {
    const plain = buildWxapkg(members);
    expect(
      await coverageOf(Buffer.concat([plain, Buffer.from("appended")])),
    ).toEqual({
      status: "unknown",
      limitations: [unaccounted(8, 1, plain.length)],
    });
  });

  it("finds a gap between members listed out of byte order", async () => {
    // Rows for "b" then "a" end at offset 44. "a" holds 44-47, three
    // unaccounted bytes follow, then "b" holds 51-52.
    const row = (name: string, offset: number, size: number): Buffer => {
      const bytes = Buffer.alloc(12 + name.length);
      bytes.writeUInt32BE(name.length, 0);
      bytes.write(name, 4, "utf8");
      bytes.writeUInt32BE(offset, 4 + name.length);
      bytes.writeUInt32BE(size, 8 + name.length);
      return bytes;
    };
    const header = Buffer.alloc(18);
    header[0] = 0xbe;
    header.writeUInt32BE(26, 5);
    header.writeUInt32BE(9, 9);
    header[13] = 0xed;
    header.writeUInt32BE(2, 14);
    const bytes = Buffer.concat([
      header,
      row("b", 51, 2),
      row("a", 44, 4),
      Buffer.from("AAAA---BB"),
    ]);
    await withReader(bytes, async (reader) => {
      const entries = await list(reader);
      expect(entries.map(({ path, byteOffset }) => [path, byteOffset])).toEqual(
        [
          ["b", 51],
          ["a", 44],
        ],
      );
    });
    expect(await coverageOf(bytes)).toEqual({
      status: "unknown",
      limitations: [unaccounted(3, 1, 48)],
    });
  });

  it("counts unused index bytes and trailing bytes as separate ranges", async () => {
    // One 13-byte row ends at offset 31; eight unused index bytes follow it.
    const padded = buildWxapkg([{ path: "a", data: "Z" }], {
      tablePadding: 8,
    });
    expect(await coverageOf(padded)).toEqual({
      status: "unknown",
      limitations: [unaccounted(8, 1, 31)],
    });
    expect(
      await coverageOf(Buffer.concat([padded, Buffer.alloc(4, 0xee)])),
    ).toEqual({
      status: "unknown",
      limitations: [unaccounted(12, 2, 31)],
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
  ])("rejects %s as a typed failure", async (name, options) => {
    await withReader(buildWxapkg(members, options), async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({
        // Rows past the declared table end before their structure.
        reason:
          name === "file count above the row count" ? "truncated" : "malformed",
      });
    });
  });

  it("rejects a member offset into the header region", async () => {
    await withReader(
      buildWxapkg([{ path: "evil.bin", data: "x", offset: 4 }]),
      async (reader) => {
        await expect(list(reader)).rejects.toMatchObject({
          reason: "malformed",
        });
      },
    );
  });

  it("rejects a member extent beyond the file", async () => {
    await withReader(
      buildWxapkg([{ path: "evil.bin", data: "x", size: 1 << 20 }]),
      async (reader) => {
        await expect(list(reader)).rejects.toMatchObject({
          reason: "truncated",
        });
      },
    );
  });

  it("rejects a member offset into the index region", async () => {
    // Offset 18 is inside the declared table, not the data region.
    await withReader(
      buildWxapkg([{ path: "evil.bin", data: "x", offset: 18, size: 1 }]),
      async (reader) => {
        await expect(list(reader)).rejects.toMatchObject({
          reason: "malformed",
        });
      },
    );
  });
});

describe("WxapkgArtifactReader data region", () => {
  it("rejects a member range that covers unused index bytes", async () => {
    const bytes = buildWxapkg([{ path: "a", data: "Z" }], {
      tablePadding: 8,
    });
    // The row ends at byte 31; the next eight bytes are still the index.
    bytes.writeUInt32BE(31, 23);
    bytes.writeUInt32BE(1, 27);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("reads member bytes that follow unused index bytes", async () => {
    await withReader(
      buildWxapkg([{ path: "a", data: "Z" }], { tablePadding: 8 }),
      async (reader) => {
        const [entry] = await list(reader);
        expect(entry).toMatchObject({ byteOffset: 39, declaredSize: 1 });
        expect(await text(await reader.open(entry!))).toBe("Z");
      },
    );
  });

  it("rejects a member extent beyond the declared data region", async () => {
    await withReader(
      buildWxapkg([{ path: "x", data: "0123456789" }], {
        declaredDataLength: 5,
      }),
      async (reader) => {
        await expect(list(reader)).rejects.toMatchObject({
          reason: "malformed",
        });
      },
    );
  });

  it("rejects member extents that require different index-length conventions", async () => {
    // The rows end at 44. Counting the member count in the index length places
    // data at [44, 48). Counting only rows places it at [48, 52).
    const bytes = buildWxapkg(
      [
        { path: "a", data: "AAAA", offset: 44 },
        { path: "b", data: "BBBB", offset: 48 },
      ],
      { indexLengthIncludesFileCount: true, declaredDataLength: 4 },
    );
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({
        reason: "malformed",
        message:
          "wxapkg is malformed: no single declared data region contains all member extents",
      });
    });
  });

  it("rejects a data region declared past the file", async () => {
    await withReader(
      buildWxapkg([{ path: "x", data: "ok" }], {
        declaredDataLength: 1 << 24,
      }),
      async (reader) => {
        await expect(list(reader)).rejects.toMatchObject({
          reason: "truncated",
        });
      },
    );
  });
});

describe("WxapkgArtifactReader index length", () => {
  it("reads a one-byte member when indexLength counts only the rows", async () => {
    const bytes = buildWxapkg([{ path: "a", data: "Z" }]);
    expect(bytes).toHaveLength(32);
    expect(bytes.readUInt32BE(5)).toBe(13);
    await withReader(bytes, async (reader) => {
      const [entry] = await list(reader);
      expect(entry).toMatchObject({ byteOffset: 31, declaredSize: 1 });
      expect(reader.formatMetadata()).toMatchObject({
        index_length: 13,
        data_length: 1,
        file_count: 1,
      });
      expect(await text(await reader.open(entry!))).toBe("Z");
    });
  });

  it("reads a one-byte member when indexLength includes the member count", async () => {
    const bytes = buildWxapkg([{ path: "a", data: "Z" }], {
      indexLengthIncludesFileCount: true,
    });
    expect(bytes).toHaveLength(32);
    expect(bytes.readUInt32BE(5)).toBe(17);
    await withReader(bytes, async (reader) => {
      const [entry] = await list(reader);
      expect(entry).toMatchObject({
        path: "a",
        byteOffset: 31,
        declaredSize: 1,
      });
      expect(reader.formatMetadata()).toMatchObject({
        index_length: 17,
        data_length: 1,
        file_count: 1,
      });
      expect(await text(await reader.open(entry!))).toBe("Z");
    });
  });

  it("reads a count-inclusive member when exactly four bytes trail the package", async () => {
    const bytes = Buffer.concat([
      buildWxapkg([{ path: "a", data: "Z" }], {
        indexLengthIncludesFileCount: true,
      }),
      Buffer.alloc(4, 0xee),
    ]);
    expect(bytes).toHaveLength(36);
    await withReader(bytes, async (reader) => {
      const [entry] = await list(reader);
      expect(entry).toMatchObject({ byteOffset: 31, declaredSize: 1 });
      expect(await text(await reader.open(entry!))).toBe("Z");
    });
  });

  it("rejects a count-inclusive member that covers trailing bytes", async () => {
    const bytes = Buffer.concat([
      buildWxapkg([{ path: "a", data: "Z" }], {
        indexLengthIncludesFileCount: true,
      }),
      Buffer.alloc(4, 0xee),
    ]);
    bytes.writeUInt32BE(5, 27);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("keeps a count-inclusive member inside the data region when bytes trail the package", async () => {
    const bytes = Buffer.concat([
      buildWxapkg([{ path: "a", data: "Z" }], {
        indexLengthIncludesFileCount: true,
      }),
      Buffer.alloc(8, 0xee),
    ]);
    await withReader(bytes, async (reader) => {
      const [entry] = await list(reader);
      expect(entry).toMatchObject({ byteOffset: 31, declaredSize: 1 });
      expect(await text(await reader.open(entry!))).toBe("Z");
    });
  });

  it("rejects an index byte of a count-inclusive package", async () => {
    await withReader(
      buildWxapkg([{ path: "a", data: "Z", offset: 18, size: 1 }], {
        indexLengthIncludesFileCount: true,
      }),
      async (reader) => {
        await expect(list(reader)).rejects.toMatchObject({
          reason: "malformed",
        });
      },
    );
  });
});

describe("WxapkgArtifactReader damaged packages", () => {
  it("keeps a damaged package's format identity as a typed failure", async () => {
    // Marks hold but the declared count cannot fit the declared table.
    const bytes = buildWxapkg(members, {
      declaredFileCount: 2,
      declaredIndexLength: 12,
    });
    expect(hasWxapkgHeader(bytes)).toBe(true);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("rejects a truncated package before the declared table ends", async () => {
    const bytes = buildWxapkg(members);
    await withReader(bytes.subarray(0, 30), async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "truncated" });
    });
  });

  it("rejects a non-UTF-8 member name as a typed format failure", async () => {
    const bytes = buildWxapkg(members);
    bytes[26] = 0xff; // first byte of the first member name
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
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
        const reason = { caller: "after first wxapkg chunk" };
        const stream = await reader.open(entry!, controller.signal);
        let delivered = 0;
        const failure = await (async () => {
          for await (const chunk of stream) {
            delivered += (chunk as Buffer).length;
            controller.abort(reason);
          }
        })().catch((cause: unknown) => cause);
        expect(failure).toBeInstanceOf(ArtifactReaderFailure);
        expect(failure).toMatchObject({ reason: "cancelled" });
        if (!(failure instanceof ArtifactReaderFailure)) throw failure;
        expect(failure.cause).toBe(reason);
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
});
