import {
  readFatContainerHeader,
  readMachoHeaderPrefixFacts,
} from "../../domain/apple/machoContainer.js";
import {
  readMachoLoadCommandTableHeader,
  MachoLoadCommandCursor,
} from "../../domain/apple/machoLoadCommands.js";
import type { FileHandle } from "node:fs/promises";

import {
  DEFAULT_BUN_READER_LIMITS,
  type BunReaderLimits,
} from "../../domain/artifactReaderLimits.js";
import { artifactReaderLimitFailure } from "../ArtifactReaderLimits.js";
import { abortIfNeeded } from "../ArtifactHash.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";

/** Exact trailer written by Bun's standalone module graph serializer. */
export const BUN_TRAILER = Buffer.from("\n---- Bun! ----\n");
export const BUN_TRAILER_BYTES = BUN_TRAILER.length;
export const BUN_OFFSETS_BYTES = 32;
export const BUN_GRAPH_SUFFIX_BYTES = BUN_OFFSETS_BYTES + BUN_TRAILER_BYTES;
/** Current compilers prefix a section with this little-endian payload length. */
export const BUN_LENGTH_PREFIX_BYTES = 8;
/** Bun 1.3.3 through 1.3.8 module records. */
export const BUN_RECORD_BYTES_1_3_3 = 36;
/** Bun 1.3.9 through at least 1.4.4 module records. */
export const BUN_RECORD_BYTES_1_3_9 = 52;

const MAX_PE_SECTIONS = 96;
const LC_SEGMENT = 0x1;
const LC_SEGMENT_64 = 0x19;
const SEGMENT_64_HEADER_BYTES = 72;
const SEGMENT_32_HEADER_BYTES = 56;
const SECTION_64_BYTES = 80;
const SECTION_32_BYTES = 68;

export const BUN_LAYOUT_REVISIONS = ["bun-1.3.3", "bun-1.3.9"] as const;
export type BunLayoutRevision = (typeof BUN_LAYOUT_REVISIONS)[number];
export const BUN_CARRIERS = [
  "mach-o-section",
  "pe-section",
  "elf-section",
  "appended-trailer",
] as const;
export type BunCarrier = (typeof BUN_CARRIERS)[number];

export interface BunStringPointer {
  readonly offset: number;
  readonly length: number;
}

/** Bounded metadata windows; the artifact reader streams stored member bodies. */
export interface BunGraphData {
  readonly length: number;
  read(offset: number, length: number): Promise<Buffer>;
}

/** One located graph payload. Pointers are relative to `data`. */
export interface LocatedBunGraph {
  readonly carrier: BunCarrier;
  readonly payloadOffset: number;
  readonly payloadLength: number;
  readonly data: BunGraphData;
  readonly modules: BunStringPointer;
  readonly entryPointId: number;
  readonly compileExecArgv: BunStringPointer;
  readonly flags: number;
}

/** A graph whose extent and suffix were validated without reading its data. */
export interface BunGraphClaim {
  readonly carrier: BunCarrier;
  readonly payloadOffset: number;
  readonly payloadLength: number;
}

export type BunStandaloneProbe =
  | { readonly status: "absent" }
  | { readonly status: "limited"; readonly failure: ArtifactReaderFailure }
  | {
      readonly status: "present";
      readonly claim: BunGraphClaim;
      readonly failure?: never;
    }
  | {
      readonly status: "present";
      readonly failure: ArtifactReaderFailure;
      readonly claim?: never;
    };

export type BunStandaloneRecognition =
  | { readonly status: "absent" }
  | { readonly status: "limited"; readonly failure: ArtifactReaderFailure }
  | {
      readonly status: "present";
      readonly graph: LocatedBunGraph;
      readonly failure?: never;
    }
  | {
      readonly status: "present";
      readonly failure: ArtifactReaderFailure;
      readonly graph?: never;
    };

interface BunProbeSource {
  readonly handle: FileHandle;
  readonly fileSize: number;
  readonly signal: AbortSignal | undefined;
  readonly limits: BunReaderLimits;
}

interface SectionWindow {
  readonly carrier: Exclude<BunCarrier, "appended-trailer">;
  readonly fileOffset: number;
  readonly declaredSize: number;
  readonly available: number;
  /** The declared section extent ends past EOF. */
  readonly truncated: boolean;
}

