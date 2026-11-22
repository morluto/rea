import { LC } from "../../domain/apple/machoLoadCommandCodes.js";
import { Budget } from "../../domain/budget.js";
import {
  BinaryReader,
  declaredFileRange,
} from "../../domain/binaryContainer.js";
import { err, ok, type Result } from "../../domain/result.js";
import { parseMzHeaderEvidence } from "../../domain/dosMz.js";
import {
  observePeCoffFrame,
  PE_COFF_FRAME_BYTES,
} from "../../domain/peCoffHeader.js";
import {
  PE_SECTION_HEADER_BYTES,
  peSectionTableExtent,
  readPeSectionHeader,
} from "../../domain/peSectionHeader.js";
import { readElfHeaderFacts } from "../../domain/elfFixedHeader.js";
import { readElfRawTableDeclarations } from "../../domain/elfRawTableDeclarations.js";
import {
  elfSectionHeaderWidth,
  readElfSectionHeader,
} from "../../domain/elfSectionHeader.js";
import { observeElfStringTableEntry } from "../../domain/elfStringTable.js";
import {
  readFatContainerHeader,
  readMachoHeaderPrefixFacts,
  validateFatSliceIdentity,
  type FatSliceDeclaration,
} from "../../domain/apple/machoContainer.js";
import {
  readMachoLoadCommandTableHeader,
  MachoLoadCommandCursor,
} from "../../domain/apple/machoLoadCommands.js";
import {
  machoSectionBacking,
  machoSectionHeaderSize,
  readMachoSectionHeader,
} from "../../domain/apple/machoSectionHeader.js";
import {
  admitMachoSegmentCommand,
  machoSegmentSectionTableFits,
  readMachoSegmentHeader,
} from "../../domain/apple/machoSegmentHeader.js";
import type { FileHandle } from "node:fs/promises";

import {
  DEFAULT_BUN_READER_LIMITS,
  type BunReaderLimits,
} from "../../domain/artifactReaderLimits.js";
import {
  ArtifactReaderFailure,
  abortIfNeeded,
  artifactReaderLimitFailure,
} from "../../resources/index.js";

/** Exact trailer written by Bun's standalone module graph serializer. */
const BUN_TRAILER = Buffer.from("\n---- Bun! ----\n");
const BUN_TRAILER_BYTES = BUN_TRAILER.length;
const BUN_OFFSETS_BYTES = 32;
const BUN_GRAPH_SUFFIX_BYTES = BUN_OFFSETS_BYTES + BUN_TRAILER_BYTES;
/** Current compilers prefix a section with this little-endian payload length. */
export const BUN_LENGTH_PREFIX_BYTES = 8;
/** Bun 1.3.3 through 1.3.8 module records. */
export const BUN_RECORD_BYTES_1_3_3 = 36;
/** Bun 1.3.9 through at least 1.4.4 module records. */
export const BUN_RECORD_BYTES_1_3_9 = 52;

const MAX_PE_SECTIONS = 96;

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
  readonly available: number;
  /** The declared section extent ends past EOF. */
  readonly truncated: boolean;
  /** The Mach-O table could not be fully framed after this section was located. */
  readonly loadCommandsFailure?: string;
}

type SectionClaim = SectionWindow | { readonly failure: ArtifactReaderFailure };

/** A rejected slice has no authority over any embedded graph at its offsets. */
interface RejectedFatSlice {
  readonly rejectedSlice: FatSliceDeclaration;
  /** Only set when the bounded command metadata actually names a Bun slot. */
  readonly namedFailure?: ArtifactReaderFailure;
}

