import {
  machoSectionCarrier,
  writeMachoName,
} from "../apple/MachoSectionCarrier.fixture.js";
import {
  uint32LE as u32,
  uint64LE as u64,
  write32,
  write64,
} from "../../native/BinaryInteger.fixture.js";
import { elfNote, elfNoteFixture } from "../../native/elf/ElfNotes.fixture.js";
import { peResourceFixture } from "../../domain/pe/peResources.fixture.js";

// https://github.com/denoland/deno/blob/v2.9.8/cli/lib/standalone/binary.rs
// declares this section marker.
export const DENO_FIXTURE_SECTION_MAGIC = Buffer.from("d3n0l4nd", "latin1");

export interface DenoSpecifierFixture {
  readonly text?: string;
  readonly bytes?: Buffer;
  readonly id: number;
}

export interface DenoRemoteFixture {
  readonly specifierId: number;
  readonly mediaType?: number;
  readonly data?: Buffer | string;
  readonly transpiled?: Buffer | string;
  readonly sourceMap?: Buffer | string;
  readonly cjs?: Buffer | string;
  readonly validUtf8?: boolean;
  readonly flags?: number;
}

export interface DenoSectionFixture {
  readonly metadata?: Record<string, unknown>;
  readonly metadataBytes?: Buffer;
  /** When set, the u64 length is this value instead of the metadata byte length. */
  readonly metadataLength?: number;
  readonly npmSnapshot?: Buffer;
  readonly specifiers?: readonly DenoSpecifierFixture[];
  /** Overrides the written specifier count and omits specifier records. */
  readonly specifierCount?: number;
  readonly redirects?: readonly {
    readonly from: number;
    readonly to: number;
  }[];
  readonly remoteModules?: readonly DenoRemoteFixture[];
  readonly vfs?: unknown;
  readonly vfsFileData?: Buffer;
  readonly openingMagic?: Buffer | null;
  readonly closingMagic?: Buffer | null;
  readonly trailing?: Buffer;
}

const u8 = (value: number): Buffer => Buffer.from([value]);

const asBytes = (value: Buffer | string): Buffer =>
  typeof value === "string" ? Buffer.from(value, "utf8") : value;

export const defaultDenoMetadata = (
  contentsLength = 0,
): Record<string, unknown> => ({
  argv: ["--quiet"],
  seed: 1,
  v8_flags: ["--stack-size=1000"],
  permissions: { allow_read: true },
  unstable_config: { features: [] },
  entrypoint_key: "main.ts",
  env_vars_from_env_file: {},
  ca_data: null,
  vfs_case_sensitivity: "s",
  app_name: "sample",
  extra_ignored: contentsLength,
});

/** Build the documented `d3n0l4nd` section without a native carrier. */
export const buildDenoSection = (options: DenoSectionFixture = {}): Buffer => {
  const metadataBytes =
    options.metadataBytes ??
    Buffer.from(
      JSON.stringify(options.metadata ?? defaultDenoMetadata()),
      "utf8",
    );
  const npm = options.npmSnapshot ?? Buffer.alloc(0);
  const specifiers = options.specifiers ?? [{ text: "file:///main.ts", id: 0 }];
  const redirects = options.redirects ?? [];
  const remoteModules = options.remoteModules ?? [];
  const contents = options.vfsFileData ?? Buffer.from("console.log('deno')\n");
  const vfs = options.vfs ?? [
    { File: { n: "main.ts", o: [0, contents.length], u: true } },
  ];
  const vfsBytes = Buffer.from(JSON.stringify(vfs), "utf8");
  const parts: Buffer[] = [];
  if (options.openingMagic !== null)
    parts.push(options.openingMagic ?? DENO_FIXTURE_SECTION_MAGIC);
  parts.push(
    u64(options.metadataLength ?? metadataBytes.length),
    metadataBytes,
    u64(npm.length),
    npm,
    u32(options.specifierCount ?? specifiers.length),
  );
  if (options.specifierCount === undefined)
    for (const specifier of specifiers) {
      const text = specifier.bytes ?? Buffer.from(specifier.text ?? "", "utf8");
      parts.push(u32(text.length), text, u32(specifier.id));
    }
  parts.push(u32(redirects.length));
  for (const redirect of redirects)
    parts.push(u32(redirect.from), u32(redirect.to));
  parts.push(u32(remoteModules.length));
  for (const remote of remoteModules) {
    const data = asBytes(remote.data ?? "");
    let flags = remote.flags ?? 0;
    const extras: Buffer[] = [];
    if (remote.validUtf8 === true) flags |= 1 << 3;
    if (remote.transpiled !== undefined) {
      flags |= 1 << 0;
      extras.push(asBytes(remote.transpiled));
    }
    if (remote.sourceMap !== undefined) {
      flags |= 1 << 1;
      extras.push(asBytes(remote.sourceMap));
    }
    if (remote.cjs !== undefined) {
      flags |= 1 << 2;
      extras.push(asBytes(remote.cjs));
    }
    parts.push(
      u32(remote.specifierId),
      u8(remote.mediaType ?? 4),
      u32(data.length),
      data,
      u8(flags),
    );
    for (const extra of extras) parts.push(u32(extra.length), extra);
  }
  parts.push(u64(vfsBytes.length), vfsBytes, u64(contents.length), contents);
  if (options.closingMagic !== null)
    parts.push(options.closingMagic ?? DENO_FIXTURE_SECTION_MAGIC);
  if (options.trailing !== undefined) parts.push(options.trailing);
  return Buffer.concat(parts);
};