/**
 * Locate at most one graph claim with bounded reads of headers, length
 * prefixes, and suffixes. Payload data is not read. Multiple real claims are
 * an unsupported ambiguity.
 */
export const probeBunStandaloneGraph = async (
  handle: FileHandle,
  fileSize: number,
  signal?: AbortSignal,
  limits: BunReaderLimits = DEFAULT_BUN_READER_LIMITS,
): Promise<BunStandaloneProbe> => {
  abortIfNeeded(signal);
  const source = { handle, fileSize, signal, limits };
  let claims: readonly SectionWindow[];
  try {
    claims = [
      ...(await machOClaims(source, 0, fileSize)),
      ...(await peClaims(source)),
      ...(await elfClaims(source)),
    ];
  } catch (cause) {
    if (!(cause instanceof ArtifactReaderFailure) || cause.reason !== "limit")
      throw cause;
    return { status: "limited", failure: cause };
  }
  const real: BunStandaloneProbe[] = [];
  for (const claim of claims) {
    abortIfNeeded(signal);
    const evaluated = await evaluateSection(source, claim);
    if (evaluated.status === "present") {
      if (real.length > 0)
        return presentFailure(
          new ArtifactReaderFailure(
            "unavailable",
            "Bun standalone module graph layout is unsupported: multiple embedded graphs were located",
          ),
        );
      real.push(evaluated);
    }
  }
  const only = real[0];
  if (only !== undefined) return only;
  return evaluateAppendedTrailer(source);
};

/** Read a probed payload once and validate its suffix against the claim. */
export const loadBunStandaloneGraph = async (
  handle: FileHandle,
  claim: BunGraphClaim,
  signal?: AbortSignal,
  limits: BunReaderLimits = DEFAULT_BUN_READER_LIMITS,
): Promise<BunStandaloneRecognition> => {
  if (claim.payloadLength > limits.payload_bytes)
    return {
      status: "present",
      failure: bunPayloadBytesLimit(claim.payloadLength, limits),
    };
  const suffix = await readExact(
    handle,
    claim.payloadOffset + claim.payloadLength - BUN_GRAPH_SUFFIX_BYTES,
    BUN_GRAPH_SUFFIX_BYTES,
    signal,
  );
  const failure = suffixFailure(suffix, claim.payloadLength, limits);
  if (failure !== undefined) return { status: "present", failure };
  const offsets = suffix.subarray(0, BUN_OFFSETS_BYTES);
  return {
    status: "present",
    graph: {
      ...claim,
      data: new BunGraphRangeReader(
        handle,
        claim.payloadOffset,
        claim.payloadLength - BUN_GRAPH_SUFFIX_BYTES,
        signal,
        limits.metadata_read_bytes,
      ),
      modules: readPointer(offsets, 8),
      entryPointId: offsets.readUInt32LE(16),
      compileExecArgv: readPointer(offsets, 20),
      flags: offsets.readUInt32LE(28),
    },
  };
};

const METADATA_CACHE_BYTES = 256 * 1024;
const METADATA_CACHE_ENTRIES = 1024;

/** Exact-range caching avoids page amplification from file-controlled pointers. */
class BunGraphRangeReader implements BunGraphData {
  readonly #ranges = new Map<string, Buffer>();
  #retainedBytes = 0;
  #readBytes = 0;
  constructor(
    private readonly handle: FileHandle,
    private readonly start: number,
    readonly length: number,
    private readonly signal: AbortSignal | undefined,
    private readonly maximumReadBytes: number,
  ) {}

