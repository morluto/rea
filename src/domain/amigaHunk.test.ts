import { expect, it } from "vitest";

import {
  AMIGA_HUNK_HUNK_LIMIT,
  AMIGA_HUNK_RELOCATION_LIMIT,
  AMIGA_HUNK_RELOCATION_RECORD_LIMIT,
  AMIGA_HUNK_SYMBOL_LIMIT,
  HUNKF_ADVISORY,
  HUNKF_CHIP,
  HUNK_EXT,
  hasAmigaHunkMagic,
  parseAmigaHunk,
  amigaHunkMetadata,
} from "./amigaHunk.js";
import { amigaHunkMetadataSchema } from "./formatMetadata/packageAndGameMetadata.js";
import { ParseFailureError } from "./parseFailure.js";
import { amigaLoadFile, amigaObjectFile } from "./amigaHunk.fixture.js";

const CODE = Buffer.from([0x4e, 0x75, 0x00, 0x00]);
const DATA = Buffer.from([0x11, 0x22, 0x33, 0x44]);

const limitOf = (parse: () => unknown): ParseFailureError => {
  try {
    parse();
  } catch (cause) {
    if (cause instanceof ParseFailureError) return cause;
    throw cause;
  }
  throw new Error("parse returned");
};

const decodeLimitOf = (parse: () => unknown) => {
  const error = limitOf(parse);
  if (error.failure.kind !== "limit")
    throw new Error(`expected a limit, received ${error.kind}`);
  return error.failure;
};

it("recognizes load and object files from header structure", () => {
  const load = amigaLoadFile({
    libraries: ["dos.library"],
    hunks: [{ type: "code", bytes: CODE }],
  });
  expect(hasAmigaHunkMagic(load)).toBe(true);
  const object = amigaObjectFile([{ name: "obj.o", hunks: [] }]);
  expect(hasAmigaHunkMagic(object, object.length)).toBe(true);
  expect(hasAmigaHunkMagic(Buffer.from([0x00, 0x00, 0x03, 0xf3]))).toBe(false);
  expect(hasAmigaHunkMagic(Buffer.from([0x00, 0x00, 0x03, 0xf2]))).toBe(false);
  expect(hasAmigaHunkMagic(Buffer.from([0x00, 0x00, 0x03]))).toBe(false);
});

it("lists one code hunk and extracts its stored bytes", () => {
  const bytes = amigaLoadFile({
    libraries: ["dos.library"],
    hunks: [{ type: "code", bytes: CODE, name: "start" }],
  });
  const file = parseAmigaHunk(bytes);
  expect(file.fileKind).toBe("load");
  expect(file.residentLibraries).toEqual(["dos.library"]);
  expect(file.limitations).toEqual([]);
  expect(file.hunks).toMatchObject([
    {
      index: 0,
      type: "code",
      memory: "any",
      extendedFlags: null,
      declaredLongwords: 1,
      storedLongwords: 1,
      storedBytes: 4,
      name: "start",
      relocations: [],
      symbols: [],
      debug: false,
      debugLongwords: 0,
    },
  ]);
  const hunk = file.hunks[0];
  const fileOffset = hunk?.fileOffset ?? 0;
  expect(bytes.subarray(fileOffset, fileOffset + 4).equals(CODE)).toBe(true);
  expect(file.entries).toEqual([
    {
      path: "hunk-0-code.bin",
      role: "code",
      hunk: 0,
      memory: "any",
      declaredBytes: 4,
      storedBytes: 4,
      byteOffset: hunk?.fileOffset,
    },
  ]);
  expect(amigaHunkMetadataSchema.parse(amigaHunkMetadata(file)).kind).toBe(
    "amiga-hunk",
  );
});

