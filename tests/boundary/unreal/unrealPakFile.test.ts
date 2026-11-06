import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  readUnrealPak,
  UnrealPakFormatFailure,
  type UnrealPakLimits,
  YIELD_EVERY,
} from "../../../src/unreal/UnrealPakFile.js";
import {
  createPakFixture,
  PAK_FIXTURE_FILES,
  type PakFixtureLayout,
} from "../../fixtures/unreal/pak.js";

const LIMITS: UnrealPakLimits = {
  regionBytes: 1 << 20,
  entries: 1000,
  pathChars: 1 << 20,
};

const sourceOf = (bytes: Buffer) => ({
  size: bytes.length,
  read: async (offset: number, length: number) =>
    bytes.subarray(offset, offset + length),
});

const read = (bytes: Buffer, limits: UnrealPakLimits = LIMITS) =>
  readUnrealPak(sourceOf(bytes), limits);

const failure = async (bytes: Buffer, limits: UnrealPakLimits = LIMITS) => {
  try {
    await read(bytes, limits);
  } catch (cause) {
    if (cause instanceof UnrealPakFormatFailure)
      return { reason: cause.reason, kind: cause.kind };
    throw cause;
  }
  throw new Error("expected a pak failure");
};

describe("Unreal pak footers and indexes", () => {
  it.each([
    "v1",
    "v3",
    "v4",
    "v7",
    "v8a",
    "v8b",
    "v9",
    "v10",
    "v11",
    "v12",
  ] as const satisfies readonly PakFixtureLayout[])(
    "reads every %s entry with its placement and compression",
    async (layout) => {
      const { bytes, files, indexOffset, indexSize } = createPakFixture({
        layout,
      });
      const pak = await read(bytes);
      expect(pak.footer).toMatchObject({
        layout,
        index: { offset: indexOffset, size: indexSize },
      });
      expect(pak.index).toMatchObject({
        state: "decoded",
        mount_point: "../../../",
        entry_count: files.length,
      });
      expect(
        pak.entries.map((entry) => [
          entry.path,
          entry.offset,
          entry.size,
          entry.uncompressed_size,
          entry.compression_name,
        ]),
      ).toEqual(
        files.map((file) => [
          file.path,
          file.offset,
          file.stored,
          file.uncompressed,
          file.method === 0 ? null : "Zlib",
        ]),
      );
      const version = Number(layout.replace(/[ab]$/u, "").slice(1));
      expect(
        pak.entries.every(
          (entry) => entry.record === (version >= 10 ? "encoded" : "full"),
        ),
      ).toBe(true);
      // Every redundant fact agrees in a well-formed pak.
      expect(pak.issues).toEqual([]);
    },
  );

  it.each(["v8b", "v11"] as const)(
    "reports %s block counts, flags and record hashes",
    async (layout) => {
      const pak = await read(
        createPakFixture({
          layout,
          files: [
            { path: "A/multi", size: 30, compressed: true, blocks: 3 },
            { path: "A/sealed", size: 20, compressed: true, encrypted: true },
            { path: "A/gone", size: 4, fullRecord: true, deleted: true },
          ],
        }).bytes,
      );
      expect(
        pak.entries.map((entry) => [
          entry.path,
          entry.compression_blocks,
          entry.compression_block_size,
          entry.encrypted,
          entry.deleted,
          entry.sha1,
        ]),
      ).toEqual([
        [
          "A/multi",
          3,
          65536,
          false,
          false,
          layout === "v8b" ? "00".repeat(20) : null,
        ],
        [
          "A/sealed",
          1,
          65536,
          true,
          false,
          layout === "v8b" ? "01".repeat(20) : null,
        ],
        ["A/gone", 0, 0, false, true, "02".repeat(20)],
      ]);
    },
  );

  it("reads version 12 file names as UTF-8 without a terminator", async () => {
    const pak = await read(createPakFixture({ layout: "v12" }).bytes);
    expect(pak.entries.map((entry) => entry.path)).toContain(
      "Game/Content/한글.txt",
    );
  });

  it("resolves negative references to the non-encoded full records", async () => {
    const pak = await read(
      createPakFixture({
        layout: "v11",
        files: [
          { path: "A/b.txt", size: 9, fullRecord: true },
          { path: "A/c.txt", size: 5 },
        ],
      }).bytes,
    );
    expect(
      pak.entries.map((entry) => [entry.path, entry.record, entry.size]),
    ).toEqual([
      ["A/b.txt", "full", 9],
      ["A/c.txt", "encoded", 5],
    ]);
  });

  it("names entries by path hash when no full directory index exists", async () => {
    const pak = await read(
      createPakFixture({ layout: "v11", directoryIndex: false }).bytes,
    );
    expect(pak.index).toMatchObject({ full_directory_index: null });
    expect(pak.entries).toHaveLength(PAK_FIXTURE_FILES.length);
    expect(
      pak.entries.every(
        (entry) => entry.path === null && entry.path_hash !== null,
      ),
    ).toBe(true);
  });

  it("reports an encrypted index from the footer without reading it", async () => {
    const pak = await read(
      createPakFixture({ layout: "v11", encryptedIndex: true }).bytes,
    );
    expect(pak).toMatchObject({
      footer: { index_encrypted: true },
      index: { state: "encrypted" },
      entries: [],
    });
  });
});

