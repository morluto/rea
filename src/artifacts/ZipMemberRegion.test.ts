import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32 } from "node:zlib";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import type { ArtifactReaderTraversal } from "../resources/ArtifactReader.js";
import { scanReader } from "./inventory/scanReader.js";
import {
  accountZipMemberRegion,
  type ZipLocalRecord,
} from "../domain/zip/zipMemberRegion.js";
import { BinaryReader } from "../domain/binaryContainer.js";
import { ZipArtifactReader, zipListingCoverage } from "../resources/index.js";

interface Member {
  readonly name: string;
  readonly data: Buffer;
  /** Whether the central directory lists this local entry. */
  readonly listed: boolean;
}

const member = (name: string, listed = true): Member => ({
  name,
  data: Buffer.from(`${name} bytes`),
  listed,
});

const recordOf = (entry: Member, offset: number): ZipLocalRecord => ({
  offset,
  compressedSize: entry.data.length,
  uncompressedSize: entry.data.length,
  crc32: crc32(entry.data),
  zip64: false,
  dataDescriptor: false,
});

const localEntry = ({ name, data }: Member, flags = 0): Buffer => {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(Buffer.byteLength(name), 26);
  return Buffer.concat([header, Buffer.from(name), data]);
};

const centralRecord = ({ name, data }: Member, offset: number): Buffer => {
  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(20, 4);
  record.writeUInt16LE(20, 6);
  record.writeUInt32LE(crc32(data), 16);
  record.writeUInt32LE(data.length, 20);
  record.writeUInt32LE(data.length, 24);
  record.writeUInt16LE(Buffer.byteLength(name), 28);
  record.writeUInt32LE(offset, 42);
  return Buffer.concat([record, Buffer.from(name)]);
};

/**
 * A stored ZIP. Unlisted members keep their local entry but no directory
 * record, unless `trailingRecords` keeps their record past the EOCD count.
 */
