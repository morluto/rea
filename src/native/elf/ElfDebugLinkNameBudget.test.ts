import { deflateSync } from "node:zlib";
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

import { inspectElfDebugLinkInputSchema } from "../../domain/native/elfDebugLink.js";
import {
  gnuDebuglinkCrc32,
  parseElfDebugLink,
  verifyElfDebugCandidate,
} from "./ElfDebugLink.js";
import {
  elfDebugCandidateFixture,
  elfDebugLinkFixture,
} from "./ElfDebugLink.fixture.js";
import { ElfNoteSectionNameBudgetFailure } from "./ElfNoteParser.js";

const SHF_COMPRESSED = 0x800n;
const DECODED_NAME_BYTES = 1024 * 1024;

afterEach(() => {
  zlib.inflated = 0;
});

/** Replace the trailing 64-bit little-endian `.shstrtab` with a zlib one of 1 MiB. */
const withCompressedNames = (bytes: Buffer): Buffer => {
  const shoff = Number(bytes.readBigUInt64LE(40));
  const shnum = bytes.readUInt16LE(60);
  const header = shoff + (shnum - 1) * 64;
  const namesOffset = Number(bytes.readBigUInt64LE(header + 24));
  const names = Buffer.alloc(DECODED_NAME_BYTES);
  bytes.copy(names, 0, namesOffset);
  const chdr = Buffer.alloc(24);
  chdr.writeUInt32LE(1, 0);
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

const inputFor = (maxFileBytes: number) =>
  inspectElfDebugLinkInputSchema.parse({
    path: "/artifacts/prog",
    max_file_bytes: maxFileBytes,
  });

it("refuses compressed image names above the selected budget before inflating them", () => {
  const image = withCompressedNames(elfDebugLinkFixture());
  expect(() =>
    parseElfDebugLink(
      image,
      { path: "/artifacts/prog", sha256: "ab".repeat(32), bytes: image.length },
      inputFor(image.length + 1),
    ),
  ).toThrow(ElfNoteSectionNameBudgetFailure);
  expect(zlib.inflated).toBe(0);
});

it("leaves compressed candidate names above the selected budget undecoded", () => {
  const candidate = withCompressedNames(elfDebugCandidateFixture());
  const image = elfDebugLinkFixture();
  const input = inputFor(image.length + 1);
  const report = parseElfDebugLink(
    image,
    { path: "/artifacts/prog", sha256: "ab".repeat(32), bytes: image.length },
    input,
  );
  const verified = verifyElfDebugCandidate(
    report,
    {
      path: "/artifacts/prog.debug",
      sha256: "cd".repeat(32),
      bytes: candidate.length,
      crc32: gnuDebuglinkCrc32(candidate),
      prefix: candidate,
    },
    input,
  );
  expect(zlib.inflated).toBe(0);
  expect(verified.candidate).toMatchObject({
    debug_info: "unknown",
    symtab: "unknown",
  });
});

it("still decodes compressed names that fit the selected budget", () => {
  const image = withCompressedNames(elfDebugLinkFixture());
  const report = parseElfDebugLink(
    image,
    { path: "/artifacts/prog", sha256: "ab".repeat(32), bytes: image.length },
    inputFor(image.length + DECODED_NAME_BYTES),
  );
  expect(zlib.inflated).toBeGreaterThan(0);
  expect(report.debuglink.status).toBe("present");
});