describe("rejected Unreal pak files", () => {
  const valid = () => createPakFixture({ layout: "v11" });

  it("refuses an unrecognized footer", async () => {
    expect(await failure(Buffer.alloc(300))).toEqual({
      reason: "unrecognized-footer",
      kind: "unsupported",
    });
  });

  it("refuses a version 9 frozen index", async () => {
    expect(
      await failure(
        createPakFixture({ layout: "v9", frozenIndex: true }).bytes,
      ),
    ).toEqual({
      reason: "frozen-index",
      kind: "unsupported",
    });
  });

  it("rejects an index region that leaves the file", async () => {
    const { bytes } = valid();
    // Footer index size sits 4 + 8 bytes past the magic, before the SHA-1.
    const magic = bytes.lastIndexOf(Buffer.from([0xe1, 0x12, 0x6f, 0x5a]));
    bytes.writeBigUInt64LE(BigInt(bytes.length), magic + 16);
    expect(await failure(bytes)).toEqual({
      reason: "region-out-of-bounds",
      kind: "corrupt",
    });
  });

  it("rejects an index cut short", async () => {
    const { bytes, indexSize } = valid();
    const magic = bytes.lastIndexOf(Buffer.from([0xe1, 0x12, 0x6f, 0x5a]));
    bytes.writeBigUInt64LE(BigInt(indexSize - 6), magic + 16);
    expect((await failure(bytes)).kind).toBe("corrupt");
  });

  it.each(["v8b", "v11"] as const)(
    "keeps both %s entries of a duplicated path and records the second",
    async (layout) => {
      const pak = await read(
        createPakFixture({
          layout,
          files: [
            { path: "A/x", size: 1 },
            { path: "A/x", size: 2 },
          ],
        }).bytes,
      );
      expect(pak.entries.map((entry) => [entry.path, entry.size])).toEqual([
        ["A/x", 1],
        ["A/x", 2],
      ]);
      if (pak.index.state !== "decoded") throw new Error("expected an index");
      expect(pak.index.entry_count).toBe(2);
      const duplicates = pak.issues.filter(
        (issue) => issue.kind === "duplicate-path",
      );
      // v11 repeats the path in the full directory index and its hash in
      // the path hash index; each is recorded where the repeat sits.
      const regions =
        pak.index.state === "decoded" && layout === "v11"
          ? [
              pak.index.path_hash_index!.region,
              pak.index.full_directory_index!.region,
            ]
          : [pak.footer.index];
      expect(duplicates).toHaveLength(regions.length);
      regions.forEach((region, at) => {
        const issue = duplicates[at]!;
        expect(issue.offset).toBeGreaterThan(region.offset);
        expect(issue.offset).toBeLessThan(region.offset + region.size);
      });
      expect(duplicates.at(-1)!.message).toContain("A/x");
    },
  );

  it("refuses an index region above the limit before reading it", async () => {
    expect(
      await failure(valid().bytes, { ...LIMITS, regionBytes: 16 }),
    ).toEqual({ reason: "region-too-large", kind: "resource" });
  });

  it("refuses more entries than the limit before building them", async () => {
    expect(await failure(valid().bytes, { ...LIMITS, entries: 2 })).toEqual({
      reason: "too-many-entries",
      kind: "resource",
    });
  });

  it("lets the caller refuse an entry count before entries are built", async () => {
    const seen: number[] = [];
    await expect(
      read(valid().bytes, {
        ...LIMITS,
        beforeEntries: (count) => {
          seen.push(count);
          throw new Error("refused");
        },
      }),
    ).rejects.toThrow("refused");
    expect(seen).toEqual([PAK_FIXTURE_FILES.length]);
  });
});