const zip = (
  members: readonly Member[],
  options: { prefix?: Buffer; gap?: Buffer; trailingRecords?: boolean } = {},
): Buffer => {
  const prefix = options.prefix ?? Buffer.alloc(0);
  const locals: Buffer[] = [prefix];
  const listed: Buffer[] = [];
  const trailing: Buffer[] = [];
  let offset = prefix.length;
  for (const item of members) {
    const local = localEntry(item);
    if (item.listed) listed.push(centralRecord(item, offset));
    else if (options.trailingRecords === true)
      trailing.push(centralRecord(item, offset));
    locals.push(local);
    offset += local.length;
  }
  if (options.gap !== undefined) {
    locals.push(options.gap);
    offset += options.gap.length;
  }
  const directory = Buffer.concat([...listed, ...trailing]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(listed.length, 8);
  end.writeUInt16LE(listed.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

/** An APK Signature Scheme v2 block shape: size, pairs, size, magic. */
const apkSigningBlock = (magic = "APK Sig Block 42"): Buffer => {
  const pairs = Buffer.alloc(12);
  pairs.writeBigUInt64LE(4n, 0);
  const size = BigInt(pairs.length + 8 + 16);
  const leading = Buffer.alloc(8);
  leading.writeBigUInt64LE(size);
  return Buffer.concat([leading, pairs, leading, Buffer.from(magic, "latin1")]);
};

const list = async (
  bytes: Buffer | Uint8Array,
): Promise<{ paths: string[]; coverage: ArtifactReaderTraversal[] }> => {
  const directory = await createTestTempDirectory("rea-zip-member-region-");
  const path = join(directory, "fixture.zip");
  await writeFile(path, bytes);
  const reader = new ZipArtifactReader(path, "zip");
  const paths: string[] = [];
  const coverage: ArtifactReaderTraversal[] = [];
  try {
    for await (const entry of reader.entries(undefined, {
      onCoverage: (value) => coverage.push(value),
    }))
      paths.push(entry.path);
  } finally {
    await reader.close();
  }
  return { paths, coverage };
};

const complete = { status: "complete", limitations: [] };
const unaccounted = (bytes: number, ranges: number, first: number) => ({
  status: "unknown",
  limitations: [
    `ZIP central directory does not account for ${String(bytes)} byte(s) in ${String(ranges)} range(s) before it, first at offset ${String(first)}; local entries it does not list may exist there.`,
  ],
});
/** Bytes of `localEntry(member("hidden.txt"))`. */
const HIDDEN_ENTRY_BYTES = 30 + 10 + 16;
/** Bytes of `localEntry(member("a.txt"))`, the offset after it. */
const A_ENTRY_BYTES = 30 + 5 + 11;

describe("ZIP listing coverage against the member region", () => {
  it("counts a missing header's uncovered region only once", async () => {
    const valid = localEntry(member("a.txt"));
    const bytes = Buffer.concat([Buffer.alloc(200), valid]);
    const records = [
      {
        offset: 100,
        compressedSize: 0,
        uncompressedSize: 0,
        crc32: 0,
        zip64: false,
        dataDescriptor: false,
      },
      {
        offset: 200,
        compressedSize: member("a.txt").data.length,
        uncompressedSize: member("a.txt").data.length,
        crc32: crc32(member("a.txt").data),
        zip64: false,
        dataDescriptor: false,
      },
    ];
    expect(
      await accountZipMemberRegion(records, bytes.length, async (at, length) =>
        bytes.subarray(at, at + length),
      ),
    ).toMatchObject({
      unaccountedBytes: 200,
      unaccountedRanges: 1,
      firstUnaccountedOffset: 0,
      unlocatedHeaders: 1,
    });
  });

  it("accounts for a validated data descriptor before an unlisted entry", async () => {
    const first = member("a.txt");
    const local = localEntry(first, 0x8);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc32(first.data), 4);
    descriptor.writeUInt32LE(first.data.length, 8);
    descriptor.writeUInt32LE(first.data.length, 12);
    const hidden = localEntry(member("hidden.txt", false));
    const bytes = Buffer.concat([local, descriptor, hidden]);
    const records = [
      {
        offset: 0,
        compressedSize: first.data.length,
        uncompressedSize: first.data.length,
        crc32: crc32(first.data),
        zip64: false,
        dataDescriptor: true,
      },
    ];
    expect(
      await accountZipMemberRegion(records, bytes.length, async (at, length) =>
        bytes.subarray(at, at + length),
      ),
    ).toMatchObject({
      unaccountedBytes: hidden.length,
      unaccountedRanges: 1,
      firstUnaccountedOffset: local.length + descriptor.length,
    });
  });

  it("accounts for an unsigned data descriptor whose CRC equals the descriptor signature", async () => {
    const first = member("a.txt");
    const local = localEntry(first, 0x8);
    // CRC 0x08074b50 makes the unsigned descriptor start with the signature bytes.
    const descriptor = Buffer.alloc(12);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(first.data.length, 4);
    descriptor.writeUInt32LE(first.data.length, 8);
    const bytes = Buffer.concat([local, descriptor]);
    const records = [
      {
        offset: 0,
        compressedSize: first.data.length,
        uncompressedSize: first.data.length,
        crc32: 0x08074b50,
        zip64: false,
        dataDescriptor: true,
      },
    ];
    expect(
      await accountZipMemberRegion(records, bytes.length, async (at, length) =>
        bytes.subarray(at, at + length),
      ),
    ).toMatchObject({ unaccountedBytes: 0, unaccountedRanges: 0 });
    // With room for a signed layout, the unsigned layout still matches.
    // The extra bytes are non-zero, so they are a real gap rather than
    // alignment padding before the directory.
    const padded = Buffer.concat([bytes, Buffer.alloc(4, 0x7f)]);
    expect(
      await accountZipMemberRegion(records, padded.length, async (at, length) =>
        padded.subarray(at, at + length),
      ),
    ).toMatchObject({
      unaccountedBytes: 4,
      unaccountedRanges: 1,
      firstUnaccountedOffset: bytes.length,
    });
  });

  it("accounts for a 32-bit data descriptor after a ZIP64 directory record", async () => {
    const first = member("a.txt");
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc32(first.data), 4);
    descriptor.writeUInt32LE(first.data.length, 8);
    descriptor.writeUInt32LE(first.data.length, 12);
    const bytes = Buffer.concat([localEntry(first, 0x8), descriptor]);
    const record = {
      offset: 0,
      compressedSize: first.data.length,
      uncompressedSize: first.data.length,
      crc32: crc32(first.data),
      zip64: true,
      dataDescriptor: true,
    };
    expect(
      await accountZipMemberRegion([record], bytes.length, async (at, length) =>
        bytes.subarray(at, at + length),
      ),
    ).toMatchObject({ unaccountedBytes: 0, unaccountedRanges: 0 });
  });

  it("accounts for an AE-2 data descriptor whose directory reports no CRC", async () => {
    const first = member("a.txt");
    const local = localEntry(first, 0x8);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(first.data.length, 8);
    descriptor.writeUInt32LE(first.data.length, 12);
    const bytes = Buffer.concat([local, descriptor]);
    const record = {
      offset: 0,
      compressedSize: first.data.length,
      uncompressedSize: first.data.length,
      crc32: undefined,
      zip64: false,
      dataDescriptor: true,
    };
    const read = async (at: number, length: number) =>
      bytes.subarray(at, at + length);
    expect(
      await accountZipMemberRegion([record], bytes.length, read),
    ).toMatchObject({ unaccountedBytes: 0, unaccountedRanges: 0 });
    // Sizes still have to match.
    expect(
      await accountZipMemberRegion(
        [{ ...record, compressedSize: first.data.length + 1 }],
        bytes.length,
        read,
      ),
    ).toMatchObject({ unaccountedRanges: 1 });
  });
});

describe("ZIP local member extents", () => {
  it.each([false, true])(
    "corroborates a Zip64 local compressed size (uncompressed sentinel: %s)",
    async (uncompressedSentinel) => {
      const data = Buffer.from("payload");
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50);
      header.writeUInt32LE(0xffffffff, 18);
      header.writeUInt32LE(uncompressedSentinel ? 0xffffffff : data.length, 22);
      const extra = Buffer.alloc(uncompressedSentinel ? 20 : 12);
      extra.writeUInt16LE(1);
      extra.writeUInt16LE(extra.length - 4, 2);
      if (uncompressedSentinel) extra.writeBigUInt64LE(BigInt(data.length), 4);
      const compressedAt = uncompressedSentinel ? 12 : 4;
      extra.writeBigUInt64LE(BigInt(data.length), compressedAt);
      header.writeUInt16LE(extra.length, 28);
      const record = {
        offset: 0,
        compressedSize: data.length,
        uncompressedSize: data.length,
        crc32: 0,
        zip64: false,
        dataDescriptor: false,
      };
      const account = async () => {
        const bytes = Buffer.concat([header, extra, data]);
        return accountZipMemberRegion(
          [record],
          bytes.length,
          async (at, length) => bytes.subarray(at, at + length),
        );
      };
      expect(await account()).toMatchObject({
        unaccountedBytes: 0,
        unaccountedRanges: 0,
      });
      extra.writeBigUInt64LE(BigInt(data.length + 1), compressedAt);
      expect(await account()).toMatchObject({
        unaccountedBytes: header.length + extra.length + data.length,
        unverifiedExtents: 1,
      });
      // A sentinel with no compressed-size slot cannot corroborate an extent.
      extra.writeUInt16LE(0, 2);
      expect(await account()).toMatchObject({
        unaccountedBytes: header.length + extra.length + data.length,
        unverifiedExtents: 1,
      });
    },
  );

  it.each(["name", "extra", "payload"] as const)(
    "does not account a %s extent beyond the directory or read outside it",
    async (field) => {
      const first = member("a.txt");
      const bytes = localEntry(first);
      if (field === "name") bytes.writeUInt16LE(0xffff, 26);
      if (field === "extra") bytes.writeUInt16LE(0xffff, 28);
      const record = {
        offset: 0,
        compressedSize: field === "payload" ? bytes.length : first.data.length,
        uncompressedSize: first.data.length,
        crc32: crc32(first.data),
        zip64: false,
        dataDescriptor: false,
      };
      const result = await accountZipMemberRegion(
        [record],
        bytes.length,
        async (at, length) => {
          expect(at).toBeGreaterThanOrEqual(0);
          expect(at + length).toBeLessThanOrEqual(bytes.length);
          return bytes.subarray(at, at + length);
        },
      );
      expect(result).toMatchObject({
        unaccountedBytes: bytes.length,
        unverifiedExtents: 1,
      });
    },
  );

  it("does not treat a central descriptor flag as permission to ignore a known local size", async () => {
    const first = member("a.txt");
    const bytes = localEntry(first);
    const result = await accountZipMemberRegion(
      [
        {
          offset: 0,
          compressedSize: first.data.length,
          uncompressedSize: first.data.length,
          crc32: crc32(first.data),
          zip64: false,
          dataDescriptor: true,
        },
      ],
      bytes.length,
      async (at, length) => bytes.subarray(at, at + length),
    );
    expect(result).toMatchObject({
      unaccountedBytes: bytes.length,
      unverifiedExtents: 1,
    });
  });
});

