import { crc32, deflateSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";

const zlib = vi.hoisted(() => ({ inflated: 0 }));

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return {
    ...actual,
    inflateSync: (...args: Parameters<typeof actual.inflateSync>) => {
      zlib.inflated += 1;
      return actual.inflateSync(...args);
    },
  };
});

import {
  ELF_DEBUG_LINK_CANDIDATE_BUDGET_LIMITATION,
  inspectElfDebugLinkInputSchema,
} from "../../domain/native/elfDebugLink.js";
import {
  parseElfDebugLinkFromHandle,
  verifyElfDebugCandidate,
} from "./ElfDebugLink.js";
import {
  elfDebugCandidateFixture,
  elfDebugLinkByteSource,
  elfDebugLinkFixture,
} from "./ElfDebugLink.fixture.js";
import { BinaryFormatFailure } from "../../domain/binaryContainer.js";
import type { PrefixedByteSource } from "../../domain/byteSource.js";

const SHF_COMPRESSED = 0x800n;
const DECODED_NAME_BYTES = 1024 * 1024;

afterEach(() => {
  zlib.inflated = 0;
});

/**
 * Replace the trailing 64-bit little-endian `.shstrtab` with a compressed one
 * declaring 1 MiB; type 1 is zlib, anything else no decoder supports.
 */
const withCompressedNames = (bytes: Buffer, compressionType = 1): Buffer => {
  const shoff = Number(bytes.readBigUInt64LE(40));
  const shnum = bytes.readUInt16LE(60);
  const header = shoff + (shnum - 1) * 64;
  const namesOffset = Number(bytes.readBigUInt64LE(header + 24));
  const names = Buffer.alloc(DECODED_NAME_BYTES);
  bytes.copy(names, 0, namesOffset);
  const chdr = Buffer.alloc(24);
  chdr.writeUInt32LE(compressionType, 0);
  chdr.writeBigUInt64LE(BigInt(DECODED_NAME_BYTES), 8);
  chdr.writeBigUInt64LE(1n, 16);
  const table = Buffer.concat([chdr, deflateSync(names)]);
  const image = Buffer.concat([bytes.subarray(0, namesOffset), table]);
  image.writeBigUInt64LE(
    image.readBigUInt64LE(header + 8) | SHF_COMPRESSED,
    header + 8,
  );
  image.writeBigUInt64LE(BigInt(table.length), header + 32);
  return image;
};

const EXTENDED_SECTION_COUNT = 0xff00;

/**
 * Move the 64-bit little-endian section table to the end, padded with null
 * entries to an extended count that only section zero declares (e_shnum = 0).
 */
const withExtendedSectionCount = (bytes: Buffer): Buffer => {
  const shoff = Number(bytes.readBigUInt64LE(40));
  const shnum = bytes.readUInt16LE(60);
  const start = Math.ceil(bytes.length / 8) * 8;
  const table = Buffer.alloc(EXTENDED_SECTION_COUNT * 64);
  bytes.copy(table, 0, shoff, shoff + shnum * 64);
  table.writeBigUInt64LE(BigInt(EXTENDED_SECTION_COUNT), 32);
  const image = Buffer.concat([
    bytes,
    Buffer.alloc(start - bytes.length),
    table,
  ]);
  image.writeBigUInt64LE(BigInt(start), 40);
  image.writeUInt16LE(0, 60);
  return image;
};

const inputFor = (maxFileBytes: number) =>
  inspectElfDebugLinkInputSchema.parse({
    path: "/artifacts/prog",
    max_file_bytes: maxFileBytes,
  });

const parseImage = (
  image: Buffer,
  input: ReturnType<typeof inputFor>,
  readRange?: PrefixedByteSource["readRange"],
) =>
  parseElfDebugLinkFromHandle(
    elfDebugLinkByteSource(image, readRange),
    { path: input.path, sha256: "ab".repeat(32), bytes: image.length },
    input,
  );

const compareCandidate = (
  report: Awaited<ReturnType<typeof parseImage>>,
  candidate: Buffer,
  input: ReturnType<typeof inputFor>,
) =>
  verifyElfDebugCandidate(
    report,
    {
      path: "/artifacts/prog.debug",
      sha256: "cd".repeat(32),
      bytes: candidate.length,
      crc32: crc32(candidate),
      prefix: candidate,
    },
    input,
  );