describe("inconsistent Unreal pak indexes", () => {
  it("nulls a header entry count the listings contradict and keeps the entries", async () => {
    const { bytes, files, indexOffset } = createPakFixture({
      layout: "v11",
      declaredEntries: 5,
    });
    const pak = await read(bytes);
    if (pak.index.state !== "decoded") throw new Error("expected an index");
    expect(pak.index.entry_count).toBeNull();
    expect(pak.entries.map((entry) => entry.path)).toEqual(
      files.map((file) => file.path),
    );
    const mismatches = pak.issues.filter(
      (issue) => issue.kind === "entry-count-mismatch",
    );
    // One issue at the header count, naming both disagreeing listings.
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.offset).toBeGreaterThan(indexOffset);
    expect(mismatches[0]!.message).toContain("declares 5 entries");
  });

  it.each(["pathHashTrailer", "directoryTrailer"] as const)(
    "rejects bytes left over after the listing (%s)",
    async (option) => {
      expect(
        await failure(
          createPakFixture({ layout: "v11", [option]: Buffer.of(1, 2, 3, 4) })
            .bytes,
        ),
      ).toEqual({ reason: "index-trailing-bytes", kind: "corrupt" });
    },
  );

  it("rejects a version 10+ reference past the encoded entries", async () => {
    expect(
      await failure(
        createPakFixture({ layout: "v11", firstReference: 4096 }).bytes,
      ),
    ).toEqual({ reason: "entry-reference-out-of-range", kind: "corrupt" });
  });

  it("rejects a NUL inside a version 12 file name", async () => {
    const bytes = createPakFixture({
      layout: "v12",
      files: [{ path: "A/a\0b", size: 1 }],
    }).bytes;
    expect(await failure(bytes)).toEqual({
      reason: "invalid-string",
      kind: "corrupt",
    });
  });

  it.each(["v8b", "v11"] as const)(
    "rejects a NUL inside a %s FString path",
    async (layout) => {
      const bytes = createPakFixture({
        layout,
        files: [{ path: "A/a\0b", size: 1 }],
      }).bytes;
      expect(await failure(bytes)).toEqual({
        reason: "invalid-string",
        kind: "corrupt",
      });
    },
  );

  it("skips a version 1 timestamp above the safe integer range", async () => {
    // 2024-01-01 as FDateTime ticks (100 ns since 0001-01-01), about 6.4e17.
    const timestamp = 638_396_640_000_000_000n;
    const plain = await read(createPakFixture({ layout: "v1" }).bytes);
    const pak = await read(createPakFixture({ layout: "v1", timestamp }).bytes);
    expect(timestamp).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(pak.entries).toEqual(plain.entries);
    expect(pak.issues).toEqual([]);
  });

  it("nulls the compression name of an entry naming an empty slot", async () => {
    const { bytes } = createPakFixture({ layout: "v11" });
    // The five 32-byte compression names end the footer; clear slot 1 (Zlib).
    bytes.fill(0, bytes.length - 160, bytes.length - 128);
    const pak = await read(bytes);
    const compressed = pak.entries.filter(
      (entry) => entry.compression_method === 1,
    );
    expect(compressed).toHaveLength(1);
    expect(compressed[0]!.compression_name).toBeNull();
    // Stored entries are untouched by the empty slot.
    expect(
      pak.entries.filter((entry) => entry.compression_method === 0),
    ).toHaveLength(2);
    // Resolved through two listings, the record is reported once.
    expect(pak.issues).toEqual([
      {
        kind: "unknown-compression-slot",
        offset: expect.any(Number),
        message: expect.stringContaining("slot 1"),
      },
    ]);
  });

  it.each(["index", "path hash index", "full directory index"] as const)(
    "records a %s whose bytes do not match its recorded SHA-1 and keeps decoding",
    async (region) => {
      const { bytes } = createPakFixture({ layout: "v11" });
      const clean = await read(Buffer.from(bytes));
      if (clean.index.state !== "decoded") throw new Error("expected an index");
      const recorded =
        region === "index"
          ? clean.footer.index
          : region === "path hash index"
            ? clean.index.path_hash_index!.region
            : clean.index.full_directory_index!.region;
      // Corrupt the recorded hash, not the bytes, so the structure stays readable.
      const at = bytes.lastIndexOf(Buffer.from(recorded.sha1, "hex"));
      bytes[at]! ^= 0xff;
      const pak = await read(bytes);
      expect(pak.entries).toEqual(clean.entries);
      expect(pak.issues).toContainEqual({
        kind: "region-hash-mismatch",
        offset: recorded.offset,
        message: expect.stringContaining(region),
      });
      // A hash stored inside the index also changes the index bytes.
      expect(pak.issues).toHaveLength(region === "index" ? 1 : 2);
    },
  );

  it.each(["v8b", "v11"] as const)(
    "rejects a %s entry that ends past the data area",
    async (layout) => {
      expect(
        await failure(
          createPakFixture({ layout, lastOffsetShift: 1 << 20 }).bytes,
        ),
      ).toEqual({ reason: "entry-out-of-bounds", kind: "corrupt" });
    },
  );

  it.each(["v8b", "v11"] as const)(
    "refuses %s paths whose total length exceeds the limit before building them",
    async (layout) => {
      expect(
        await failure(createPakFixture({ layout }).bytes, {
          ...LIMITS,
          pathChars: 40,
        }),
      ).toEqual({ reason: "paths-too-large", kind: "resource" });
    },
  );
});