it("counts reloc32 and drel32 targets and keeps bss as metadata", () => {
  const bytes = amigaLoadFile({
    hunks: [
      {
        type: "code",
        bytes: Buffer.concat([CODE, DATA]),
        relocs: [{ kind: "reloc32", target: 1, offsets: [0, 4] }],
      },
      {
        type: "data",
        bytes: DATA,
        relocs: [{ kind: "drel32", target: 0, offsets: [0] }],
      },
      { type: "bss", longwords: 4 },
    ],
  });
  const file = parseAmigaHunk(bytes);
  const drel = bytes.indexOf(Buffer.from([0x00, 0x00, 0x03, 0xf7]));
  expect(bytes.readUInt16BE(drel + 4)).toBe(1);
  expect(bytes.readUInt16BE(drel + 6)).toBe(0);
  expect(bytes.readUInt16BE(drel + 8)).toBe(0);
  expect(file.limitations).toEqual([]);
  expect(
    file.hunks.map((hunk) => [hunk.type, hunk.relocations, hunk.storedBytes]),
  ).toEqual([
    ["code", [{ kind: "reloc32", targetHunk: 1, count: 2 }], 8],
    ["data", [{ kind: "drel32", targetHunk: 0, count: 1 }], 4],
    ["bss", [], null],
  ]);
  expect(file.hunks[2]).toMatchObject({
    declaredLongwords: 4,
    storedLongwords: 4,
    fileOffset: null,
  });
  expect(file.entries.map((entry) => entry.path)).toEqual([
    "hunk-0-code.bin",
    "hunk-1-data.bin",
  ]);
});

it("counts reloc32short offsets and skips alignment padding", () => {
  const file = parseAmigaHunk(
    amigaLoadFile({
      hunks: [
        {
          type: "code",
          bytes: Buffer.concat([CODE, DATA]),
          relocs: [{ kind: "reloc32short", target: 0, offsets: [0, 4] }],
        },
      ],
    }),
  );
  expect(file.limitations).toEqual([]);
  expect(file.hunks[0]?.relocations).toEqual([
    { kind: "reloc32short", targetHunk: 0, count: 2 },
  ]);
});

it("keeps symbol names and debug presence", () => {
  const file = parseAmigaHunk(
    amigaLoadFile({
      hunks: [
        {
          type: "code",
          bytes: CODE,
          name: "ab\0cd",
          symbols: [
            { name: "start", offset: 0 },
            { name: "end", offset: 2 },
          ],
          debug: Buffer.from("DBG", "latin1"),
        },
      ],
    }),
  );
  expect(file.limitations).toEqual([]);
  expect(file.hunks[0]).toMatchObject({
    name: "ab",
    symbols: [
      { name: "start", offset: 0 },
      { name: "end", offset: 2 },
    ],
    debug: true,
    debugLongwords: 1,
  });
});

it("records chip, fast and extended memory flags", () => {
  const file = parseAmigaHunk(
    amigaLoadFile({
      hunks: [
        { type: "code", bytes: CODE, memory: "chip", typeFlags: HUNKF_CHIP },
        { type: "data", bytes: DATA, memory: "fast" },
        { type: "bss", longwords: 1, memory: "extended", extendedFlags: 0x2 },
      ],
    }),
  );
  expect(file.limitations).toEqual([]);
  expect(file.hunks.map((hunk) => [hunk.memory, hunk.extendedFlags])).toEqual([
    ["chip", null],
    ["fast", null],
    ["extended", 2],
  ]);
});

it("numbers hunks from the header and reports a missing reloc target", () => {
  const file = parseAmigaHunk(
    amigaLoadFile({
      firstHunk: 2,
      hunks: [
        {
          type: "code",
          bytes: CODE,
          relocs: [
            { kind: "reloc32", target: 2, offsets: [0] },
            { kind: "reloc32", target: 0, offsets: [0] },
          ],
        },
      ],
    }),
  );
  expect(file.hunks[0]?.index).toBe(2);
  expect(file.hunks[0]?.relocations).toEqual([
    { kind: "reloc32", targetHunk: 2, count: 1 },
    { kind: "reloc32", targetHunk: 0, count: 1 },
  ]);
  expect(file.entries[0]?.path).toBe("hunk-2-code.bin");
  expect(file.limitations.map((item) => item.kind)).toEqual([
    "relocation-target",
  ]);
});