it("reuses compressed section names beyond the retained prefix for build IDs", async () => {
  const template = withCompressedNames(elfDebugLinkFixture());
  const shoff = Number(template.readBigUInt64LE(40));
  const header = shoff + (template.readUInt16LE(60) - 1) * 64;
  const previousOffset = Number(template.readBigUInt64LE(header + 24));
  const table = template.subarray(previousOffset);
  const namesOffset = 8192;
  const image = Buffer.concat([
    template.subarray(0, previousOffset),
    Buffer.alloc(namesOffset - previousOffset),
    table,
  ]);
  image.writeBigUInt64LE(BigInt(namesOffset), header + 24);
  let tableReads = 0;
  const report = await parseImage(
    image,
    inputFor(image.length + DECODED_NAME_BYTES),
    async (offset, length) => {
      if (offset === namesOffset && length === table.length) tableReads++;
      return Buffer.from(image.subarray(offset, offset + length));
    },
  );
  expect(report.debuglink.status).toBe("present");
  expect(report.build_id.status).toBe("observed");
  expect(tableReads).toBe(1);
  expect(zlib.inflated).toBe(1);
});

it.each(["direct", "extended"] as const)(
  "checks the decoded image-name budget with a %s section count",
  async (encoding) => {
    const compressed = withCompressedNames(elfDebugLinkFixture());
    const image =
      encoding === "extended"
        ? withExtendedSectionCount(compressed)
        : compressed;
    const required = image.length + DECODED_NAME_BYTES;
    await expect(
      parseImage(image, inputFor(required - 1)),
    ).rejects.toMatchObject({
      failure: {
        kind: "limit",
        limit: {
          name: "max_file_bytes",
          maximum: required - 1,
          required: BigInt(required),
        },
      },
    });
    expect(zlib.inflated).toBe(0);
  },
);

it.each(["unbacked", "wrong type"] as const)(
  "validates a %s section-name table before charging its declared decoded size",
  async (fault) => {
    const image = withCompressedNames(elfDebugLinkFixture());
    const sectionTable = Number(image.readBigUInt64LE(40));
    const namesHeader = sectionTable + (image.readUInt16LE(60) - 1) * 64;
    if (fault === "unbacked")
      image.writeBigUInt64LE(
        image.readBigUInt64LE(namesHeader + 32) + 1n,
        namesHeader + 32,
      );
    else image.writeUInt32LE(1, namesHeader + 4);

    await expect(
      parseImage(image, inputFor(image.length + 1)),
    ).rejects.toBeInstanceOf(BinaryFormatFailure);
    expect(zlib.inflated).toBe(0);
  },
);

it.each(["direct", "extended"] as const)(
  "leaves over-budget candidate names undecoded with a %s section count",
  async (encoding) => {
    const compressed = withCompressedNames(elfDebugCandidateFixture());
    const candidate =
      encoding === "extended"
        ? withExtendedSectionCount(compressed)
        : compressed;
    const image = elfDebugLinkFixture();
    const input = inputFor(Math.max(image.length, candidate.length));
    const report = await parseImage(image, input);
    const verified = compareCandidate(report, candidate, input);
    expect(zlib.inflated).toBe(0);
    expect(verified).toMatchObject({
      candidate: {
        bytes: candidate.length,
        debug_info: "unknown",
        symtab: "unknown",
      },
      verification: {
        build_id: {
          status: "unavailable",
          reason: "candidate_build_id_unknown",
        },
      },
    });
    expect(verified.limitations).toContain(
      ELF_DEBUG_LINK_CANDIDATE_BUDGET_LIMITATION,
    );
  },
);

it("keeps the build-id of an image whose names use an unsupported compression above the budget", async () => {
  const image = withCompressedNames(elfDebugLinkFixture(), 0x7fff);
  const report = await parseImage(image, inputFor(image.length + 1));
  expect(zlib.inflated).toBe(0);
  expect(report.build_id.status).toBe("observed");
  expect(report.limitations.join("\n")).toContain(
    "compression type 32767 is unsupported",
  );
});

it("keeps the build-id of a candidate whose names use an unsupported compression above the budget", async () => {
  const candidate = withCompressedNames(elfDebugCandidateFixture(), 0x7fff);
  const image = elfDebugLinkFixture();
  const input = inputFor(Math.max(image.length, candidate.length));
  const report = await parseImage(image, input);
  const verified = compareCandidate(report, candidate, input);
  expect(zlib.inflated).toBe(0);
  expect(report.build_id.hex).not.toBeNull();
  expect(verified.verification?.build_id.candidate_hex).toBe(
    report.build_id.hex,
  );
  expect(verified.limitations).not.toContain(
    ELF_DEBUG_LINK_CANDIDATE_BUDGET_LIMITATION,
  );
});