describe("Unreal pak record and resource guards", () => {
  /** Change index bytes, then rewrite the footer's index SHA-1 so the edit reaches the decoder. */
  const editIndex = (layout: PakFixtureLayout, at: number, edit: Buffer) => {
    const { bytes, indexOffset, indexSize } = createPakFixture({ layout });
    edit.copy(bytes, indexOffset + at);
    const magic = bytes.lastIndexOf(Buffer.from([0xe1, 0x12, 0x6f, 0x5a]));
    createHash("sha1")
      .update(bytes.subarray(indexOffset, indexOffset + indexSize))
      .digest()
      .copy(bytes, magic + 24);
    return bytes;
  };

  it("rejects a string that runs past its region", async () => {
    // The mount point's FString length is the first index field.
    const length = Buffer.alloc(4);
    length.writeInt32LE(0x7fff);
    expect(await failure(editIndex("v8b", 0, length))).toEqual({
      reason: "truncated-record",
      kind: "corrupt",
    });
  });

  it("rejects a version 10+ index flag that is neither 0 nor 1", async () => {
    // Mount point (4 + 10 bytes), entry count (4) and path hash seed (8) precede the flag.
    expect(await failure(editIndex("v11", 26, Buffer.of(2, 0, 0, 0)))).toEqual({
      reason: "invalid-flag",
      kind: "corrupt",
    });
  });

  it("rejects a version 10+ reference into the middle of an encoded entry", async () => {
    expect(
      await failure(
        createPakFixture({ layout: "v11", firstReference: 2 }).bytes,
      ),
    ).toEqual({ reason: "entry-reference-out-of-range", kind: "corrupt" });
  });

  it("rejects an encrypted index region that leaves the file without reading it", async () => {
    const { bytes } = createPakFixture({ layout: "v11", encryptedIndex: true });
    const magic = bytes.lastIndexOf(Buffer.from([0xe1, 0x12, 0x6f, 0x5a]));
    bytes.writeBigUInt64LE(BigInt(bytes.length), magic + 8);
    expect(await failure(bytes)).toEqual({
      reason: "region-out-of-bounds",
      kind: "corrupt",
    });
  });

  it("does not charge directories to the entry-row hook", async () => {
    const pak = await read(
      createPakFixture({ layout: "v11", emptyDirectories: 10 }).bytes,
      {
        ...LIMITS,
        beforeEntries: (count) => {
          if (count > PAK_FIXTURE_FILES.length)
            throw new Error(`charged ${count}`);
        },
      },
    );
    expect(pak.index).toMatchObject({
      full_directory_index: { directories: 13 },
    });
  });

  it("pauses between empty directories so cancellation is observed", async () => {
    let pauses = 0;
    await expect(
      read(
        createPakFixture({ layout: "v11", emptyDirectories: YIELD_EVERY * 2 })
          .bytes,
        {
          ...LIMITS,
          entries: YIELD_EVERY * 4,
          regionBytes: 64 << 20,
          pause: async () => {
            pauses++;
            throw new Error("cancelled");
          },
        },
      ),
    ).rejects.toThrow("cancelled");
    expect(pauses).toBe(1);
  });

  it("refuses more encoded records than the entry limit even when unreferenced", async () => {
    const files = Array.from({ length: 5 }, (_, at) => ({
      path: `D/${at}`,
      size: 0,
    }));
    expect(
      await failure(
        createPakFixture({
          layout: "v11",
          files,
          declaredEntries: 1,
          pathHashIndex: false,
          directoryIndex: false,
        }).bytes,
        {
          ...LIMITS,
          entries: 4,
        },
      ),
    ).toEqual({ reason: "too-many-entries", kind: "resource" });
  });

  it("rejects a path-hash row naming a misplaced record the directory index does not list", async () => {
    expect(
      await failure(
        createPakFixture({ layout: "v11", strayHashOffset: 1 << 20 }).bytes,
      ),
    ).toEqual({ reason: "entry-out-of-bounds", kind: "corrupt" });
  });

  it("counts the mount point against the path budget", async () => {
    expect(
      await failure(
        createPakFixture({
          layout: "v11",
          files: [],
          mountPoint: "M".repeat(64),
        }).bytes,
        { ...LIMITS, pathChars: 32 },
      ),
    ).toEqual({ reason: "paths-too-large", kind: "resource" });
  });

  it("lists a large path-hash-only index", async () => {
    const files = Array.from({ length: 200_000 }, (_, at) => ({
      path: `D/${at}`,
      size: 0,
    }));
    const pak = await read(
      createPakFixture({ layout: "v11", files, directoryIndex: false }).bytes,
      { ...LIMITS, entries: 300_000, regionBytes: 64 << 20 },
    );
    expect(pak.entries).toHaveLength(200_000);
  }, 60_000);

  it("reads the pruned directory index stored after the path hashes", async () => {
    const pak = await read(createPakFixture({ layout: "v11" }).bytes);
    expect(pak.index).toMatchObject({
      path_hash_index: { entries: 3, pruned_directories: 0, pruned_files: 0 },
    });
  });
});