export interface DenoMachOOptions {
  readonly architecture?: "arm64" | "x64";
  readonly bits?: 32 | 64;
  readonly littleEndian?: boolean;
}

/** Thin Mach-O with zero or more `__SUI,d3n0l4nd` sections. */
export const denoMachO = (
  section: Buffer | readonly Buffer[] = buildDenoSection(),
  options: DenoMachOOptions = {},
): Buffer => {
  const blobs = Array.isArray(section) ? [...section] : [section];
  const little = options.littleEndian ?? true;
  const wide = (options.bits ?? 64) === 64;
  return machoSectionCarrier(blobs, {
    wide,
    little,
    cpuType:
      options.architecture === "x64" ? 0x01000007 : wide ? 0x0100000c : 7,
    segmentName: "__SUI",
    sectionName: "d3n0l4nd",
    maxProtection: 0,
    initialProtection: 0,
  });
};

/** x86_64 Mach-O with no `__SUI` section and a libsui Intel trailer. */
export const denoIntelTrailer = (
  section: Buffer = buildDenoSection(),
): Buffer => {
  const image = thinMachOWithoutDenoSection();
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(section.length));
  return Buffer.concat([
    image,
    Buffer.from("<~sui-data~>", "latin1"),
    Buffer.from([0xef, 0xbe, 0xad, 0xde]),
    length,
    section,
  ]);
};

/**
 * x86_64 Mach-O with one segment, named `segment`, whose file range is
 * exactly `contents`.
 */
export const machOWithSegment = (segment: string, contents: Buffer): Buffer => {
  const little = true;
  const headerSize = 32;
  const segmentHeader = 72;
  const contentsAt = headerSize + segmentHeader;
  const image = Buffer.alloc(contentsAt + contents.length);
  write32(image, 0, 0xfeedfacf, little);
  write32(image, 4, 0x01000007, little);
  write32(image, 12, 2, little);
  write32(image, 16, 1, little);
  write32(image, 20, segmentHeader, little);
  write32(image, headerSize, 0x19, little);
  write32(image, headerSize + 4, segmentHeader, little);
  writeMachoName(image, headerSize + 8, segment);
  write64(image, headerSize + 32, contents.length, little);
  write64(image, headerSize + 40, contentsAt, little);
  write64(image, headerSize + 48, contents.length, little);
  contents.copy(image, contentsAt);
  return image;
};

/** One FAT slice around a thin arm64 Deno image. */
export const denoUniversal = (
  slices: readonly Buffer[] = [denoMachO()],
): Buffer => {
  const header = 8 + slices.length * 20;
  const aligned = Math.ceil(header / 4096) * 4096 || 4096;
  let cursor = aligned;
  const placed = slices.map((slice) => {
    const offset = cursor;
    cursor += slice.length;
    return { slice, offset };
  });
  const fat = Buffer.alloc(cursor);
  fat.writeUInt32BE(0xcafebabe, 0);
  fat.writeUInt32BE(slices.length, 4);
  placed.forEach(({ slice, offset }, index) => {
    const at = 8 + index * 20;
    fat.writeUInt32BE(0x0100000c, at);
    fat.writeUInt32BE(offset, at + 8);
    fat.writeUInt32BE(slice.length, at + 12);
    fat.writeUInt32BE(12, at + 16);
    slice.copy(fat, offset);
  });
  return fat;
};

export const denoElf = (section: Buffer = buildDenoSection()): Buffer => {
  const nameLength = Buffer.alloc(2);
  nameLength.writeUInt16LE("d3n0l4nd".length);
  return elfNoteFixture({
    notes: elfNote(
      "SUI",
      0x53554901,
      Buffer.concat([nameLength, Buffer.from("d3n0l4nd", "latin1"), section]),
    ),
    ownership: "program",
    type: 2,
  });
};

export const denoPe = (
  sections: readonly Buffer[] = [buildDenoSection()],
): Buffer =>
  peResourceFixture(
    true,
    sections.map((payload, index) => ({
      type: 10,
      name: "D3N0L4ND",
      language: index,
      payload,
    })),
    Math.max(
      65536,
      sections.reduce((sum, payload) => sum + payload.length, 0) + 4096,
    ),
  ).bytes;

const thinMachOWithoutDenoSection = (): Buffer => {
  const little = true;
  const headerSize = 32;
  const segmentHeader = 72;
  const image = Buffer.alloc(headerSize + segmentHeader);
  write32(image, 0, 0xfeedfacf, little);
  write32(image, 4, 0x01000007, little);
  // CPU_SUBTYPE_X86_64_ALL, so a FAT row can state this slice exactly.
  write32(image, 8, 3, little);
  write32(image, 12, 2, little);
  write32(image, 16, 1, little);
  write32(image, 20, segmentHeader, little);
  write32(image, headerSize, 0x19, little);
  write32(image, headerSize + 4, segmentHeader, little);
  writeMachoName(image, headerSize + 8, "__TEXT");
  return image;
};
