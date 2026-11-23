import {
  fitsPeRvaSpan as fitsRva,
  appendPeConsumedSpan as consume,
} from "./PeRvaSpans.js";
import { setImmediate } from "node:timers/promises";
import {
  assertArtifactReadActive,
  type StableArtifactHandle,
} from "../../resources/index.js";
import {
  BinaryFormatFailure,
  BinaryReader,
  BinaryMappingFailure,
  BinaryResourceFailure,
  createFileMappingIndex,
  imageFileMappings,
  mappedFileOffset,
  type FileMappingIndex,
} from "../../domain/binaryContainer.js";
import {
  peDeclaredFileMappings,
  readPeImage,
  readPeImageFromReader,
  type PeImage,
} from "../../domain/native/peImage.js";
import { peSectionVirtualExtent } from "../../domain/peSectionHeader.js";
import {
  guardFlagRecord,
  loadConfigFieldCovered,
  loadConfigFieldLayout,
  PE_LOAD_CONFIG_LIMITATIONS,
  TLS_STRUCT_BYTES,
  tlsAlignment,
  type InspectPeLoadConfigInput,
  type PeLoadConfig,
  type PeLoadConfigCountField,
  type PeLoadConfigDirectory,
  type PeLoadConfigField,
  type PeLoadConfigLocated,
  type PeLoadConfigLocatedField,
  type PeLoadConfigNumberField,
  type PeLoadConfigRawField,
  type PeLoadConfigTls,
} from "../../domain/native/peLoadConfig.js";

const PE_TLS_DIRECTORY = 9;
const PE_LOAD_CONFIG_DIRECTORY = 10;
/** Callback slots decoded between event-loop yields and cancellation checks. */
const ENTRIES_PER_YIELD = 1024;

/** Derived locations may be unmapped; ambiguous mappings remain malformed. */
const optionalFileOffset = (lookup: () => number): number | null => {
  try {
    return lookup();
  } catch (cause) {
    if (!(cause instanceof BinaryMappingFailure) || cause.reason !== "unmapped")
      throw cause;
    return null;
  }
};

/** The parser-owned allowances an image can exhaust. */
export const PE_LOAD_CONFIG_LIMITS = ["callbacks"] as const;
export type PeLoadConfigLimit = (typeof PE_LOAD_CONFIG_LIMITS)[number];

const hex = (value: bigint | number): string => `0x${value.toString(16)}`;

type DirectorySpan = PeLoadConfigTls["directory"];

/** One run of RVAs with a constant set of owning sections. */
interface SectionSegment {
  readonly start: number;
  readonly owners: number;
  readonly name: string | null;
}

/**
 * Build the RVA-to-section lookup once per image. Section spans are split
 * into disjoint segments so each lookup is a binary search; an RVA owned by
 * more than one section still fails as ambiguous.
 */