it("accepts a reloc inside the header size and past the stored bytes", () => {
  const file = parseAmigaHunk(
    amigaLoadFile({
      hunks: [
        {
          type: "code",
          bytes: CODE,
          declaredLongwords: 2,
          relocs: [{ kind: "reloc32", target: 0, offsets: [4] }],
        },
      ],
    }),
  );
  expect(file.limitations).toEqual([]);
  expect(file.entries[0]).toMatchObject({ declaredBytes: 8, storedBytes: 4 });
  expect(file.hunks[0]?.relocations).toEqual([
    { kind: "reloc32", targetHunk: 0, count: 1 },
  ]);
});

it("reports zero longwords after the last hunk as trailing bytes", () => {
  const padded = parseAmigaHunk(
    amigaLoadFile({
      hunks: [{ type: "code", bytes: CODE }],
      trailing: Buffer.alloc(8),
    }),
  );
  expect(padded.entries).toHaveLength(1);
  expect(padded.hunks[0]?.type).toBe("code");
  expect(padded.limitations.map((item) => item.kind)).toEqual([
    "trailing-bytes",
  ]);
  expect(padded.limitations[0]?.detail).toContain("8 bytes");

  const shortTail = parseAmigaHunk(
    amigaLoadFile({
      hunks: [{ type: "code", bytes: CODE }],
      trailing: Buffer.from([0xab, 0xcd]),
    }),
  );
  expect(shortTail.limitations.map((item) => item.kind)).toEqual([
    "trailing-bytes",
  ]);

  const garbage = parseAmigaHunk(
    amigaLoadFile({
      hunks: [{ type: "code", bytes: CODE }],
      trailing: Buffer.from([0x00, 0x00, 0x00, 0x01]),
    }),
  );
  expect(garbage.limitations.map((item) => item.kind)).toEqual([
    "trailing-bytes",
  ]);
});

it("reports a body past the listed hunks instead of trailing bytes", () => {
  const file = parseAmigaHunk(
    amigaLoadFile({
      hunks: [{ type: "code", bytes: CODE }],
      trailing: Buffer.from([0x00, 0x00, 0x03, 0xe9]),
    }),
  );
  expect(file.entries).toHaveLength(1);
  expect(file.limitations.map((item) => item.kind)).toEqual(["header"]);
});

it("names a real block after the last hunk instead of trailing bytes", () => {
  const overlayBytes = amigaLoadFile({
    hunks: [{ type: "code", bytes: CODE }],
    trailing: Buffer.from([0x00, 0x00, 0x03, 0xf5]),
  });
  const overlay = parseAmigaHunk(overlayBytes);
  const overlayAt = overlayBytes.length - 4;
  expect(overlay.entries).toHaveLength(1);
  expect(overlay.limitations).toEqual([
    {
      kind: "unknown-block",
      offset: overlayAt,
      detail: `Unknown hunk block 0x3f5 at offset ${overlayAt}.`,
    },
  ]);

  const nameAndBody = Buffer.from([
    0x00, 0x00, 0x03, 0xe8, 0x00, 0x00, 0x00, 0x01, 0x61, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x03, 0xe9,
  ]);
  const namedBytes = amigaLoadFile({
    hunks: [{ type: "code", bytes: CODE }],
    trailing: nameAndBody,
  });
  const named = parseAmigaHunk(namedBytes);
  const bodyAt = namedBytes.length - 4;
  expect(named.entries).toHaveLength(1);
  expect(named.limitations).toEqual([
    {
      kind: "header",
      offset: bodyAt,
      detail: `Block at offset ${bodyAt} is past the 1 hunks the header lists.`,
    },
  ]);

  const unassigned = parseAmigaHunk(
    amigaLoadFile({
      hunks: [{ type: "code", bytes: CODE }],
      trailing: Buffer.from([0x00, 0x00, 0x03, 0xf4]),
    }),
  );
  expect(unassigned.limitations.map((item) => item.kind)).toEqual([
    "trailing-bytes",
  ]);
});