describe("Unreal pak listings checked against each other", () => {
  it.each(["v11", "v12"] as const)(
    "accepts %s path hashes computed the way FPakFile::HashPath does",
    async (layout) => {
      const pak = await read(createPakFixture({ layout }).bytes);
      expect(pak.issues).toEqual([]);
      expect(pak.entries.map((entry) => entry.path)).toEqual(
        PAK_FIXTURE_FILES.map((file) => file.path),
      );
    },
  );

  it("leaves version 10 path hashes unchecked", async () => {
    const pak = await read(
      createPakFixture({ layout: "v10", mismatchedPathHash: true }).bytes,
    );
    expect(pak.issues).toEqual([]);
    expect(pak.entries.map((entry) => entry.path)).toEqual(
      PAK_FIXTURE_FILES.map((file) => file.path),
    );
  });

  it("does not invent a path from a directory name without its closing slash", async () => {
    const pak = await read(
      createPakFixture({ layout: "v11", unslashedDirectories: true }).bytes,
    );
    expect(pak.entries.map((entry) => entry.path)).toEqual([null, null, null]);
    expect(pak.issues.map((issue) => issue.kind)).toContain(
      "malformed-directory-name",
    );
  });

  it("nulls a directory-index path whose hash the path hash index does not hold", async () => {
    const pak = await read(
      createPakFixture({ layout: "v11", mismatchedPathHash: true }).bytes,
    );
    expect(pak.entries.map((entry) => entry.path)).toEqual([
      null,
      ...PAK_FIXTURE_FILES.slice(1).map((file) => file.path),
    ]);
    expect(pak.issues).toEqual([
      {
        kind: "path-hash-mismatch",
        offset: expect.any(Number),
        message: expect.stringContaining(PAK_FIXTURE_FILES[0]!.path),
      },
    ]);
  });

  it("nulls a directory path whose repeated hash names other records", async () => {
    const pak = await read(
      createPakFixture({
        layout: "v11",
        files: [
          { path: "A/x", size: 1 },
          { path: "A/x", size: 2 },
          { path: "B/y", size: 3 },
        ],
        directoryReference: { at: 1, from: 2 },
      }).bytes,
    );
    expect(pak.entries.map((entry) => [entry.path, entry.size])).toEqual([
      ["A/x", 1],
      [null, 3],
      ["B/y", 3],
    ]);
    const mismatches = pak.issues.filter(
      (issue) => issue.kind === "path-hash-mismatch",
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.message).toContain("entries");
  });

  it("prices only listed records as entry rows, not unreferenced full records", async () => {
    const seen: number[] = [];
    await read(createPakFixture({ layout: "v11" }).bytes, {
      ...LIMITS,
      beforeEntries: (count) => {
        seen.push(count);
      },
    });
    // The fixture writes no full records; their count of zero must not be
    // offered as rows, so only listing counts reach the caller.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain(0);
  });

  it("reports no compression slot issue for records no listing references", async () => {
    const { bytes } = createPakFixture({
      layout: "v11",
      files: [],
      declaredEntries: 0,
      unreferencedRecords: 50_000,
    });
    // Clear slot 1 (Zlib), which every unreferenced record names.
    bytes.fill(0, bytes.length - 160, bytes.length - 128);
    const pak = await read(bytes, { ...LIMITS, entries: 100_000 });
    expect(pak.entries).toEqual([]);
    expect(pak.issues).toEqual([]);
  }, 60_000);

  it("bounds the index regions held at once by one shared byte budget", async () => {
    const { bytes, indexSize } = createPakFixture({ layout: "v11" });
    const clean = await read(Buffer.from(bytes));
    if (clean.index.state !== "decoded") throw new Error("expected an index");
    const largest = Math.max(
      indexSize,
      clean.index.path_hash_index!.region.size,
      clean.index.full_directory_index!.region.size,
    );
    // Every region fits alone, but the three together do not.
    expect(await failure(bytes, { ...LIMITS, regionBytes: largest })).toEqual({
      reason: "region-too-large",
      kind: "resource",
    });
  });
});