describe("ZIP deferred member extents", () => {
  it.each([false, true])(
    "checks contained deferred records without multiplying window reads (descriptor present: %s)",
    async (present) => {
      const bytes = Buffer.alloc(70_000);
      bytes.writeUInt32LE(0x04034b50);
      bytes.writeUInt32LE(bytes.length - 30, 18);
      bytes.writeUInt32LE(bytes.length - 30, 22);
      bytes.writeUInt32LE(0x04034b50, 40);
      bytes.writeUInt16LE(0x8, 46);
      const payloadEnd = 69_000;
      const size = payloadEnd - 40 - 30;
      if (present) {
        bytes.writeUInt32LE(0x08074b50, payloadEnd);
        bytes.writeUInt32LE(size, payloadEnd + 8);
        bytes.writeUInt32LE(size, payloadEnd + 12);
      }
      const records = [
        {
          offset: 0,
          compressedSize: bytes.length - 30,
          uncompressedSize: bytes.length - 30,
          crc32: 0,
          zip64: false,
          dataDescriptor: false,
        },
        ...Array.from({ length: 64 }, () => ({
          offset: 40,
          compressedSize: size,
          uncompressedSize: size,
          crc32: 0,
          zip64: false,
          dataDescriptor: true,
        })),
      ];
      let readBytes = 0;
      const account = await accountZipMemberRegion(
        records,
        bytes.length,
        async (at, length) => {
          readBytes += length;
          return bytes.subarray(at, at + length);
        },
      );
      expect(zipListingCoverage(account).status).toBe(
        present ? "complete" : "unknown",
      );
      // Proof reads may follow each row, but must not reload a 64 KiB window
      // for every alias of a distant descriptor.
      expect(readBytes).toBeLessThanOrEqual(bytes.length + records.length * 64);
    },
  );

  it("requires a descriptor even when its claimed payload ends at the directory", async () => {
    const first = member("a.txt");
    const bytes = localEntry(first, 0x8);
    const account = await accountZipMemberRegion(
      [
        {
          offset: 0,
          compressedSize: first.data.length,
          uncompressedSize: first.data.length,
          crc32: crc32(first.data),
          zip64: false,
          dataDescriptor: true,
        },
      ],
      bytes.length,
      async (at, length) => bytes.subarray(at, at + length),
    );
    expect(zipListingCoverage(account).status).toBe("unknown");
  });

  it("does not lose an unverified descriptor when an overlapping claim extends the covered interval", async () => {
    const bytes = Buffer.alloc(95);
    bytes.writeUInt32LE(0x04034b50);
    bytes.writeUInt16LE(0x8, 6);
    bytes.writeUInt32LE(0x04034b50, 64);
    bytes.writeUInt32LE(1, 64 + 18);
    bytes.writeUInt32LE(1, 64 + 22);
    bytes[94] = 1;
    const account = await accountZipMemberRegion(
      [
        {
          offset: 0,
          compressedSize: 64,
          uncompressedSize: 0,
          crc32: 0,
          zip64: false,
          dataDescriptor: true,
        },
        {
          offset: 64,
          compressedSize: 1,
          uncompressedSize: 1,
          crc32: 0,
          zip64: false,
          dataDescriptor: false,
        },
      ],
      bytes.length,
      async (at, length) => bytes.subarray(at, at + length),
    );
    expect(zipListingCoverage(account).status).toBe("unknown");
  });
});