  async read(offset: number, length: number): Promise<Buffer> {
    abortIfNeeded(this.signal);
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > this.length ||
      length > this.length - offset
    )
      throw bunFormatFailure("metadata range exceeds the Bun module graph");
    if (length === 0) return Buffer.alloc(0);
    const key = `${String(offset)}:${String(length)}`;
    const existing = this.#ranges.get(key);
    if (existing !== undefined) {
      this.#ranges.delete(key);
      this.#ranges.set(key, existing);
      return Buffer.from(existing);
    }
    if (length > this.maximumReadBytes - this.#readBytes)
      throw artifactReaderLimitFailure(
        "artifact_limits.bun.metadata_read_bytes",
        this.maximumReadBytes,
        "bytes",
        this.#readBytes + length,
      );
    // Charge physical work before allocation or I/O, including uncached large names.
    this.#readBytes += length;
    const bytes = await readExact(
      this.handle,
      this.start + offset,
      length,
      this.signal,
    );
    if (length > METADATA_CACHE_BYTES) return bytes;
    while (
      this.#ranges.size >= METADATA_CACHE_ENTRIES ||
      this.#retainedBytes + length > METADATA_CACHE_BYTES
    ) {
      const oldest = this.#ranges.keys().next().value!;
      this.#retainedBytes -= this.#ranges.get(oldest)!.length;
      this.#ranges.delete(oldest);
    }
    this.#ranges.set(key, bytes);
    this.#retainedBytes += length;
    return Buffer.from(bytes);
  }
}

export const bunPayloadBytesLimit = (
  claimed: number | bigint,
  limits: BunReaderLimits = DEFAULT_BUN_READER_LIMITS,
): ArtifactReaderFailure =>
  artifactReaderLimitFailure(
    "artifact_limits.bun.payload_bytes",
    limits.payload_bytes,
    "bytes",
    claimed,
    "file-size",
  );
export const bunMetadataBytesLimit = (
  claimed: number,
  limits: BunReaderLimits = DEFAULT_BUN_READER_LIMITS,
): ArtifactReaderFailure =>
  artifactReaderLimitFailure(
    "artifact_limits.bun.representation_bytes",
    limits.representation_bytes,
    "bytes",
    claimed,
    "memory",
  );
export const bunModuleCountLimit = (
  count: number,
  limits: BunReaderLimits = DEFAULT_BUN_READER_LIMITS,
): ArtifactReaderFailure =>
  artifactReaderLimitFailure(
    "artifact_limits.bun.module_count",
    limits.module_count,
    "count",
    count,
  );

export const bunFormatFailure = (detail: string): ArtifactReaderFailure =>
  new ArtifactReaderFailure(
    "format",
    `Bun standalone module graph is malformed: ${detail}`,
  );

const presentFailure = (
  failure: ArtifactReaderFailure,
): BunStandaloneProbe => ({ status: "present", failure });

const evaluateSection = async (
  source: BunProbeSource,
  claim: SectionWindow,
): Promise<BunStandaloneProbe | { readonly status: "placeholder" }> => {
  const { handle, signal, limits } = source;
  if (claim.truncated)
    return presentFailure(
      bunFormatFailure("section extends past the end of the file"),
    );
  if (claim.available < BUN_LENGTH_PREFIX_BYTES)
    return presentFailure(bunFormatFailure("trailer is truncated"));
  const prefix = await readExact(
    handle,
    claim.fileOffset,
    BUN_LENGTH_PREFIX_BYTES,
    signal,
  );
  let prefixBytes = BUN_LENGTH_PREFIX_BYTES;
  let payloadLength = prefix.readBigUInt64LE(0);
  // Legacy Mach-O writers used a u32 length. Validate its suffix before
  // interpreting payload bytes as the upper half of a current u64 prefix.
  if (claim.carrier === "mach-o-section") {
    const legacyLength = prefix.readUInt32LE(0);
    if (
      legacyLength >= BUN_GRAPH_SUFFIX_BYTES &&
      legacyLength + 4 <= claim.available
    ) {
      const suffix = await readExact(
        handle,
        claim.fileOffset + 4 + legacyLength - BUN_GRAPH_SUFFIX_BYTES,
        BUN_GRAPH_SUFFIX_BYTES,
        signal,
      );
      if (
        suffix.subarray(BUN_OFFSETS_BYTES).equals(BUN_TRAILER) &&
        suffix.readBigUInt64LE(0) + BigInt(BUN_GRAPH_SUFFIX_BYTES) ===
          BigInt(legacyLength)
      ) {
        prefixBytes = 4;
        payloadLength = BigInt(legacyLength);
      }
    }
  }
  if (payloadLength === 0n) return { status: "placeholder" };
  if (payloadLength > BigInt(limits.payload_bytes))
    return presentFailure(bunPayloadBytesLimit(payloadLength, limits));
  if (payloadLength < BigInt(BUN_GRAPH_SUFFIX_BYTES))
    return presentFailure(bunFormatFailure("trailer is truncated"));
  const length = Number(payloadLength);
  if (claim.available < prefixBytes + length)
    return presentFailure(bunFormatFailure("trailer is truncated"));
  const payloadOffset = claim.fileOffset + prefixBytes;
  const suffix = await readExact(
    handle,
    payloadOffset + length - BUN_GRAPH_SUFFIX_BYTES,
    BUN_GRAPH_SUFFIX_BYTES,
    signal,
  );
  const failure = suffixFailure(suffix, length, limits);
  if (failure !== undefined) return presentFailure(failure);
  return {
    status: "present",
    claim: { carrier: claim.carrier, payloadOffset, payloadLength: length },
  };
};

