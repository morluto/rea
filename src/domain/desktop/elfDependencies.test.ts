import { describe, expect, it } from "vitest";

import { desktopLibraryPolicy } from "./libraryPolicy.js";
import { readElfDependencies } from "./elfDependencies.js";
import { elfImage, readImage } from "./elfImage.fixture.js";

const dependencies = (image: Buffer) =>
  readElfDependencies(readImage(image), image.length);

describe("readElfDependencies", () => {
  it("reads DT_NEEDED and the RPATH as Typora's executable declares them", async () => {
    const image = elfImage({
      rpath: "$ORIGIN",
      needed: [
        "libffmpeg.so",
        "libnss3.so",
        "libc.so.6",
        "ld-linux-aarch64.so.1",
      ],
    });

    expect(await dependencies(image)).toEqual({
      ok: true,
      value: {
        machine: 183,
        bits: 64,
        byte_order: "little",
        needed: [
          "libffmpeg.so",
          "libnss3.so",
          "libc.so.6",
          "ld-linux-aarch64.so.1",
        ],
        runpath: undefined,
        rpath: ["$ORIGIN"],
      },
    });
  });

  it("drops DT_RPATH when DT_RUNPATH is present, as ld.so does, and splits its directories", async () => {
    const image = elfImage({
      needed: ["libc.so.6"],
      rpath: "/opt/old",
      runpath: "$ORIGIN:$ORIGIN/../lib",
    });

    expect(await dependencies(image)).toMatchObject({
      ok: true,
      value: { runpath: ["$ORIGIN", "$ORIGIN/../lib"], rpath: [] },
    });
  });

  it("decodes each needed string once and refuses a table naming more libraries than the walk takes", async () => {
    const repeated = await dependencies(
      elfImage({ needed: ["libc.so.6"], repeatNeeded: 60_000 }),
    );
    expect(repeated).toMatchObject({
      ok: true,
      value: { needed: ["libc.so.6"] },
    });

    const names = Array.from(
      { length: 513 },
      (_, index) => `lib${String(index)}.so`,
    );
    const image = elfImage({ needed: names });
    expect(await dependencies(image)).toMatchObject({
      ok: false,
      error: {
        reason: expect.stringContaining("library-policy.libraries=512"),
      },
    });
    expect(
      await readElfDependencies(
        readImage(image),
        image.length,
        desktopLibraryPolicy({ libraries: 513 }),
      ),
    ).toMatchObject({ ok: true, value: { needed: names } });
  });

  it("distinguishes a bounded string read from truncation and recovers with its named budget", async () => {
    const needed = "l".repeat(4096);
    const image = elfImage({ needed: [needed] });
    expect(await dependencies(image)).toMatchObject({
      ok: false,
      error: {
        reason: expect.stringContaining(
          "library-policy.string_bytes=4096 bytes",
        ),
      },
    });
    expect(
      await readElfDependencies(
        readImage(image),
        image.length,
        desktopLibraryPolicy({ string_bytes: 4097 }),
      ),
    ).toMatchObject({ ok: true, value: { needed: [needed] } });
  });

  it("reports no dependencies for a static image", async () => {
    expect(await dependencies(elfImage({ static: true }))).toMatchObject({
      ok: true,
      value: { needed: [], runpath: undefined, rpath: [] },
    });
  });
});