describe("ZIP64 local metadata work", () => {
  it("does not rescan a repeated local Zip64 extra field for every directory occurrence", async () => {
    const extra = Buffer.alloc(420);
    extra.writeUInt16LE(1, 400);
    extra.writeUInt16LE(16, 402);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt32LE(0xffffffff, 18);
    header.writeUInt32LE(0xffffffff, 22);
    header.writeUInt16LE(extra.length, 28);
    const bytes = Buffer.concat([header, extra]);
    const records = Array.from({ length: 64 }, () => ({
      offset: 0,
      compressedSize: 0,
      uncompressedSize: 0,
      crc32: 0,
      zip64: true,
      dataDescriptor: false,
    }));
    const fields = vi.spyOn(BinaryReader.prototype, "u16");
    try {
      const account = await accountZipMemberRegion(
        records,
        bytes.length,
        async (at, length) => bytes.subarray(at, at + length),
      );
      expect(account).toMatchObject({
        unaccountedBytes: 0,
        unaccountedRanges: 0,
      });
      expect(zipListingCoverage(account).status).toBe("complete");
      // Field-walk work follows source bytes plus directory rows, not their product.
      expect(fields.mock.calls.length).toBeLessThanOrEqual(
        4 * (bytes.length + records.length),
      );
    } finally {
      fields.mockRestore();
    }
  });

  it("leaves overlapping Zip64 metadata unknown once its field-walk work exceeds source bytes", async () => {
    // A local-header signature also spells an extra field of length 0x0403.
    // Every fake header's extra field therefore walks through later headers
    // to the same Zip64 size slot, repeatedly interpreting the same bytes.
    const step = 4 + 0x0403;
    const count = 16;
    const bytes = Buffer.alloc(count * step + 20);
    const records = Array.from({ length: count }, (_, index) => {
      const offset = index * step;
      bytes.writeUInt32LE(0x04034b50, offset);
      bytes.writeUInt32LE(0xffffffff, offset + 18);
      bytes.writeUInt32LE(0xffffffff, offset + 22);
      bytes.writeUInt16LE(bytes.length - offset - 30, offset + 28);
      bytes.writeUInt16LE(0x9999, offset + 30);
      bytes.writeUInt16LE(1, offset + 32);
      return {
        offset,
        compressedSize: 0,
        uncompressedSize: 0,
        crc32: 0,
        zip64: true,
        dataDescriptor: false,
      };
    });
    bytes.writeUInt16LE(1, count * step);
    bytes.writeUInt16LE(16, count * step + 2);
    const account = await accountZipMemberRegion(
      records,
      bytes.length,
      async (at, length) => bytes.subarray(at, at + length),
    );
    expect(zipListingCoverage(account).status).toBe("unknown");
  });
});