type SectionObservation = SectionClaim | RejectedFatSlice;

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
  let claims: readonly SectionObservation[];
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
  const rejectedSlices: FatSliceDeclaration[] = [];
  let fatIdentityFailure: ArtifactReaderFailure | undefined;
  for (const claim of claims) {
    abortIfNeeded(signal);
    if ("rejectedSlice" in claim) {
      rejectedSlices.push(claim.rejectedSlice);
      fatIdentityFailure ??= claim.namedFailure;
      continue;
    }
    const evaluated =
      "failure" in claim
        ? presentFailure(claim.failure)
        : await evaluateSection(source, claim);
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
  const appended = await evaluateAppendedTrailer(source, rejectedSlices);
  return appended.status === "absent" && fatIdentityFailure !== undefined
    ? presentFailure(fatIdentityFailure)
    : appended;
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
  const parsed = readBunSuffix(suffix, claim.payloadLength);
  if (!parsed.ok) return { status: "present", failure: parsed.error };
  const offsets = parsed.value;
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
      entryPointId: offsets.u32(16),
      compileExecArgv: readPointer(offsets, 20),
      flags: offsets.u32(28),
    },
  };
};

const METADATA_CACHE_BYTES = 256 * 1024;
const METADATA_CACHE_ENTRIES = 1024;

/** Exact-range caching avoids page amplification from file-controlled pointers. */
class BunGraphRangeReader implements BunGraphData {
  readonly #ranges = new Map<string, Buffer>();
  readonly #retained = new Budget(METADATA_CACHE_BYTES);
  readonly #read: Budget;
  constructor(
    private readonly handle: FileHandle,
    private readonly start: number,
    readonly length: number,
    private readonly signal: AbortSignal | undefined,
    maximumReadBytes: number,
  ) {
    this.#read = new Budget(maximumReadBytes);
  }