/**
 * Older ELF builds append the graph at EOF without a named section. The
 * trailer has to be the exact final bytes; this does not scan backward.
 */
const evaluateAppendedTrailer = async (
  source: BunProbeSource,
): Promise<BunStandaloneProbe> => {
  const { handle, fileSize, signal, limits } = source;
  if (fileSize < BUN_GRAPH_SUFFIX_BYTES) return { status: "absent" };
  let graphEnd = fileSize;
  let trailer = await readExact(
    handle,
    graphEnd - BUN_TRAILER_BYTES,
    BUN_TRAILER_BYTES,
    signal,
  );
  if (!trailer.equals(BUN_TRAILER)) {
    if (fileSize < BUN_GRAPH_SUFFIX_BYTES + 8) return { status: "absent" };
    graphEnd -= 8;
    trailer = await readExact(
      handle,
      graphEnd - BUN_TRAILER_BYTES,
      BUN_TRAILER_BYTES,
      signal,
    );
    if (!trailer.equals(BUN_TRAILER)) return { status: "absent" };
    const length = await readExact(handle, graphEnd, 8, signal);
    if (length.readBigUInt64LE() !== BigInt(fileSize))
      return presentFailure(
        bunFormatFailure("appended carrier length does not match file size"),
      );
  }
  const offsets = await readExact(
    handle,
    graphEnd - BUN_GRAPH_SUFFIX_BYTES,
    BUN_OFFSETS_BYTES,
    signal,
  );
  const byteCount = offsets.readBigUInt64LE(0);
  if (byteCount + BigInt(BUN_GRAPH_SUFFIX_BYTES) > BigInt(limits.payload_bytes))
    return presentFailure(
      bunPayloadBytesLimit(byteCount + BigInt(BUN_GRAPH_SUFFIX_BYTES), limits),
    );
  const payloadLength = byteCount + BigInt(BUN_GRAPH_SUFFIX_BYTES);
  if (payloadLength > BigInt(graphEnd))
    return presentFailure(bunFormatFailure("trailer is truncated"));
  const length = Number(payloadLength);
  return {
    status: "present",
    claim: {
      carrier: "appended-trailer",
      payloadOffset: graphEnd - length,
      payloadLength: length,
    },
  };
};

/** Validate the Offsets and trailer that end a payload of `payloadLength` bytes. */
const suffixFailure = (
  suffix: Buffer,
  payloadLength: number,
  limits: BunReaderLimits,
): ArtifactReaderFailure | undefined => {
  if (suffix.length < BUN_GRAPH_SUFFIX_BYTES)
    return bunFormatFailure("trailer is truncated");
  if (!suffix.subarray(BUN_OFFSETS_BYTES).equals(BUN_TRAILER))
    return bunFormatFailure("trailer does not match the Bun sentinel");
  const byteCount = suffix.readBigUInt64LE(0);
  if (byteCount > BigInt(limits.payload_bytes))
    return bunPayloadBytesLimit(byteCount, limits);
  if (byteCount + BigInt(BUN_GRAPH_SUFFIX_BYTES) !== BigInt(payloadLength))
    return bunFormatFailure("byte_count does not match the located payload");
  return undefined;
};

export const readPointer = (
  bytes: Buffer,
  offset: number,
): BunStringPointer => ({
  offset: bytes.readUInt32LE(offset),
  length: bytes.readUInt32LE(offset + 4),
});