describe("ZIP listing coverage from the central directory", () => {
  it("declares complete coverage when directory records cover every byte", async () => {
    expect(await list(zip([member("a.txt"), member("b.txt")]))).toEqual({
      paths: ["a.txt", "b.txt"],
      coverage: [complete],
    });
  });

  it("declares complete coverage for writer-produced data descriptors", async () => {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {
      dataDescriptor: true,
      dataDescriptorSignature: true,
    });
    await writer.add("a.txt", new TextReader("a".repeat(500)));
    await writer.add("b.txt", new TextReader("b"));
    expect((await list(await writer.close())).coverage).toEqual([complete]);
  });

  it("declares complete coverage for MSIX-style 64-bit data descriptors without ZIP64 fields", async () => {
    // MSIX and APPX packages: sizes deferred to a signed descriptor with
    // 8-byte sizes, and no ZIP64 extra field in either header. An empty
    // member's zero sizes also match the first 16 bytes as a 32-bit layout.
    const empty = { ...member("Assets/empty.txt"), data: Buffer.alloc(0) };
    const last = { ...empty, name: "last.txt" };
    const members = [member("AppxManifest.xml"), empty, member("a.png"), last];
    const locals: Buffer[] = [];
    const records: Buffer[] = [];
    let offset = 0;
    for (const item of members) {
      const local = localEntry(item);
      local.writeUInt16LE(0x0008, 6);
      local.fill(0, 14, 26);
      const descriptor = Buffer.alloc(24);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc32(item.data), 4);
      descriptor.writeBigUInt64LE(BigInt(item.data.length), 8);
      descriptor.writeBigUInt64LE(BigInt(item.data.length), 16);
      const record = centralRecord(item, offset);
      record.writeUInt16LE(0x0008, 8);
      locals.push(local, descriptor);
      records.push(record);
      offset += local.length + descriptor.length;
    }
    const directory = Buffer.concat(records);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(records.length, 8);
    end.writeUInt16LE(records.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    expect(await list(Buffer.concat([...locals, directory, end]))).toEqual({
      paths: members.map(({ name }) => name),
      coverage: [complete],
    });
  });

  it.each([
    [
      "before the first listed member",
      [member("hidden.txt", false), member("a.txt")],
      0,
    ],
    [
      "after the last listed member",
      [member("a.txt"), member("hidden.txt", false)],
      A_ENTRY_BYTES,
    ],
  ] as const)(
    "reports a local entry the central directory omits %s as unknown",
    async (_placement, members, first) => {
      const { paths, coverage } = await list(zip(members));
      expect(paths).toEqual(["a.txt"]);
      expect(coverage).toEqual([unaccounted(HIDDEN_ENTRY_BYTES, 1, first)]);
    },
  );

  it("reports a directory record past the end record's declared count as unknown", async () => {
    const { paths, coverage } = await list(
      zip([member("a.txt"), member("hidden.txt", false)], {
        trailingRecords: true,
      }),
    );
    expect(paths).toEqual(["a.txt"]);
    expect(coverage).toEqual([
      unaccounted(HIDDEN_ENTRY_BYTES, 1, A_ENTRY_BYTES),
    ]);
  });

  it("reports bytes prepended before the first member as unknown", async () => {
    const prefix = Buffer.from("#!/bin/sh\nexit 0\n");
    expect((await list(zip([member("a.txt")], { prefix }))).coverage).toEqual([
      unaccounted(prefix.length, 1, 0),
    ]);
  });

  it("accounts for a well-formed APK signing block before the directory", async () => {
    expect(
      (await list(zip([member("a.txt")], { gap: apkSigningBlock() }))).coverage,
    ).toEqual([complete]);
  });

  it("does not account for a block whose footer magic differs", async () => {
    const gap = apkSigningBlock("APK Sig Block 41");
    expect((await list(zip([member("a.txt")], { gap }))).coverage).toEqual([
      unaccounted(gap.length, 1, A_ENTRY_BYTES),
    ]);
  });

  it("does not hide an unlisted local entry inside malformed signing-block framing", async () => {
    const hidden = localEntry(member("hidden.txt", false));
    const size = BigInt(hidden.length + 24);
    const framing = Buffer.alloc(8);
    framing.writeBigUInt64LE(size);
    const block = Buffer.concat([
      framing,
      hidden,
      framing,
      Buffer.from("APK Sig Block 42"),
    ]);
    expect(
      (await list(zip([member("a.txt")], { gap: block }))).coverage,
    ).toEqual([unaccounted(block.length, 1, A_ENTRY_BYTES)]);
  });

  it("keeps an omitted local entry between listed members unknown in the artifact inventory", async () => {
    const directory = await createTestTempDirectory("rea-zip-member-region-");
    const path = join(directory, "fixture.zip");
    await writeFile(
      path,
      zip([member("a.txt"), member("hidden.txt", false), member("b.txt")]),
    );
    const reader = new ZipArtifactReader(path, "zip");
    try {
      const result = await scanReader(reader, [reader]);
      expect(result.occurrences.map((item) => item.logical_path)).toEqual([
        "a.txt",
        "b.txt",
      ]);
      expect(result.traversal).toEqual(
        unaccounted(HIDDEN_ENTRY_BYTES, 1, A_ENTRY_BYTES),
      );
    } finally {
      await reader.close();
    }
  });
});