it("reports a reloc offset past the hunk size and still counts it", () => {
  const file = parseAmigaHunk(
    amigaLoadFile({
      hunks: [
        {
          type: "code",
          bytes: CODE,
          relocs: [{ kind: "reloc32", target: 0, offsets: [8, 12] }],
        },
      ],
    }),
  );
  expect(file.limitations).toEqual([
    expect.objectContaining({
      kind: "relocation-offset",
      detail: expect.stringContaining("4-byte size"),
    }),
  ]);
  expect(file.hunks[0]?.relocations[0]?.count).toBe(2);
  expect(file.entries).toHaveLength(1);
});

it("stops at an unknown block and names its offset", () => {
  const bytes = amigaLoadFile({
    hunks: [
      {
        type: "code",
        bytes: CODE,
        unknownBeforeEnd: (HUNK_EXT | HUNKF_ADVISORY) >>> 0,
      },
    ],
  });
  const file = parseAmigaHunk(bytes);
  const limitation = file.limitations.find(
    (item) => item.kind === "unknown-block",
  );
  expect(limitation?.detail).toContain(`offset ${limitation?.offset}`);
  expect(limitation?.detail).toContain("advisory bit set");
  expect(bytes.readUInt32BE(limitation?.offset ?? 0) >>> 0).toBe(
    (HUNK_EXT | HUNKF_ADVISORY) >>> 0,
  );
  expect(file.entries).toHaveLength(1);
  expect(file.limitations.map((item) => item.kind)).toContain("missing-end");
});

it("accepts a header allocation larger than the stored block", () => {
  const file = parseAmigaHunk(
    amigaLoadFile({
      hunks: [{ type: "code", bytes: CODE, declaredLongwords: 4 }],
    }),
  );
  expect(file.limitations).toEqual([]);
  expect(file.entries[0]).toMatchObject({ declaredBytes: 16, storedBytes: 4 });
});

it("keeps a block larger than its allocation as a size mismatch", () => {
  const file = parseAmigaHunk(
    amigaLoadFile({
      hunks: [{ type: "code", bytes: Buffer.alloc(8), declaredLongwords: 1 }],
    }),
  );
  expect(file.limitations.map((item) => item.kind)).toEqual(["size-mismatch"]);
  expect(file.entries[0]?.storedBytes).toBe(8);
});

const blockAt = (bytes: Buffer, type: number): number => {
  for (let at = 0; at + 4 <= bytes.length; at += 4)
    if (bytes.readUInt32BE(at) === type) return at;
  throw new Error(`block ${type.toString(16)} not found`);
};

it("keeps parsed facts when a name length runs past the file", () => {
  const bytes = amigaLoadFile({
    hunks: [{ type: "code", bytes: CODE, name: "start" }],
  });
  bytes.writeUInt32BE(0x0fff_ffff, blockAt(bytes, 0x3e8) + 4);
  const file = parseAmigaHunk(bytes);
  expect(file.hunks).toHaveLength(1);
  expect(file.limitations.map((item) => item.kind)).toEqual(["truncated"]);
});

it("keeps parsed facts when a relocation count runs past the file", () => {
  const bytes = amigaLoadFile({
    hunks: [
      {
        type: "code",
        bytes: CODE,
        relocs: [{ kind: "reloc32", target: 0, offsets: [0] }],
      },
    ],
  });
  bytes.writeUInt32BE(0xffff_ffff, blockAt(bytes, 0x3ec) + 4);
  const file = parseAmigaHunk(bytes);
  expect(file.entries.map((entry) => entry.path)).toEqual(["hunk-0-code.bin"]);
  expect(file.hunks[0]?.relocations).toEqual([]);
  expect(file.limitations.map((item) => item.kind)).toEqual(["truncated"]);
});