const machOClaims = async (
  source: BunProbeSource,
  imageOffset: number,
  imageLimit: number,
): Promise<readonly SectionWindow[]> => {
  const { handle, fileSize, signal, limits } = source;
  if (imageOffset < 0 || imageOffset >= fileSize) return [];
  const header = await tryRead(handle, imageOffset, 12, fileSize, signal);
  if (header === null || header.length < 4) return [];
  const facts = readMachoHeaderPrefixFacts(header);
  if (facts.identity === null)
    return imageOffset === 0 ? fatClaims(source, header) : [];
  const full = await tryRead(
    handle,
    imageOffset,
    Math.min(32, imageLimit),
    fileSize,
    signal,
  );
  if (full === null) return [];
  const parsed = readMachoLoadCommandTableHeader(full, imageLimit);
  if (!parsed.ok || parsed.value === null) return [];
  const table = parsed.value;
  const {
    littleEndian,
    headerSize: headerBytes,
    commandBytes: sizeofcmds,
  } = table;
  if (sizeofcmds > limits.recognition_load_command_bytes)
    throw artifactReaderLimitFailure(
      "artifact_limits.bun.recognition_load_command_bytes",
      limits.recognition_load_command_bytes,
      "bytes",
      sizeofcmds,
    );
  const commands = await tryRead(
    handle,
    imageOffset + headerBytes,
    sizeofcmds,
    Math.min(fileSize, imageOffset + imageLimit),
    signal,
  );
  if (commands === null || commands.length !== sizeofcmds) return [];
  const claims: SectionWindow[] = [];
  const cursor = new MachoLoadCommandCursor(table);
  while (cursor.nextOffset !== null) {
    abortIfNeeded(signal);
    const read = cursor.read(commands.subarray(cursor.nextOffset));
    if (!read.ok) break;
    const { command: cmd, offset, size } = read.value;
    if (cmd === LC_SEGMENT_64 || cmd === LC_SEGMENT)
      claims.push(
        ...segmentClaims(
          commands.subarray(offset, offset + size),
          littleEndian,
          cmd === LC_SEGMENT_64,
          imageOffset,
          Math.min(fileSize, imageOffset + imageLimit),
        ),
      );
  }
  return claims;
};

const segmentClaims = (
  command: Buffer,
  littleEndian: boolean,
  wide: boolean,
  imageOffset: number,
  fileSize: number,
): readonly SectionWindow[] => {
  const headerBytes = wide ? SEGMENT_64_HEADER_BYTES : SEGMENT_32_HEADER_BYTES;
  const sectionBytes = wide ? SECTION_64_BYTES : SECTION_32_BYTES;
  if (command.length < headerBytes) return [];
  const nsects = readU32(command, wide ? 64 : 48, littleEndian);
  if (headerBytes + nsects * sectionBytes > command.length) return [];
  const claims: SectionWindow[] = [];
  for (let index = 0; index < nsects; index += 1) {
    const start = headerBytes + index * sectionBytes;
    const section = command.subarray(start, start + sectionBytes);
    if (!exactName(section.subarray(0, 16), "__bun")) continue;
    if (!exactName(section.subarray(16, 32), "__BUN")) continue;
    const size = wide
      ? readBoundedU64(section, 40, littleEndian)
      : readU32(section, 36, littleEndian);
    const offset = readU32(section, wide ? 48 : 40, littleEndian);
    if (size === undefined) {
      claims.push({
        carrier: "mach-o-section",
        fileOffset: imageOffset + offset,
        declaredSize: Number.MAX_SAFE_INTEGER,
        available: 0,
        truncated: false,
      });
      continue;
    }
    claims.push(
      windowFor("mach-o-section", imageOffset + offset, size, fileSize),
    );
  }
  return claims;
};

const fatClaims = async (
  source: BunProbeSource,
  prefix: Buffer,
): Promise<readonly SectionWindow[]> => {
  const { handle, fileSize, signal } = source;
  let parsed = readFatContainerHeader(prefix, fileSize);
  if (parsed.state === "needs-data") {
    const table = await tryRead(
      handle,
      0,
      parsed.requiredBytes,
      fileSize,
      signal,
    );
    if (table === null) return [];
    parsed = readFatContainerHeader(table, fileSize);
  }
  if (parsed.state !== "parsed") return [];
  const claims: SectionWindow[] = [];
  for (const slice of parsed.slices) {
    abortIfNeeded(signal);
    if (parsed.rangeIssues[slice.index] !== null) continue;
    claims.push(...(await machOClaims(source, slice.offset, slice.size)));
  }
  return claims;
};

