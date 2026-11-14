import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32 } from "node:zlib";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import type { ArtifactReaderTraversal } from "./ArtifactReader.js";
import { scanReader } from "./inventory/scanReader.js";
import { ZipArtifactReader } from "./ZipArtifactReader.js";

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
