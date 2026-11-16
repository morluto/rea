import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32 } from "node:zlib";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import type { ArtifactReaderTraversal } from "../resources/ArtifactReader.js";
import { scanReader } from "./inventory/scanReader.js";
import { accountZipMemberRegion } from "../domain/zip/zipMemberRegion.js";
import { ZipArtifactReader } from "../resources/index.js";

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

const localEntry = ({ name, data }: Member): Buffer => {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
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
    const local = localEntry(first);
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
    const local = localEntry(first);
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
    const padded = Buffer.concat([bytes, Buffer.alloc(4)]);
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
    const bytes = Buffer.concat([localEntry(first), descriptor]);
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
    const local = localEntry(first);
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
      "between listed members",
      [member("a.txt"), member("hidden.txt", false), member("b.txt")],
      A_ENTRY_BYTES,
    ],
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
      expect(paths).not.toContain("hidden.txt");
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

  it("carries the unaccounted region into the artifact inventory", async () => {
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