const peClaims = async (
  source: BunProbeSource,
): Promise<readonly SectionWindow[]> => {
  const { handle, fileSize, signal } = source;
  const dos = await tryRead(handle, 0, 64, fileSize, signal);
  if (dos === null || dos.length < 64 || dos[0] !== 0x4d || dos[1] !== 0x5a)
    return [];
  const eLfanew = dos.readUInt32LE(0x3c);
  if (eLfanew < 64 || eLfanew > fileSize - 24) return [];
  const pe = await tryRead(handle, eLfanew, 24, fileSize, signal);
  if (pe === null || !pe.subarray(0, 4).equals(Buffer.from("PE\0\0")))
    return [];
  const sectionCount = Math.min(pe.readUInt16LE(6), MAX_PE_SECTIONS);
  const optionalSize = pe.readUInt16LE(20);
  const tableOffset = eLfanew + 24 + optionalSize;
  const table = await tryRead(
    handle,
    tableOffset,
    sectionCount * 40,
    fileSize,
    signal,
  );
  if (table === null) return [];
  const claims: SectionWindow[] = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const start = index * 40;
    if (start + 40 > table.length) break;
    if (!exactName(table.subarray(start, start + 8), ".bun")) continue;
    const virtualSize = table.readUInt32LE(start + 8);
    const rawSize = table.readUInt32LE(start + 16);
    const rawPointer = table.readUInt32LE(start + 20);
    const declared = virtualSize === 0 ? rawSize : virtualSize;
    const readable = Math.min(declared, rawSize);
    claims.push(windowFor("pe-section", rawPointer, readable, fileSize));
  }
  return claims;
};

const elfClaims = async (
  source: BunProbeSource,
): Promise<readonly SectionWindow[]> => {
  const { handle, fileSize, signal, limits } = source;
  const header = await tryRead(handle, 0, 64, fileSize, signal);
  if (
    header === null ||
    header.length < 16 ||
    !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  )
    return [];
  const wide = header[4] === 2;
  if (header[4] !== 1 && header[4] !== 2) return [];
  if (header[5] !== 1 && header[5] !== 2) return [];
  const littleEndian = header[5] === 1;
  const shentsize = wide ? 64 : 40;
  const shoffOffset = wide ? 40 : 32;
  const shnumOffset = wide ? 60 : 48;
  const shstrndxOffset = wide ? 62 : 50;
  if (header.length < (wide ? 64 : 52)) return [];
  const observedShentsize = readU16(header, wide ? 58 : 46, littleEndian);
  if (observedShentsize !== 0 && observedShentsize !== shentsize) return [];
  const shoff = wide
    ? readBoundedU64(header, shoffOffset, littleEndian)
    : readU32(header, shoffOffset, littleEndian);
  const shnum = readU16(header, shnumOffset, littleEndian);
  const shstrndx = readU16(header, shstrndxOffset, littleEndian);
  // Unsupported extended numbering does not establish a Bun graph.
  if (
    shoff === undefined ||
    shoff === 0 ||
    shnum === 0 ||
    shnum === 0xffff ||
    shstrndx >= shnum
  )
    return [];
  if (shnum * shentsize > limits.recognition_table_bytes)
    throw artifactReaderLimitFailure(
      "artifact_limits.bun.recognition_table_bytes",
      limits.recognition_table_bytes,
      "bytes",
      shnum * shentsize,
    );
  const table = await tryRead(
    handle,
    shoff,
    shnum * shentsize,
    fileSize,
    signal,
  );
  if (table === null) return [];
  const strings = elfSectionBounds(table, shstrndx, wide, littleEndian);
  if (strings === null) return [];
  // A section name lookup needs only `.bun` and its terminator. Read the
  // referenced range, rather than treating a truncated string-table prefix as
  // evidence that later names are absent. Duplicate offsets share one lookup.
  const names = new Map<number, boolean>();
  const claims: SectionWindow[] = [];
  for (let index = 0; index < shnum; index += 1) {
    const bounds = elfSectionBounds(table, index, wide, littleEndian);
    if (bounds === null) continue;
    const nameOffset = readU32(table, index * shentsize, littleEndian);
    let isBun = names.get(nameOffset);
    if (isBun === undefined) {
      const name =
        nameOffset >= strings.size
          ? null
          : await tryRead(
              handle,
              strings.offset + nameOffset,
              Math.min(ELF_BUN_NAME.length + 1, strings.size - nameOffset),
              fileSize,
              signal,
            );
      isBun = name !== null && elfNameIsBun(name, 0);
      names.set(nameOffset, isBun);
    }
    if (!isBun) continue;
    claims.push(windowFor("elf-section", bounds.offset, bounds.size, fileSize));
  }
  return claims;
};