const readBytes =
  (bytes: Uint8Array) =>
  async (at: number, length: number): Promise<Uint8Array> =>
    bytes.subarray(at, at + length);

describe("ZIP trailing alignment padding", () => {
  it("keeps a jar-like archive with no signing block and no gap complete", async () => {
    expect((await list(zip([member("a.txt")]))).coverage).toEqual([complete]);
  });

  it("accounts for all-zero alignment padding before an APK signing block", async () => {
    const padding = Buffer.alloc(694);
    const gap = Buffer.concat([padding, apkSigningBlock()]);
    const entry = member("a.txt");
    const local = localEntry(entry);
    const bytes = Buffer.concat([local, gap]);
    expect(
      await accountZipMemberRegion(
        [recordOf(entry, 0)],
        bytes.length,
        readBytes(bytes),
      ),
    ).toMatchObject({
      unaccountedBytes: 0,
      unaccountedRanges: 0,
      zeroPadding: { offset: local.length, length: padding.length },
    });
    expect((await list(zip([entry], { gap }))).coverage).toEqual([complete]);
  });

  it("accounts for all-zero alignment padding before the central directory", async () => {
    const padding = Buffer.alloc(16);
    const entry = member("a.txt");
    const local = localEntry(entry);
    const bytes = Buffer.concat([local, padding]);
    expect(
      await accountZipMemberRegion(
        [recordOf(entry, 0)],
        bytes.length,
        readBytes(bytes),
      ),
    ).toMatchObject({
      unaccountedBytes: 0,
      unaccountedRanges: 0,
      zeroPadding: { offset: local.length, length: padding.length },
    });
    expect((await list(zip([entry], { gap: padding }))).coverage).toEqual([
      complete,
    ]);
  });

  it("leaves a non-zero gap before an APK signing block unknown", async () => {
    const padding = Buffer.alloc(8);
    padding[3] = 1;
    const gap = Buffer.concat([padding, apkSigningBlock()]);
    expect((await list(zip([member("a.txt")], { gap }))).coverage).toEqual([
      unaccounted(padding.length, 1, A_ENTRY_BYTES),
    ]);
  });

  it("leaves a non-zero gap before the central directory unknown", async () => {
    const gap = Buffer.from([0, 0, 1, 0]);
    expect((await list(zip([member("a.txt")], { gap }))).coverage).toEqual([
      unaccounted(gap.length, 1, A_ENTRY_BYTES),
    ]);
  });

  it("accounts for zero padding after a data descriptor and before a signing block", async () => {
    const entry = member("a.txt");
    const local = localEntry(entry, 0x8);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc32(entry.data), 4);
    descriptor.writeUInt32LE(entry.data.length, 8);
    descriptor.writeUInt32LE(entry.data.length, 12);
    const padding = Buffer.alloc(12);
    const bytes = Buffer.concat([
      local,
      descriptor,
      padding,
      apkSigningBlock(),
    ]);
    expect(
      await accountZipMemberRegion(
        [{ ...recordOf(entry, 0), dataDescriptor: true }],
        bytes.length,
        readBytes(bytes),
      ),
    ).toMatchObject({
      unaccountedBytes: 0,
      unaccountedRanges: 0,
      unverifiedExtents: 0,
      zeroPadding: {
        offset: local.length + descriptor.length,
        length: padding.length,
      },
    });
  });

  it("accounts for all-zero padding larger than one read window", async () => {
    const entry = member("a.txt");
    const local = localEntry(entry);
    const padding = Buffer.alloc(64 * 1024 + 8);
    const bytes = Buffer.concat([local, padding, apkSigningBlock()]);
    expect(
      await accountZipMemberRegion(
        [recordOf(entry, 0)],
        bytes.length,
        readBytes(bytes),
      ),
    ).toMatchObject({
      unaccountedBytes: 0,
      unaccountedRanges: 0,
      zeroPadding: { offset: local.length, length: padding.length },
    });
  });
});