describe("Unreal pak issue budget", () => {
  it("charges each issue to the issue hook before keeping it", async () => {
    const seen: number[] = [];
    await expect(
      read(
        createPakFixture({
          layout: "v11",
          emptyDirectories: 100,
          unslashedDirectories: true,
        }).bytes,
        {
          ...LIMITS,
          beforeIssues: (bytes) => {
            seen.push(bytes);
            if (seen.length === 5) throw new Error("refused");
          },
        },
      ),
    ).rejects.toThrow("refused");
    // Empty malformed directories produce no rows, but their issues are charged.
    expect(seen).toHaveLength(5);
    expect(seen.every((bytes, at) => at === 0 || bytes > seen[at - 1]!)).toBe(
      true,
    );
  });
  it("quotes a bounded prefix of a long malformed directory name", async () => {
    const name = `/${"\u0001".repeat(100_000)}`;
    const pak = await read(
      createPakFixture({
        layout: "v11",
        emptyDirectories: 1,
        emptyDirectoryName: name,
        unslashedDirectories: true,
      }).bytes,
      { ...LIMITS, regionBytes: 64 << 20 },
    );
    const issue = pak.issues.find(
      (entry) =>
        entry.kind === "malformed-directory-name" &&
        entry.message.includes("100002 UTF-16 units"),
    );
    expect(issue?.message.length).toBeLessThan(400);
  });
});

describe("Unreal pak path allowance", () => {
  it("does not charge paths it cannot build against the returned path limit", async () => {
    const bytes = createPakFixture({
      layout: "v11",
      unslashedDirectories: true,
    }).bytes;
    // Only the mount point fits; the unjoined directory and file names do not.
    const pak = await read(bytes, { ...LIMITS, pathChars: 16 });
    expect(pak.entries.map((entry) => entry.path)).toEqual([null, null, null]);
  });

  it("does not charge pruned listing paths against the returned path limit", async () => {
    const plain = createPakFixture({ layout: "v11" }).bytes;
    const pruned = createPakFixture({
      layout: "v11",
      prunedListing: true,
    }).bytes;
    // The smallest limit that admits the returned paths alone.
    let pathChars = 1;
    while (
      (await failure(plain, { ...LIMITS, pathChars }).catch(() => null)) !==
      null
    )
      pathChars++;
    const report = await read(pruned, { ...LIMITS, pathChars });
    expect(
      report.index.state === "decoded" &&
        report.index.path_hash_index?.pruned_files,
    ).toBe(report.entries.length);
  });
});