const elfSectionBounds = (
  table: Buffer,
  index: number,
  wide: boolean,
  littleEndian: boolean,
): { readonly offset: number; readonly size: number } | null => {
  const shentsize = wide ? 64 : 40;
  const start = index * shentsize;
  if (start + shentsize > table.length) return null;
  const offset = wide
    ? readBoundedU64(table, start + 24, littleEndian)
    : readU32(table, start + 16, littleEndian);
  const size = wide
    ? readBoundedU64(table, start + 32, littleEndian)
    : readU32(table, start + 20, littleEndian);
  if (offset === undefined || size === undefined) return null;
  return { offset, size };
};

const ELF_BUN_NAME = Buffer.from(".bun");

/**
 * Compare only `.bun` and its terminator. Many headers may share one long
 * name, so scanning each name to its NUL would repeat unbounded work.
 */
const elfNameIsBun = (table: Buffer, offset: number): boolean => {
  const end = offset + ELF_BUN_NAME.length;
  if (end > table.length) return false;
  if (end < table.length && table[end] !== 0) return false;
  return table.subarray(offset, end).equals(ELF_BUN_NAME);
};

const windowFor = (
  carrier: SectionWindow["carrier"],
  fileOffset: number,
  declaredSize: number,
  fileSize: number,
): SectionWindow => {
  if (
    !Number.isSafeInteger(fileOffset) ||
    fileOffset < 0 ||
    fileOffset >= fileSize
  )
    return {
      carrier,
      fileOffset,
      declaredSize,
      available: 0,
      truncated: false,
    };
  const room = fileSize - fileOffset;
  return {
    carrier,
    fileOffset,
    declaredSize,
    available: Math.min(declaredSize, room),
    truncated: declaredSize > room,
  };
};

const exactName = (bytes: Buffer, text: string): boolean => {
  const encoded = Buffer.alloc(bytes.length);
  encoded.write(text, "utf8");
  return encoded.equals(bytes);
};

const readBoundedU64 = (
  bytes: Buffer,
  offset: number,
  littleEndian: boolean,
): number | undefined => {
  if (offset < 0 || offset + 8 > bytes.length) return undefined;
  const value = littleEndian
    ? bytes.readBigUInt64LE(offset)
    : bytes.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(value);
};

const readU32 = (
  bytes: Buffer,
  offset: number,
  littleEndian: boolean,
): number =>
  littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);

const readU16 = (
  bytes: Buffer,
  offset: number,
  littleEndian: boolean,
): number =>
  littleEndian ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);

const tryRead = async (
  handle: FileHandle,
  position: number,
  length: number,
  fileSize: number,
  signal?: AbortSignal,
): Promise<Buffer | null> => {
  abortIfNeeded(signal);
  if (
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    position < 0 ||
    length === 0 ||
    position > fileSize ||
    fileSize - position < length
  )
    return length === 0 ? Buffer.alloc(0) : null;
  return readExact(handle, position, length, signal);
};

const readExact = async (
  handle: FileHandle,
  position: number,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    abortIfNeeded(signal);
    const read = await handle.read(
      bytes,
      offset,
      length - offset,
      position + offset,
    );
    abortIfNeeded(signal);
    if (read.bytesRead === 0) throw bunFormatFailure("trailer is truncated");
    offset += read.bytesRead;
  }
  return bytes;
};