describe("ZIP gaps that stay unaccounted", () => {
  it("does not treat all-zero bytes between listed members as trailing padding", async () => {
    const first = member("a.txt");
    const second = member("b.txt");
    const localA = localEntry(first);
    const padding = Buffer.alloc(8);
    const localB = localEntry(second);
    const bytes = Buffer.concat([localA, padding, localB]);
    const account = await accountZipMemberRegion(
      [recordOf(first, 0), recordOf(second, localA.length + padding.length)],
      bytes.length,
      readBytes(bytes),
    );
    expect(account).toMatchObject({
      unaccountedBytes: padding.length,
      unaccountedRanges: 1,
      firstUnaccountedOffset: localA.length,
    });
    expect(account.zeroPadding).toBeUndefined();
  });

  it("does not treat a short read of a zero gap as padding", async () => {
    const entry = member("a.txt");
    const local = localEntry(entry);
    const bytes = Buffer.concat([local, Buffer.alloc(8)]);
    const account = await accountZipMemberRegion(
      [recordOf(entry, 0)],
      bytes.length,
      async (at, length) => bytes.subarray(at, at + Math.min(length, 4)),
    );
    expect(account).toMatchObject({
      unaccountedBytes: 8,
      unaccountedRanges: 1,
      firstUnaccountedOffset: local.length,
    });
    expect(account.zeroPadding).toBeUndefined();
  });

  it("does not treat a zero prefix of a non-zero gap as padding", async () => {
    const entry = member("a.txt");
    const local = localEntry(entry);
    const padding = Buffer.alloc(64 * 1024 + 8);
    padding[64 * 1024 + 2] = 0x20;
    const bytes = Buffer.concat([local, padding]);
    const account = await accountZipMemberRegion(
      [recordOf(entry, 0)],
      bytes.length,
      readBytes(bytes),
    );
    expect(account).toMatchObject({
      unaccountedBytes: padding.length,
      unaccountedRanges: 1,
      firstUnaccountedOffset: local.length,
    });
    expect(account.zeroPadding).toBeUndefined();
  });
});