describe("ELF dependency identity and failures", () => {
  it.each(["size", "version"])(
    "retains decoded identity when fixed-header %s admission fails",
    async (field) => {
      const image = elfImage({ needed: ["libcore.so"] });
      if (field === "size") image.writeUInt16LE(0, 52);
      else image.writeUInt32LE(2, 20);
      expect(await dependencies(image)).toMatchObject({
        ok: false,
        error: {
          kind: "unreadable",
          identity: { machine: 183, bits: 64, byte_order: "little" },
          reason: expect.stringContaining(
            field === "size" ? "header size" : "header version",
          ),
        },
      });
    },
  );

  it("classifies a foreign candidate before its declared header extent is admitted", async () => {
    const image = elfImage({});
    image.writeUInt16LE(0, 52);
    expect(
      await readElfDependencies(
        readImage(image),
        image.length,
        desktopLibraryPolicy(),
        { machine: 62, bits: 64, byte_order: "little" },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "incompatible",
        identity: { machine: 183, bits: 64, byte_order: "little" },
      },
    });
  });

  it.each([
    { machine: 62, bits: 64 as const, byte_order: "little" as const },
    { machine: 183, bits: 32 as const, byte_order: "little" as const },
    { machine: 183, bits: 64 as const, byte_order: "big" as const },
  ])(
    "rejects incompatible identity before reading dependency tables ($machine / $bits / $byte_order)",
    async (expected) => {
      const image = elfImage({ needed: ["libdecoy.so"], unterminated: true });
      const reads: [number, number][] = [];
      const result = await readElfDependencies(
        async (offset, length) => {
          reads.push([offset, length]);
          return readImage(image)(offset, length);
        },
        image.length,
        desktopLibraryPolicy({ table_bytes: 1 }),
        expected,
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: "incompatible",
          identity: { machine: 183, bits: 64, byte_order: "little" },
        },
      });
      expect(reads).toEqual([[0, 64]]);
    },
  );

  it("retains fixed-header identity when dependency parsing or its table allowance fails", async () => {
    const image = elfImage({ needed: ["libcore.so"], unterminated: true });
    for (const policy of [
      desktopLibraryPolicy(),
      desktopLibraryPolicy({ table_bytes: 1 }),
    ]) {
      const result = await readElfDependencies(
        readImage(image),
        image.length,
        policy,
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          identity: { machine: 183, bits: 64, byte_order: "little" },
          reason: expect.any(String),
        },
      });
    }
  });

  it.each(["unmapped strings", "invalid load sizes", "truncated load bytes"])(
    "does not derive library names from %s",
    async (failure) => {
      const valid = elfImage({ needed: ["libc.so.6"] });
      expect(await dependencies(valid)).toMatchObject({
        ok: true,
        value: { needed: ["libc.so.6"] },
      });
      const malformed = Buffer.from(valid);
      if (failure === "unmapped strings")
        // The NUL at the beginning of DT_STRTAB is mapped; the library name is not.
        malformed.writeBigUInt64LE(177n, 64 + 32);
      else if (failure === "invalid load sizes")
        malformed.writeBigUInt64LE(0n, 64 + 40);
      else {
        malformed.writeBigUInt64LE(BigInt(valid.length + 1), 64 + 32);
        malformed.writeBigUInt64LE(BigInt(valid.length + 1), 64 + 40);
      }
      expect(await dependencies(malformed)).toMatchObject({ ok: false });
    },
  );

  it("refuses a script, a truncated image and a dynamic table without DT_NULL", async () => {
    const script = Buffer.from('#!/bin/sh\nexec /opt/app/app "$@"\n');
    expect(await dependencies(script)).toEqual({
      ok: false,
      error: { kind: "unreadable", identity: null, reason: "not an ELF image" },
    });
    const image = elfImage({ needed: ["libc.so.6"] });
    expect(
      await readElfDependencies(readImage(image.subarray(0, 100)), 100),
    ).toMatchObject({ ok: false });
    expect(
      await dependencies(
        elfImage({ needed: ["libc.so.6"], unterminated: true }),
      ),
    ).toEqual({
      ok: false,
      error: {
        kind: "unreadable",
        identity: { machine: 183, bits: 64, byte_order: "little" },
        reason: "ELF dynamic table has no DT_NULL terminator",
      },
    });
  });
});