  /** Drop the least recently used range and return its retained size. */
  readonly #evictOldest = (): number | undefined => {
    const oldest = this.#ranges.keys().next();
    if (oldest.done === true) return undefined;
    const bytes = this.#ranges.get(oldest.value)?.length ?? 0;
    this.#ranges.delete(oldest.value);
    return bytes;
  };

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
    // Charge physical work before allocation or I/O, including uncached large names.
    this.#read.charge(length, () =>
      artifactReaderLimitFailure(
        "artifact_limits.bun.metadata_read_bytes",
        this.#read.maximum,
        "bytes",
        this.#read.used + length,
      ),
    );
    const bytes = await readExact(
      this.handle,
      this.start + offset,
      length,
      this.signal,
    );
    if (length > METADATA_CACHE_BYTES) return bytes;
    while (this.#ranges.size >= METADATA_CACHE_ENTRIES)
      this.#retained.refund(this.#evictOldest() ?? 0);
    if (!this.#retained.chargeEvicting(length, this.#evictOldest)) return bytes;
    this.#ranges.set(key, bytes);
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
  const prefix = new BinaryReader(
    await readExact(handle, claim.fileOffset, BUN_LENGTH_PREFIX_BYTES, signal),
    true,
    "bun-standalone",
  );
  let prefixBytes = BUN_LENGTH_PREFIX_BYTES;
  let payloadLength = prefix.word(0, 64);
  // Legacy Mach-O writers used a u32 length. Validate its suffix before
  // interpreting payload bytes as the upper half of a current u64 prefix.
  if (claim.carrier === "mach-o-section") {
    const legacyLength = prefix.u32(0);
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
      if (readBunSuffix(suffix, legacyLength).ok) {
        prefixBytes = 4;
        payloadLength = BigInt(legacyLength);
      }
    }
  }
  if (payloadLength === 0n) return { status: "placeholder" };
  if (
    payloadLength < BigInt(BUN_GRAPH_SUFFIX_BYTES) ||
    payloadLength > BigInt(claim.available - prefixBytes)
  )
    return presentFailure(bunFormatFailure("trailer is truncated"));
  const length = Number(payloadLength);
  const payloadOffset = claim.fileOffset + prefixBytes;
  // The legacy width is selected only after its suffix has been validated.
  if (prefixBytes === BUN_LENGTH_PREFIX_BYTES) {
    const suffix = await readExact(
      handle,
      payloadOffset + length - BUN_GRAPH_SUFFIX_BYTES,
      BUN_GRAPH_SUFFIX_BYTES,
      signal,
    );
    const parsed = readBunSuffix(suffix, length);
    if (!parsed.ok) return presentFailure(parsed.error);
  }
  if (claim.loadCommandsFailure !== undefined)
    return presentFailure(
      bunFormatFailure(`Mach-O load commands: ${claim.loadCommandsFailure}`),
    );
  if (payloadLength > BigInt(limits.payload_bytes))
    return presentFailure(bunPayloadBytesLimit(payloadLength, limits));
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
  rejectedSlices: readonly FatSliceDeclaration[],
): Promise<BunStandaloneProbe> => {
  const { handle, fileSize, signal, limits } = source;
  const outsideRejectedSlices = (start: number, end: number): boolean =>
    !rejectedSlices.some(
      (slice) => start < slice.offset + slice.size && slice.offset < end,
    );
  const readTrailer = async (end: number): Promise<Buffer | null> =>
    outsideRejectedSlices(end - BUN_GRAPH_SUFFIX_BYTES, fileSize)
      ? readExact(handle, end - BUN_TRAILER_BYTES, BUN_TRAILER_BYTES, signal)
      : null;
  if (fileSize < BUN_GRAPH_SUFFIX_BYTES) return { status: "absent" };
  let graphEnd = fileSize;
  let trailer = await readTrailer(graphEnd);
  if (!trailer?.equals(BUN_TRAILER)) {
    if (fileSize < BUN_GRAPH_SUFFIX_BYTES + 8) return { status: "absent" };
    graphEnd -= 8;
    trailer = await readTrailer(graphEnd);
    if (!trailer?.equals(BUN_TRAILER)) return { status: "absent" };
    const length = await readExact(handle, graphEnd, 8, signal);
    if (
      new BinaryReader(length, true, "bun-standalone").word(0, 64) !==
      BigInt(fileSize)
    )
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
  const payloadLength = graphPayloadLength(
    new BinaryReader(offsets, true, "bun-standalone"),
  );
  const payloadStart = BigInt(graphEnd) - payloadLength;
  if (
    !outsideRejectedSlices(
      payloadStart < 0n ? 0 : Number(payloadStart),
      graphEnd,
    )
  )
    return { status: "absent" };
  if (payloadStart < 0n)
    return presentFailure(bunFormatFailure("trailer is truncated"));
  if (payloadLength > BigInt(limits.payload_bytes))
    return presentFailure(bunPayloadBytesLimit(payloadLength, limits));
  return {
    status: "present",
    claim: {
      carrier: "appended-trailer",
      payloadOffset: Number(payloadStart),
      payloadLength: Number(payloadLength),
    },
  };
};

const graphPayloadLength = (offsets: BinaryReader): bigint =>
  offsets.word(0, 64) + BigInt(BUN_GRAPH_SUFFIX_BYTES);

/** Validate framing before exposing the Offsets record at the end of a graph. */
const readBunSuffix = (
  suffix: Buffer,
  payloadLength: number,
): Result<BinaryReader, ArtifactReaderFailure> => {
  if (suffix.length < BUN_GRAPH_SUFFIX_BYTES)
    return err(bunFormatFailure("trailer is truncated"));
  if (!suffix.subarray(BUN_OFFSETS_BYTES).equals(BUN_TRAILER))
    return err(bunFormatFailure("trailer does not match the Bun sentinel"));
  const offsets = new BinaryReader(
    suffix.subarray(0, BUN_OFFSETS_BYTES),
    true,
    "bun-standalone",
  );
  if (graphPayloadLength(offsets) !== BigInt(payloadLength))
    return err(
      bunFormatFailure("byte_count does not match the located payload"),
    );
  return ok(offsets);
};

export const readPointer = (
  reader: BinaryReader,
  offset: number,
): BunStringPointer => ({
  offset: reader.u32(offset),
  length: reader.u32(offset + 4),
});

const machOClaims = async (
  source: BunProbeSource,
  imageOffset: number,
  imageLimit: number,
  fat?: FatSliceDeclaration,
): Promise<readonly SectionObservation[]> => {
  const { handle, fileSize, signal, limits } = source;
  if (imageOffset < 0 || imageOffset >= fileSize) return [];
  const imageSize = Math.min(fileSize - imageOffset, imageLimit);
  const imageEnd = imageOffset + imageSize;
  const header = await tryRead(handle, imageOffset, 12, imageEnd, signal);
  if (header === null || header.length < 4) return [];
  const facts = readMachoHeaderPrefixFacts(header);
  if (facts.identity === null)
    return imageOffset === 0 ? fatClaims(source, header) : [];
  const identityIssue =
    fat === undefined ? null : validateFatSliceIdentity(fat, facts.identity);
  const rejected: readonly RejectedFatSlice[] =
    fat !== undefined && identityIssue !== null ? [{ rejectedSlice: fat }] : [];
  const full = await tryRead(
    handle,
    imageOffset,
    Math.min(32, imageSize),
    imageEnd,
    signal,
  );
  if (full === null) return rejected;
  const parsed = readMachoLoadCommandTableHeader(full, imageSize);
  if (!parsed.ok || parsed.value === null) return rejected;
  const table = parsed.value;
  const {
    littleEndian,
    headerSize: headerBytes,
    commandBytes: sizeofcmds,
  } = table;
  if (sizeofcmds > limits.recognition_load_command_bytes) {
    if (identityIssue !== null) return rejected;
    throw artifactReaderLimitFailure(
      "artifact_limits.bun.recognition_load_command_bytes",
      limits.recognition_load_command_bytes,
      "bytes",
      sizeofcmds,
    );
  }
  const commands = await tryRead(
    handle,
    imageOffset + headerBytes,
    sizeofcmds,
    imageEnd,
    signal,
  );
  if (commands === null || commands.length !== sizeofcmds) return rejected;
  const claims: SectionClaim[] = [];
  const cursor = new MachoLoadCommandCursor(table);
  let framingFailure: string | undefined;
  while (cursor.nextOffset !== null) {
    abortIfNeeded(signal);
    const read = cursor.read(commands.subarray(cursor.nextOffset));
    if (!read.ok) {
      framingFailure = read.error;
      break;
    }
    const { command: cmd, offset, size } = read.value;
    if (cmd === LC.SEGMENT_64 || cmd === LC.SEGMENT)
      for (const claim of segmentClaims(
        commands.subarray(offset, offset + size),
        littleEndian,
        cmd === LC.SEGMENT_64,
        imageOffset,
        imageSize,
      )) {
        // A mismatched slice can identify a named declaration from bounded
        // metadata, but cannot contribute graph bytes or veto another slice.
        if (fat !== undefined && identityIssue !== null)
          return [
            {
              rejectedSlice: fat,
              namedFailure: bunFormatFailure(identityIssue),
            },
          ];
        claims.push(claim);
      }
  }
  if (rejected.length !== 0) return rejected;
  const complete = cursor.finish();
  if (!complete.ok) framingFailure ??= complete.error;
  return framingFailure === undefined
    ? claims
    : claims.map((claim) =>
        "failure" in claim
          ? claim
          : { ...claim, loadCommandsFailure: framingFailure },
      );
};

const segmentClaims = (
  command: Buffer,
  littleEndian: boolean,
  wide: boolean,
  imageOffset: number,
  imageSize: number,
): readonly SectionClaim[] => {
  const parsedSegment = readMachoSegmentHeader(command, wide, littleEndian);
  if (!parsedSegment.ok) return [];
  const segment = parsedSegment.value;
  const { headerSize, sectionCount } = segment;
  const sectionBytes = machoSectionHeaderSize(wide);
  if (!machoSegmentSectionTableFits(segment, command.length, wide)) return [];
  const admission = admitMachoSegmentCommand(
    segment,
    command.length,
    wide ? 64 : 32,
    imageSize,
  );
  const claims: SectionClaim[] = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const start = headerSize + index * sectionBytes;
    const bytes = command.subarray(start, start + sectionBytes);
    if (!exactName(bytes.subarray(0, 16), "__bun")) continue;
    if (!exactName(bytes.subarray(16, 32), "__BUN")) continue;
    const parsedSection = readMachoSectionHeader(bytes, wide, littleEndian);
    if (!parsedSection.ok) continue;
    const section = parsedSection.value;
    const { issue } = machoSectionBacking(section, segment);
    if (issue !== null) {
      claims.push({
        failure: bunFormatFailure(`Mach-O __bun section ${issue}`),
      });
      continue;
    }
    if (section.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      claims.push({
        failure: bunFormatFailure(
          "Mach-O __bun section size is not a safe integer",
        ),
      });
      continue;
    }
    const window = windowFor(
      "mach-o-section",
      imageOffset + section.offset,
      Number(section.size),
      imageOffset + imageSize,
    );
    // A named section with a missing tail already carries its own failure.
    if (admission.ok || window.truncated) claims.push(window);
    else claims.push({ failure: bunFormatFailure(admission.error.message) });
  }
  return claims;
};