it("records one limitation for a run of replaced hunk names", () => {
  const named = amigaLoadFile({
    hunks: [{ type: "code", bytes: CODE, name: "start" }],
  });
  const at = blockAt(named, 0x3e8);
  const empty = Buffer.alloc(8);
  empty.writeUInt32BE(0x3e8, 0);
  const bytes = Buffer.concat([
    named.subarray(0, at),
    named.subarray(at, at + 4 + 4 + 8),
    ...Array.from({ length: 64 }, () => empty),
    named.subarray(at),
  ]);
  const file = parseAmigaHunk(bytes);
  expect(
    file.limitations.filter((item) => item.kind === "header"),
  ).toHaveLength(1);
  expect(file.hunks[0]?.name).toBe("start");
});

it("returns no hunks when the header is truncated or first follows last", () => {
  const truncated = parseAmigaHunk(Buffer.from([0x00, 0x00, 0x03, 0xf3]));
  expect(truncated.hunks).toEqual([]);
  expect(truncated.limitations.map((item) => item.kind)).toEqual(["truncated"]);
  const reversed = parseAmigaHunk(amigaLoadFile({ firstHunk: 3, lastHunk: 1 }));
  expect(reversed.hunks).toEqual([]);
  expect(reversed.limitations.map((item) => item.kind)).toEqual(["header"]);
});

it("treats a hostile hunk length as truncation", () => {
  const file = amigaLoadFile({ hunks: [{ type: "code", bytes: CODE }] });
  const cut = Buffer.from(file.subarray(0, 32));
  cut.writeUInt32BE(0x0fff_ffff, 28);
  const parsed = parseAmigaHunk(cut);
  expect(parsed.entries).toEqual([]);
  expect(parsed.limitations.map((item) => item.kind)).toEqual([
    "size-mismatch",
    "truncated",
  ]);
});

it("refuses object units above the hunk allowance", () => {
  const bytes = amigaObjectFile([
    { name: "", hunks: [] },
    { name: "", hunks: [] },
    { name: "", hunks: [] },
  ]);
  expect(
    decodeLimitOf(() => parseAmigaHunk(bytes, { maxHunks: 2 })),
  ).toMatchObject({
    kind: "limit",
    limit: { name: AMIGA_HUNK_HUNK_LIMIT, maximum: 2 },
  });
});

it("notes a table size that does not cover the last hunk", () => {
  const short = parseAmigaHunk(
    amigaLoadFile({
      firstHunk: 2,
      tableSize: 2,
      hunks: [{ type: "code", bytes: CODE }],
    }),
  );
  expect(short.limitations.map((item) => item.kind)).toEqual(["header"]);
  const covered = parseAmigaHunk(
    amigaLoadFile({
      firstHunk: 2,
      tableSize: 3,
      hunks: [{ type: "code", bytes: CODE }],
    }),
  );
  expect(covered.limitations).toEqual([]);
});

it("caps relocation records across the file", () => {
  const bytes = amigaLoadFile({
    hunks: [0, 1, 2].map(() => ({
      type: "code" as const,
      bytes: CODE,
      relocs: [{ kind: "reloc32" as const, target: 0, offsets: [0] }],
    })),
  });
  expect(
    decodeLimitOf(() => parseAmigaHunk(bytes, { maxRelocationRecords: 2 })),
  ).toMatchObject({
    kind: "limit",
    limit: { name: AMIGA_HUNK_RELOCATION_RECORD_LIMIT, maximum: 2 },
  });
});

it("refuses a hunk table above the hunk ceiling before reading it", () => {
  expect(
    decodeLimitOf(() =>
      parseAmigaHunk(amigaLoadFile({ firstHunk: 0, lastHunk: 2 }), {
        maxHunks: 2,
      }),
    ),
  ).toMatchObject({
    kind: "limit",
    limit: { name: AMIGA_HUNK_HUNK_LIMIT, maximum: 2 },
  });
});