it.each([false, true])(
  "rejects conflicting string-table mappings and accepts identical aliases (reversed: %s)",
  async (reversed) => {
    const base = elfImage({ needed: ["libc.so.6"] });
    const alternate = Buffer.from("\0libevilso\0");
    const headersAt = base.length + alternate.length;
    const image = Buffer.concat([base, alternate, Buffer.alloc(3 * 56)]);
    base.copy(image, headersAt, 64, 64 + 2 * 56);
    image.writeBigUInt64LE(BigInt(headersAt), 32);
    image.writeUInt16LE(3, 56);
    const alias = headersAt + 2 * 56;
    image.writeUInt32LE(1, alias);
    image.writeBigUInt64LE(BigInt(base.length), alias + 8);
    image.writeBigUInt64LE(176n, alias + 16);
    image.writeBigUInt64LE(BigInt(alternate.length), alias + 32);
    image.writeBigUInt64LE(BigInt(alternate.length), alias + 40);
    if (reversed) {
      const first = Buffer.from(image.subarray(headersAt, headersAt + 56));
      image.copy(image, headersAt, alias, alias + 56);
      first.copy(image, alias);
    }
    expect(await dependencies(image)).toMatchObject({
      ok: false,
      error: {
        kind: "unreadable",
        identity: { machine: 183, bits: 64, byte_order: "little" },
        reason: "ELF dynamic string table has ambiguous file mappings",
      },
    });
    // Two load declarations that translate to the same bytes are not ambiguous.
    const aliasAt = reversed ? headersAt : alias;
    image.writeBigUInt64LE(176n, aliasAt + 8);
    expect(await dependencies(image)).toMatchObject({
      ok: true,
      value: { needed: ["libc.so.6"] },
    });
    // A conflicting mapping of even one string byte keeps the table ambiguous.
    image.writeBigUInt64LE(177n, aliasAt + 16);
    image.writeBigUInt64LE(BigInt(base.length + 1), aliasAt + 8);
    image.writeBigUInt64LE(1n, aliasAt + 32);
    image.writeBigUInt64LE(1n, aliasAt + 40);
    expect(await dependencies(image)).toMatchObject({
      ok: false,
      error: {
        kind: "unreadable",
        identity: { machine: 183, bits: 64, byte_order: "little" },
        reason: "ELF dynamic string table has ambiguous file mappings",
      },
    });
    image.writeBigUInt64LE(177n, aliasAt + 8);
    expect(await dependencies(image)).toMatchObject({
      ok: true,
      value: { needed: ["libc.so.6"] },
    });
    // Zero-fill overlaps conflict with the file-backed table as well.
    image.writeBigUInt64LE(0n, aliasAt + 32);
    expect(await dependencies(image)).toMatchObject({
      ok: false,
      error: {
        kind: "unreadable",
        identity: { machine: 183, bits: 64, byte_order: "little" },
        reason: "ELF dynamic string table has ambiguous file mappings",
      },
    });
    // Consistent adjacent declarations can cover the table together.
    const originalAt = reversed ? alias : headersAt;
    image.writeBigUInt64LE(177n, originalAt + 32);
    image.writeBigUInt64LE(177n, originalAt + 40);
    image.writeBigUInt64LE(177n, aliasAt + 8);
    image.writeBigUInt64LE(BigInt(alternate.length - 1), aliasAt + 32);
    image.writeBigUInt64LE(BigInt(alternate.length - 1), aliasAt + 40);
    expect(await dependencies(image)).toMatchObject({
      ok: true,
      value: { needed: ["libc.so.6"] },
    });
    image.writeBigUInt64LE(BigInt(base.length), originalAt + 32);
    image.writeBigUInt64LE(BigInt(base.length), originalAt + 40);
    // An empty load has no file bytes to admit, regardless of its file offset.
    image.writeBigUInt64LE(0x100000n, aliasAt + 8);
    image.writeBigUInt64LE(0n, aliasAt + 32);
    image.writeBigUInt64LE(0n, aliasAt + 40);
    expect(await dependencies(image)).toMatchObject({
      ok: true,
      value: { needed: ["libc.so.6"] },
    });
  },
);