const fatClaims = async (
  source: BunProbeSource,
  prefix: Buffer,
): Promise<readonly SectionObservation[]> => {
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
  const claims: SectionObservation[] = [];
  for (const slice of parsed.slices) {
    abortIfNeeded(signal);
    if (parsed.rangeIssues[slice.index] !== null) continue;
    for (const claim of await machOClaims(
      source,
      slice.offset,
      slice.size,
      slice,
    ))
      claims.push(claim);
  }
  return claims;
};

const peClaims = async (
  source: BunProbeSource,
): Promise<readonly SectionWindow[]> => {
  const { handle, fileSize, signal } = source;
  const dos = await tryRead(handle, 0, 64, fileSize, signal);
  if (dos === null || dos[0] !== 0x4d || dos[1] !== 0x5a) return [];
  const probe = observePeCoffFrame(
    dos,
    fileSize,
    parseMzHeaderEvidence(dos, fileSize),
  );
  let frame = probe.next();
  while (!frame.done) {
    const { offset, size } = frame.value;
    const bytes = await tryRead(handle, offset, size, fileSize, signal);
    if (bytes === null) return [];
    frame = probe.next(bytes);
  }
  const header = frame.value;
  if (
    header.kind !== "pe" ||
    header.observation.offset < dos.length ||
    !header.coff.ok
  )
    return [];

  const sectionCount = Math.min(
    header.coff.value.sectionCount,
    MAX_PE_SECTIONS,
  );
  const { sectionTableOffset, sectionTableBytes } = peSectionTableExtent(
    header.observation.offset + PE_COFF_FRAME_BYTES,
    header.coff.value.optionalHeaderSize,
    sectionCount,
  );
  const table = await tryRead(
    handle,
    sectionTableOffset,
    sectionTableBytes,
    fileSize,
    signal,
  );
  if (table === null) return [];
  const claims: SectionWindow[] = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const start = index * PE_SECTION_HEADER_BYTES;
    const entry = table.subarray(start, start + PE_SECTION_HEADER_BYTES);
    if (!exactName(entry.subarray(0, 8), ".bun")) continue;
    const parsed = readPeSectionHeader(entry);
    if (!parsed.ok) continue;
    const section = parsed.value;
    // Virtual size omits alignment padding. Admit the entire raw span before
    // exposing only the section's initialized content to the graph decoder.
    const raw = declaredFileRange(
      fileSize,
      BigInt(section.offset),
      BigInt(section.raw_size),
    );
    claims.push({
      carrier: "pe-section",
      fileOffset: section.offset,
      available: section.size,
      truncated: section.raw_size > 0 && !raw.file_backed,
    });
  }
  return claims;
};