const sectionIndex = (
  sections: PeImage["sections"],
): ((rva: number) => SectionSegment | null) => {
  const events: { at: number; index: number; open: boolean }[] = [];
  sections.forEach((section, index) => {
    if (section.format !== "pe") return;
    const span = peSectionVirtualExtent(section.virtual_size, section.raw_size);
    if (span <= 0) return;
    events.push(
      { at: section.virtual_address, index, open: true },
      { at: section.virtual_address + span, index, open: false },
    );
  });
  events.sort((left, right) => left.at - right.at);
  const segments: SectionSegment[] = [];
  const active = new Set<number>();
  for (let cursor = 0; cursor < events.length;) {
    const at = events[cursor]!.at;
    for (; cursor < events.length && events[cursor]!.at === at; cursor++) {
      const event = events[cursor]!;
      if (event.open) active.add(event.index);
      else active.delete(event.index);
    }
    const [only] = active;
    segments.push({
      start: at,
      owners: active.size,
      name: active.size === 1 ? sections[only!]?.name || null : null,
    });
  }
  return (rva) => {
    let low = 0;
    let high = segments.length - 1;
    let found: SectionSegment | undefined;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const segment = segments[middle]!;
      if (segment.start <= rva) {
        found = segment;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (found === undefined || found.owners === 0) return null;
    if (found.owners > 1)
      throw new BinaryMappingFailure(
        "ambiguous",
        `PE RVA ${hex(rva)} belongs to multiple sections`,
      );
    return found;
  };
};

const MAX_LOAD_CONFIG_READ_BYTES = 512;

type PeRangeReader = (offset: number, length: number) => Promise<Buffer>;

/**
 * Read one PE TLS directory and load configuration from a parsed PE image
 * without executing the image. Yields to the event loop and honors cancellation
 * every `ENTRIES_PER_YIELD` callback slots.
 */
export const parsePeLoadConfigFromImage = async (
  bytes: Buffer,
  image: PeImage,
  artifact: PeLoadConfig["artifact"],
  input: InspectPeLoadConfigInput,
  signal?: AbortSignal,
): Promise<PeLoadConfig> =>
  parsePeLoadConfigCore(
    (offset, length) =>
      Promise.resolve(bytes.subarray(offset, offset + length)),
    image,
    artifact,
    input,
    signal,
  );

const parsePeLoadConfigCore = async (
  readBytes: PeRangeReader,
  image: PeImage,
  artifact: PeLoadConfig["artifact"],
  input: InspectPeLoadConfigInput,
  signal?: AbortSignal,
): Promise<PeLoadConfig> => {
  assertArtifactReadActive(signal);
  const bits = image.bits;
  const base = image.image_base;
  const pointerWidth = bits === 64 ? 8 : 4;
  // Build section and mapping indices only when directory 9 or 10 exists and needs them.
  let mappingIndex: FileMappingIndex | undefined;
  const getLookup = (): FileMappingIndex =>
    (mappingIndex ??= createFileMappingIndex(
      imageFileMappings(image),
      image.zero_fills,
    ));
  let cachedSections: ReturnType<typeof sectionIndex> | undefined;
  const sectionAt = (rva: number): SectionSegment | null =>
    (cachedSections ??= sectionIndex(image.sections))(rva);

  const dataDirectory = (index: number): DirectorySpan | null => {
    const entry = image.pe_data_directories[index];
    if (entry === undefined) return null;
    const { address: rva, size } = entry;
    if (rva === 0 && size === 0) return null;
    if (rva === 0 || size === 0)
      throw new BinaryFormatFailure(
        "malformed",
        `PE data directory ${String(index)} declares a zero RVA or size while the other field is nonzero`,
      );
    if (!fitsRva(rva, size))
      throw new BinaryFormatFailure(
        "malformed",
        `PE data directory ${String(index)} RVA ${hex(rva)} span of ${String(size)} bytes extends beyond the 32-bit RVA space`,
      );
    return {
      rva,
      size,
      file_offset: getLookup().offset(base + BigInt(rva), size),
    };
  };

  const rvaOf = (va: bigint): number | null => {
    if (va < base) return null;
    const delta = va - base;
    return delta <= 0xffffffffn ? Number(delta) : null;
  };

  const locate = (va: bigint): PeLoadConfigLocated => {
    if (va === 0n)
      return { va: "0x0", rva: null, file_offset: null, section: null };
    const rva = rvaOf(va);
    let fileOffset: number | null = null;
    if (rva !== null) {
      fileOffset = optionalFileOffset(() => getLookup().offset(va, 1));
    }
    return {
      va: hex(va),
      rva,
      file_offset: fileOffset,
      section: rva === null ? null : (sectionAt(rva)?.name ?? null),
    };
  };

  const tls = await readTls({
    readBytes,
    bits,
    directory: dataDirectory(PE_TLS_DIRECTORY),
    pointerWidth,
    locate,
    rvaOf,
    sectionAt,
    lookup: getLookup,
    templateFileOffset: (address, size) =>
      optionalFileOffset(() =>
        mappedFileOffset(
          peDeclaredFileMappings(image),
          address,
          size,
          image.zero_fills,
        ),
      ),
    maxCallbacks: input.max_callbacks,
    signal,
  });
  const loadConfig = await readLoadConfig({
    readBytes,
    bits,
    directory: dataDirectory(PE_LOAD_CONFIG_DIRECTORY),
    locate,
    structOffset: (rva, size) => {
      if (!fitsRva(rva, size))
        throw new BinaryFormatFailure(
          "malformed",
          `Load configuration Size ${String(size)} extends beyond the 32-bit RVA space`,
        );
      try {
        return getLookup().offset(base + BigInt(rva), size);
      } catch (cause) {
        if (cause instanceof BinaryMappingFailure)
          throw new BinaryFormatFailure(
            "malformed",
            `Load configuration Size ${String(size)} extends beyond its file-backed mapping`,
          );
        throw cause;
      }
    },
  });
  return {
    artifact,
    format: bits === 64 ? "pe32-plus" : "pe32",
    machine: image.pe_machine,
    bits,
    architecture: image.architecture,
    tls,
    load_config: loadConfig,
    examined_callbacks: tls?.callbacks.length ?? 0,
    limitations: [...PE_LOAD_CONFIG_LIMITATIONS],
  };
};

/**
 * Read one PE TLS directory and load configuration without executing the image.
 * Yields to the event loop and honors cancellation every
 * `ENTRIES_PER_YIELD` callback slots.
 */
export const parsePeLoadConfig = async (
  bytes: Buffer,
  artifact: PeLoadConfig["artifact"],
  input: InspectPeLoadConfigInput,
  signal?: AbortSignal,
): Promise<PeLoadConfig> => {
  assertArtifactReadActive(signal);
  return parsePeLoadConfigFromImage(
    bytes,
    readPeImage(bytes),
    artifact,
    input,
    signal,
  );
};

/**
 * Read one PE TLS directory and load configuration from a verified
 * random-access handle without buffering the full PE image in memory.
 */
export const parsePeLoadConfigFromHandle = async (
  handle: StableArtifactHandle,
  artifact: PeLoadConfig["artifact"],
  input: InspectPeLoadConfigInput,
  signal?: AbortSignal,
): Promise<PeLoadConfig> => {
  assertArtifactReadActive(signal);
  const image = await readPeImageFromReader(handle);
  const readBytes: PeRangeReader = (offset, length) =>
    length === 0
      ? Promise.resolve(Buffer.alloc(0))
      : offset >= 0 && offset + length <= handle.prefix.length
        ? Promise.resolve(handle.prefix.subarray(offset, offset + length))
        : handle.readRange(offset, length);
  return parsePeLoadConfigCore(readBytes, image, artifact, input, signal);
};

const readTls = async ({
  readBytes,
  bits,
  directory,
  pointerWidth,
  locate,
  rvaOf,
  sectionAt,
  lookup,
  templateFileOffset,
  maxCallbacks,
  signal,
}: {
  readonly readBytes: PeRangeReader;
  readonly bits: 32 | 64;
  readonly directory: DirectorySpan | null;
  readonly pointerWidth: number;
  readonly locate: (va: bigint) => PeLoadConfigLocated;
  readonly rvaOf: (va: bigint) => number | null;
  readonly sectionAt: (rva: number) => SectionSegment | null;
  readonly lookup: () => FileMappingIndex;
  readonly templateFileOffset: (address: bigint, size: number) => number | null;
  readonly maxCallbacks: number;
  readonly signal: AbortSignal | undefined;
}): Promise<PeLoadConfigTls | null> => {
  if (directory === null) return null;
  const structBytes = TLS_STRUCT_BYTES[bits];
  if (directory.size < structBytes)
    throw new BinaryFormatFailure(
      "malformed",
      `TLS directory is ${String(directory.size)} bytes; PE${String(bits)} requires ${String(structBytes)}`,
    );
  const tlsReader = new BinaryReader(
    await readBytes(directory.file_offset, structBytes),
    true,
    "pe",
  );
  const start = tlsReader.word(0, bits);
  const end = tlsReader.word(pointerWidth, bits);
  const index = tlsReader.word(pointerWidth * 2, bits);
  const callbacksVa = tlsReader.word(pointerWidth * 3, bits);
  const sizeOfZeroFill = tlsReader.u32(pointerWidth * 4);
  const characteristics = tlsReader.u32(pointerWidth * 4 + 4);
  if (end < start)
    throw new BinaryFormatFailure(
      "malformed",
      "TLS raw data end precedes its start",
    );
  const rawSizeBig = end - start;
  if (rawSizeBig > 0xffffffffn)
    throw new BinaryFormatFailure(
      "malformed",
      "TLS raw data size exceeds the 32-bit range",
    );
  const rawSize = Number(rawSizeBig);
  let rawFile: number | null = null;
  let rawSection: string | null = null;
  if (rawSize === 0) {
    const rva = rvaOf(start);
    rawSection = rva === null ? null : (sectionAt(rva)?.name ?? null);
  } else {
    rawFile = templateFileOffset(start, rawSize);
    const startRva = rvaOf(start);
    const last = startRva === null ? null : startRva + rawSize - 1;
    if (startRva !== null && last !== null && last <= 0xffffffff) {
      const firstSection = sectionAt(startRva);
      const lastSection = sectionAt(last);
      // A single segment establishes the same unambiguous owner throughout.
      rawSection =
        firstSection === lastSection ? (firstSection?.name ?? null) : null;
    }
  }

  const callbacks: PeLoadConfigLocated[] = [];
  const callbackArrayLocations: { offset: number; bytes: number }[] = [];
  if (callbacksVa !== 0n) {
    const mapping = lookup();
    let slot = callbacksVa;
    let entries = 0;
    let window = new BinaryReader(Buffer.alloc(0), true, "pe");
    let windowOffset = 0;
    let cursor = 0;
    for (;;) {
      entries += 1;
      if (entries % ENTRIES_PER_YIELD === 0) {
        await setImmediate();
        assertArtifactReadActive(signal);
      }
      if (cursor >= window.bytes.length) {
        const slots = Math.min(
          ENTRIES_PER_YIELD - (entries % ENTRIES_PER_YIELD),
          maxCallbacks - callbacks.length + 1,
        );
        const prefix = mapping.prefix(slot, slots * pointerWidth);
        const wholeSlots = Math.floor((prefix?.size ?? 0) / pointerWidth);
        // A window never crosses an unmapped or ambiguous range. Resolve the
        // first unavailable slot exactly so its failure retains precedence.
        windowOffset =
          prefix !== null && wholeSlots > 0
            ? prefix.offset
            : mapping.offset(slot, pointerWidth);
        window = new BinaryReader(
          await readBytes(windowOffset, Math.max(1, wholeSlots) * pointerWidth),
          true,
          "pe",
        );
        cursor = 0;
      }
      const slotOffset = windowOffset + cursor;
      const value = window.word(cursor, bits);
      cursor += pointerWidth;
      consume(callbackArrayLocations, slotOffset, pointerWidth);
      if (value === 0n) break;
      if (callbacks.length >= maxCallbacks)
        throw new BinaryResourceFailure(
          "structure",
          maxCallbacks,
          `TLS callback array exceeds the ${String(maxCallbacks)}-entry callback allowance`,
          "callbacks" satisfies PeLoadConfigLimit,
        );
      callbacks.push(locate(value));
      slot += BigInt(pointerWidth);
    }
  }

  return {
    directory,
    start_address_of_raw_data: hex(start),
    end_address_of_raw_data: hex(end),
    raw_data_size: rawSize,
    raw_data_file_offset: rawFile,
    raw_data_section: rawSection,
    address_of_index: locate(index),
    address_of_callbacks: hex(callbacksVa),
    size_of_zero_fill: sizeOfZeroFill,
    characteristics,
    alignment: tlsAlignment(characteristics),
    callbacks,
    callback_array_locations: callbackArrayLocations,
  };
};

const readLoadConfig = async ({
  readBytes,
  bits,
  directory,
  locate,
  structOffset,
}: {
  readonly readBytes: PeRangeReader;
  readonly bits: 32 | 64;
  readonly directory: DirectorySpan | null;
  readonly locate: (va: bigint) => PeLoadConfigLocated;
  readonly structOffset: (rva: number, size: number) => number;
}): Promise<PeLoadConfigDirectory | null> => {
  if (directory === null) return null;
  if (directory.size < 4)
    throw new BinaryFormatFailure(
      "malformed",
      "Load configuration directory is shorter than its Size field",
    );
  const size = new BinaryReader(
    await readBytes(directory.file_offset, 4),
    true,
    "pe",
  ).u32(0);
  if (size < 4)
    throw new BinaryFormatFailure(
      "malformed",
      `Load configuration Size ${String(size)} is shorter than its Size field`,
    );
  // x86 images declare a 64-byte data directory for compatibility while the
  // structure's own Size gives its real length; the loader reads Size bytes.
  // Accept the larger Size only when those bytes are file-backed in one run.
  if (
    size > directory.size &&
    structOffset(directory.rva, size) !== directory.file_offset
  )
    throw new BinaryFormatFailure(
      "malformed",
      `Load configuration Size ${String(size)} is not contiguously file-backed`,
    );
  const structReader = new BinaryReader(
    await readBytes(
      directory.file_offset,
      Math.min(size, MAX_LOAD_CONFIG_READ_BYTES),
    ),
    true,
    "pe",
  );
  const readField = (name: PeLoadConfigField): bigint | null => {
    if (!loadConfigFieldCovered(bits, size, name)) return null;
    const field = loadConfigFieldLayout(bits, name);
    return field.width === 2
      ? BigInt(structReader.u16(field.offset))
      : structReader.word(field.offset, field.width === 4 ? 32 : 64);
  };
  const located = (
    name: PeLoadConfigLocatedField,
  ): PeLoadConfigLocated | null => {
    const value = readField(name);
    return value === null ? null : locate(value);
  };
  const number = (
    name: PeLoadConfigCountField | PeLoadConfigNumberField,
  ): number | null => {
    const value = readField(name);
    if (value === null) return null;
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new BinaryFormatFailure(
        "malformed",
        `Load configuration ${name} exceeds the safe integer range`,
      );
    return Number(value);
  };
  const raw = (name: PeLoadConfigRawField): string | null => {
    const value = readField(name);
    return value === null ? null : hex(value);
  };
  const flags = readField("guard_flags");
  const decoded = flags === null ? null : guardFlagRecord(Number(flags));
  return {
    directory,
    size,
    structure_location: { offset: directory.file_offset, bytes: size },
    security_cookie: located("security_cookie"),
    se_handler_table: located("se_handler_table"),
    se_handler_count: number("se_handler_count"),
    guard_cf_check_function_pointer: located("guard_cf_check_function_pointer"),
    guard_cf_dispatch_function_pointer: located(
      "guard_cf_dispatch_function_pointer",
    ),
    guard_cf_function_table: located("guard_cf_function_table"),
    guard_cf_function_count: number("guard_cf_function_count"),
    guard_flags:
      decoded === null
        ? null
        : {
            raw: Number(flags),
            flags: decoded.flags,
            unrecognized: decoded.unrecognized,
            cf_function_table_stride: decoded.cf_function_table_stride,
          },
    guard_address_taken_iat_entry_table: located(
      "guard_address_taken_iat_entry_table",
    ),
    guard_address_taken_iat_entry_count: number(
      "guard_address_taken_iat_entry_count",
    ),
    guard_long_jump_target_table: located("guard_long_jump_target_table"),
    guard_long_jump_target_count: number("guard_long_jump_target_count"),
    dynamic_value_reloc_table: raw("dynamic_value_reloc_table"),
    chpe_metadata_pointer: raw("chpe_metadata_pointer"),
    dynamic_value_reloc_table_offset: number(
      "dynamic_value_reloc_table_offset",
    ),
    dynamic_value_reloc_table_section: number(
      "dynamic_value_reloc_table_section",
    ),
    guard_eh_continuation_table: located("guard_eh_continuation_table"),
    guard_eh_continuation_count: number("guard_eh_continuation_count"),
    guard_xfg_check_function_pointer: located(
      "guard_xfg_check_function_pointer",
    ),
    inferences: decoded?.inferences ?? [],
  };
};