it("refuses a relocation group above the per-hunk ceiling", () => {
  expect(
    decodeLimitOf(() =>
      parseAmigaHunk(
        amigaLoadFile({
          hunks: [
            {
              type: "code",
              bytes: CODE,
              relocs: [{ kind: "reloc32", target: 0, offsets: [0, 0] }],
            },
          ],
        }),
        { maxRelocations: 1 },
      ),
    ).limit,
  ).toMatchObject({
    name: AMIGA_HUNK_RELOCATION_LIMIT,
    maximum: 1,
  });
});

it("refuses a name that would exceed the shared name budget", () => {
  expect(
    decodeLimitOf(() =>
      parseAmigaHunk(
        amigaLoadFile({
          libraries: ["ab"],
          hunks: [
            {
              type: "code",
              bytes: CODE,
              symbols: [{ name: "start", offset: 0 }],
            },
          ],
        }),
        { maxSymbolBytes: 4 },
      ),
    ).limit,
  ).toMatchObject({
    name: AMIGA_HUNK_SYMBOL_LIMIT,
    maximum: 4,
  });
});

it("reads object-file extended memory from the flags longword", () => {
  const bytes = amigaObjectFile([
    {
      name: "obj.o",
      hunks: [
        {
          type: "code",
          bytes: CODE,
          memory: "extended",
          extendedFlags: 0x102,
        },
      ],
    },
  ]);
  const file = parseAmigaHunk(bytes);
  expect(file.limitations).toEqual([]);
  expect(file.hunks[0]).toMatchObject({
    memory: "extended",
    extendedFlags: 0x102,
    declaredLongwords: 1,
    storedBytes: 4,
  });
  const at = file.hunks[0]?.fileOffset ?? 0;
  expect(bytes.subarray(at, at + 4).equals(CODE)).toBe(true);
});

it("keeps object-file HUNK_DREL32 as 32-bit relocations", () => {
  const bytes = amigaObjectFile([
    {
      name: "obj.o",
      hunks: [
        {
          type: "code",
          bytes: CODE,
          relocs: [{ kind: "drel32", target: 0, offsets: [0] }],
        },
      ],
    },
  ]);
  const file = parseAmigaHunk(bytes);
  expect(file.limitations).toEqual([]);
  expect(file.hunks[0]?.relocations).toEqual([
    { kind: "drel32", targetHunk: 0, count: 1 },
  ]);
  const at = bytes.indexOf(Buffer.from([0x00, 0x00, 0x03, 0xf7]));
  expect(bytes.readUInt32BE(at + 4)).toBe(1);
  expect(bytes.readUInt32BE(at + 8)).toBe(0);
  expect(bytes.readUInt32BE(at + 12)).toBe(0);
});

it("lists object units with each hunk's unit and extracts nothing", () => {
  const bytes = amigaObjectFile([
    { name: "obj.o", hunks: [{ type: "code", bytes: CODE, memory: "chip" }] },
    {
      name: "next.o",
      hunks: [{ type: "data", bytes: DATA, unknownBeforeEnd: HUNK_EXT }],
    },
  ]);
  const file = parseAmigaHunk(bytes);
  expect(file.fileKind).toBe("object");
  expect(file.tableSize).toBeNull();
  expect(file.units.map((unit) => unit.name)).toEqual(["obj.o", "next.o"]);
  expect(file.hunks[0]).toMatchObject({
    index: 0,
    type: "code",
    memory: "chip",
  });
  expect(file.hunks.map((hunk) => [hunk.unit, hunk.index])).toEqual([
    [0, 0],
    [1, 0],
  ]);
  expect(file.entries).toEqual([]);
  expect(file.limitations.map((item) => item.kind)).toContain("unknown-block");
});

it("rejects a file that is not a hunk image", () => {
  const failure = limitOf(() => parseAmigaHunk(Buffer.from("bFLT")));
  expect(failure.kind).toBe("malformed");
});