const ELF_BUN_NAME = Buffer.from(".bun");
const ELF_SHT_NULL = 0;
const ELF_SHT_STRTAB = 3;
const ELF_SHT_NOBITS = 8;
const MAX_SAFE_FILE_WORD = BigInt(Number.MAX_SAFE_INTEGER);

const elfClaims = async (
  source: BunProbeSource,
): Promise<readonly SectionWindow[]> => {
  const { handle, fileSize, signal, limits } = source;
  const header = await tryRead(handle, 0, 64, fileSize, signal);
  if (header === null) return [];
  const format = readElfHeaderFacts(header, fileSize);
  if (!format.ok) return [];
  const { elfClass, byteOrder } = format.value;
  const declarations = readElfRawTableDeclarations(header, format.value);
  if (!declarations.ok) return [];
  const { offset, width, count, namesIndex } = declarations.value.sections;
  const sectionWidth = elfSectionHeaderWidth(elfClass);
  // Unsupported extended numbering does not establish a Bun graph.
  if (
    (width !== 0 && width !== sectionWidth) ||
    offset === 0n ||
    offset > MAX_SAFE_FILE_WORD ||
    count === 0 ||
    count === 0xffff ||
    namesIndex >= count
  )
    return [];
  const tableBytes = count * sectionWidth;
  if (tableBytes > limits.recognition_table_bytes)
    throw artifactReaderLimitFailure(
      "artifact_limits.bun.recognition_table_bytes",
      limits.recognition_table_bytes,
      "bytes",
      tableBytes,
    );
  const table = await tryRead(
    handle,
    Number(offset),
    tableBytes,
    fileSize,
    signal,
  );
  if (table === null) return [];
  const readSection = (index: number) => {
    const start = index * sectionWidth;
    const section = readElfSectionHeader(
      table.subarray(start, start + sectionWidth),
      elfClass,
      byteOrder === "little",
    );
    return section.ok ? section.value : null;
  };

  const strings = readSection(namesIndex);
  if (strings === null || strings.type !== ELF_SHT_STRTAB) return [];
  const stringRange = declaredFileRange(fileSize, strings.offset, strings.size);
  if (!stringRange.file_backed) return [];
  // Only ".bun" and its terminator are needed. Duplicate offsets share one
  // bounded lookup, even when the referenced string is much longer.
  const names = new Map<number, boolean>();
  const claims: SectionWindow[] = [];
  for (let index = 0; index < count; index += 1) {
    const section = readSection(index);
    if (
      section === null ||
      section.type === ELF_SHT_NULL ||
      section.type === ELF_SHT_NOBITS ||
      section.offset > MAX_SAFE_FILE_WORD ||
      section.size > MAX_SAFE_FILE_WORD
    )
      continue;
    const { nameOffset } = section;
    let isBun = names.get(nameOffset);
    if (isBun === undefined) {
      const name =
        nameOffset >= stringRange.size
          ? null
          : await tryRead(
              handle,
              stringRange.offset + nameOffset,
              Math.min(ELF_BUN_NAME.length + 1, stringRange.size - nameOffset),
              fileSize,
              signal,
            );
      isBun =
        name !== null &&
        observeElfStringTableEntry(name, 0, name.length).bytes?.equals(
          ELF_BUN_NAME,
        ) === true;
      names.set(nameOffset, isBun);
    }
    if (!isBun) continue;
    claims.push(
      windowFor(
        "elf-section",
        Number(section.offset),
        Number(section.size),
        fileSize,
      ),
    );
  }
  return claims;
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
      available: 0,
      truncated: false,
    };
  const room = fileSize - fileOffset;
  return {
    carrier,
    fileOffset,
    available: Math.min(declaredSize, room),
    truncated: declaredSize > room,
  };
};

const exactName = (bytes: Buffer, text: string): boolean => {
  const encoded = Buffer.alloc(bytes.length);
  encoded.write(text, "utf8");
  return encoded.equals(bytes);
};

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
