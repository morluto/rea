import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import { readLeb128, ULEB64 } from "../domain/leb128.js";
import type {
  FileMapping,
  ZeroFillMapping,
} from "../domain/virtualFileMapping.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
  BinaryReader,
  mappedFileOffset,
  imageFileMappings,
  isZeroFilledSpan,
  type BinaryContainer,
} from "../domain/binaryContainer.js";
import type { ZstandardFramePause } from "../domain/compression/zstandardExactFrame.js";
import { readBinaryContainerFromReader } from "../domain/native/readBinaryContainer.js";
import {
  goAnalysisBudgets,
  type GoAnalysisBudgets,
  type GoBinary,
  type GoStringLiterals,
} from "../domain/go/goBinary.js";
import { parseGoModuleBytes } from "./GoModuleText.js";
import {
  goBuildInfoSearch,
  type GoBuildInfoSearchRange,
} from "./GoBuildInfoSearch.js";
import { recoverGoStringLiteralsFromReader } from "./GoStringLiterals.js";
import type { ByteSource } from "../domain/byteSource.js";

const SEARCH_CHUNK_BYTES = 64 * 1024;
const MAGIC = Buffer.from("ff20476f206275696c64696e663a", "hex");
const MODULE_START = Buffer.from("3077af0c9274080241e1c107e6d618e6", "hex");
const MODULE_END = Buffer.from("f932433186182072008242104116d8f2", "hex");

/** Producer facts use the domain contract's source-value representation. */
export type GoBuildInfo = NonNullable<GoBinary["build_info"]>;
export type GoStringLocation = GoBuildInfo["version_location"];

/** Native image identity and optional Go build information; absence is not a language verdict. */
export interface GoBinaryImage {
  readonly format: "elf" | "pe" | "macho";
  readonly architecture: string;
  readonly bits: 32 | 64;
  readonly byte_order: "little" | "big";
  readonly build_info: GoBuildInfo | null;
  readonly string_literals?: GoStringLiterals;
  readonly macho_chained_fixups?: boolean;
  /** Native section-name coverage, retained for discovery limitations. */
  readonly section_names_limitation?: string;
}

export interface ReadGoBinaryImageOptions {
  readonly includeStringLiterals?: boolean;
  readonly checkActive?: (() => void) | undefined;
  readonly budgets?: Partial<GoAnalysisBudgets>;
  /** `max_structure_bytes` for the container's header tables. */
  readonly structureBytes?: number | undefined;
}

/** Stream Go build-info and optional string-literal inspection over a bounded FileHandle. */
export const readGoBinaryImageFromHandle = async (
  source: ByteSource,
  options: ReadGoBinaryImageOptions | undefined,
  pause: ZstandardFramePause,
): Promise<GoBinaryImage> => {
  const container = await readBinaryContainerFromReader(
    source,
    "inspect_go_binary",
    pause,
    options?.structureBytes,
  );
  const budgets = goAnalysisBudgets(options?.budgets);
  const stringLiterals =
    options?.includeStringLiterals === true
      ? await recoverGoStringLiteralsFromReader(
          source,
          container,
          budgets,
          options.checkActive,
        )
      : undefined;
  const steps = scanGoBuildInfo(
    source.size,
    container,
    budgets,
    stringLiterals,
    options?.checkActive,
  );
  let step = steps.next();
  while (!step.done) {
    const { offset, length, label } = step.value;
    step = steps.next(
      await readExactSlice(source, offset, length, container.format, label),
    );
  }
  return step.value;
};

type BuildInfoRead = {
  readonly offset: number;
  readonly length: number;
  readonly label: string;
};

function* scanGoBuildInfo(
  fileSize: number,
  container: BinaryContainer,
  budgets: GoAnalysisBudgets,
  stringLiterals: GoStringLiterals | undefined,
  checkActive: (() => void) | undefined,
): Generator<BuildInfoRead, GoBinaryImage, Buffer> {
  const { format, architecture, bits, byte_order } = container;
  const stringMetadata =
    stringLiterals === undefined
      ? {}
      : {
          string_literals: stringLiterals,
          ...(container.macho_chained_fixups === true
            ? { macho_chained_fixups: true }
            : {}),
        };
  let selected: { search: GoBuildInfoSearchRange; header: number } | null =
    null;
  const searched = new Set<string>();
  let remainingSearchBytes = budgets.max_header_search_bytes;
  const sectionNamesLimitation = container.section_names_limitation;
  for (const search of goBuildInfoSearch(fileSize, container)) {
    const identity = `${search.offset}:${search.size}:${search.address % 16n}`;
    if (searched.has(identity)) continue;
    searched.add(identity);
    if (search.size > remainingSearchBytes)
      throw new BinaryResourceFailure(
        "search",
        budgets.max_header_search_bytes,
        `Go build-info discovery exceeds max_header_search_bytes=${String(budgets.max_header_search_bytes)}`,
      );
    remainingSearchBytes -= search.size;
    const header = yield* findHeaderSteps(search, checkActive);
    if (header !== null) {
      selected = { search, header };
      break;
    }
  }
  if (selected === null)
    return {
      format,
      architecture,
      bits,
      byte_order,
      build_info: null,
      ...stringMetadata,
      ...(sectionNamesLimitation === undefined
        ? {}
        : { section_names_limitation: sectionNamesLimitation }),
    };
  const { search, header } = selected;
  const mappings = imageFileMappings(container);
  const verifyMapping = (size: number): void => {
    const address = search.address + BigInt(header - search.offset);
    if (
      mappedFileOffset(mappings, address, size, container.zero_fills) !== header
    )
      throw new BinaryFormatFailure(
        "malformed",
        "Go build-info bytes disagree with their virtual mapping",
      );
  };
  verifyMapping(32);
  const headerBytes = yield {
    offset: header,
    length: 32,
    label: "Go build-info header",
  };
  const little = byte_order === "little";
  const headerReader = new BinaryReader(headerBytes, little, container.format);
  const ptrSize = headerBytes[14];
  const flags = headerBytes[15] ?? 0;
  if ((flags & ~3) !== 0)
    throw new BinaryFormatFailure(
      "unsupported",
      "Go build-info flags contain an unsupported format bit",
      { undecodedContent: true },
    );
  if ((flags & 2) === 0 && (flags & 1) !== (byte_order === "big" ? 1 : 0))
    throw new BinaryFormatFailure(
      "malformed",
      "Go build-info byte order disagrees with the image",
    );
  const encoding = (flags & 2) !== 0 ? "inline" : "pointer";
  let version: LocatedString;
  let module: LocatedString;
  if (encoding === "inline") {
    const sourceEnd = inlineDataEnd(header, search, container);
    const versionExtent = yield* readInlineExtentSteps(
      header + 32,
      sourceEnd - header - 32,
      budgets.max_build_info_bytes,
    );
    const moduleExtent = yield* readInlineExtentSteps(
      versionExtent.next,
      sourceEnd - versionExtent.next,
      budgets.max_build_info_bytes,
    );
    verifyMapping(moduleExtent.next - header);
    assertAggregateContentLimit(
      versionExtent.location,
      moduleExtent.location,
      budgets.max_build_info_bytes,
    );
    version = {
      location: versionExtent.location,
      bytes: yield* readBuildInfoString(versionExtent.location),
    };
    module = {
      location: moduleExtent.location,
      bytes: yield* readBuildInfoString(moduleExtent.location),
    };
  } else {
    if (ptrSize !== 4 && ptrSize !== 8)
      throw new BinaryFormatFailure(
        "malformed",
        "Go build-info pointer width must be 4 or 8",
      );
    const pointerBits = ptrSize === 4 ? 32 : 64;
    const pointerContext: PointerStringContext = {
      fileSize,
      little,
      format: container.format,
      mappings,
      zeroFills: container.zero_fills,
      maximumBytes: budgets.max_build_info_bytes,
    };
    version = yield* readPointerStringSteps(
      pointerContext,
      headerReader.word(16, pointerBits),
      pointerBits,
    );
    const moduleField = header + 16 + ptrSize;
    module = yield* readOptionalModuleStringSteps(
      pointerContext,
      headerReader.word(16 + ptrSize, pointerBits),
      moduleField,
      pointerBits,
    );
    assertAggregateContentLimit(
      version.location,
      module.location,
      budgets.max_build_info_bytes,
    );
  }
  return buildGoBinaryImageReport(
    container,
    header,
    encoding,
    version,
    module,
    stringMetadata,
    sectionNamesLimitation,
  );
}

const buildGoBinaryImageReport = (
  container: BinaryContainer,
  header: number,
  encoding: "inline" | "pointer",
  version: LocatedString,
  module: LocatedString,
  stringMetadata:
    | {
        readonly string_literals: GoStringLiterals;
        readonly macho_chained_fixups?: boolean;
      }
    | Record<string, never>,
  sectionNamesLimitation: string | undefined,
): GoBinaryImage => {
  const { format, architecture, bits, byte_order } = container;
  if (version.bytes.length === 0)
    throw new BinaryFormatFailure(
      "malformed",
      "Go build-info compiler version is empty",
    );
  const goVersion = observedText(version.bytes);
  let moduleText: string | null = "";
  let moduleBody = module.bytes;
  if (module.bytes.length !== 0) {
    if (
      module.bytes.length < 33 ||
      !module.bytes.subarray(0, 16).equals(MODULE_START) ||
      !module.bytes.subarray(-16).equals(MODULE_END) ||
      module.bytes[module.bytes.length - 17] !== 10
    )
      throw new BinaryFormatFailure(
        "malformed",
        "Go module string framing is invalid",
      );
    moduleBody = module.bytes.subarray(16, -16);
    moduleText = observedText(moduleBody);
  }
  return {
    format,
    architecture,
    bits,
    byte_order,
    build_info: {
      header_offset: header,
      encoding,
      go_version: goVersion,
      go_version_bytes_base64: version.bytes.toString("base64"),
      module_text: moduleText,
      module_bytes_base64: module.bytes.toString("base64"),
      version_location: version.location,
      module_location: module.location,
      module: parseGoModuleBytes(moduleBody),
    },
    ...stringMetadata,
    ...(sectionNamesLimitation === undefined
      ? {}
      : { section_names_limitation: sectionNamesLimitation }),
  };
};

/** Inline strings follow the header in its mapped Go data, even when the named
 * ELF or Mach-O discovery section ends immediately after the header.
 */
const inlineDataEnd = (
  header: number,
  search: GoBuildInfoSearchRange,
  container: BinaryContainer,
): number => {
  if (container.format === "pe") return search.offset + search.size;
  const address = search.address + BigInt(header - search.offset);
  let end = search.offset + search.size;
  if (search.inline_mapping !== undefined) {
    const delta = address - search.inline_mapping.address;
    if (
      delta >= 0n &&
      delta < BigInt(search.inline_mapping.size) &&
      search.inline_mapping.offset + Number(delta) === header
    )
      return Math.max(
        end,
        search.inline_mapping.offset + search.inline_mapping.size,
      );
    return end;
  }
  for (const { mapping } of container.load_regions ?? []) {
    const delta = address - mapping.address;
    if (
      delta >= 0n &&
      delta < BigInt(mapping.size) &&
      mapping.offset + Number(delta) === header
    )
      end = Math.max(end, mapping.offset + mapping.size);
  }
  return end;
};

const observedText = (bytes: Buffer): string | null => {
  try {
    return decodeStrictUtf8(bytes, "preserve");
  } catch (cause) {
    if (cause instanceof TypeError) return null;
    throw cause;
  }
};

interface LocatedString {
  readonly bytes: Buffer;
  readonly location: GoStringLocation;
}

const assertAggregateContentLimit = (
  version: GoStringLocation,
  module: GoStringLocation,
  maximumBytes: number,
): void => {
  if (version.bytes + module.bytes > maximumBytes)
    throw new BinaryResourceFailure(
      "build-info",
      maximumBytes,
      `Go build-info strings exceed max_build_info_bytes=${String(maximumBytes)}`,
    );
};

const readExactSlice = async (
  source: ByteSource,
  offset: number,
  size: number,
  format: BinaryContainer["format"],
  label: string,
): Promise<Buffer> => {
  if (size === 0) return Buffer.alloc(0);
  if (offset < 0 || size < 0 || offset > source.size - size)
    throw new BinaryFormatFailure(
      "truncated",
      `${label} range is outside the file`,
      { format, offset, field: label },
    );
  if (source.prefix !== undefined && offset + size <= source.prefix.length)
    return source.prefix.subarray(offset, offset + size);
  const loaded = await source.readRange(offset, size);
  if (loaded.length < size)
    throw new BinaryFormatFailure(
      "truncated",
      `${label} range is outside the file`,
      { format, offset, field: label },
    );
  return loaded.subarray(0, size);
};

function* findHeaderSteps(
  search: FileMapping,
  checkActive: (() => void) | undefined,
): Generator<BuildInfoRead, number | null, Buffer> {
  if (search.size === 0) return null;
  const end = search.offset + search.size;
  const overlap = MAGIC.length - 1;
  let chunkStart = search.offset;
  while (chunkStart < end) {
    checkActive?.();
    const chunkEnd = Math.min(end, chunkStart + SEARCH_CHUNK_BYTES);
    const chunk = yield {
      offset: chunkStart,
      length: chunkEnd - chunkStart,
      label: "Go build-info search",
    };
    let offset = 0;
    while (offset < chunk.length) {
      const match = chunk.indexOf(MAGIC, offset);
      if (match < 0) break;
      const candidate = chunkStart + match;
      const address = search.address + BigInt(candidate - search.offset);
      if (address % 16n === 0n) {
        if (end - candidate < 32)
          throw new BinaryFormatFailure(
            "malformed",
            "Go build-info header is truncated",
          );
        return candidate;
      }
      offset = match + 1;
    }
    if (chunkEnd >= end) break;
    chunkStart = chunkEnd - overlap;
  }
  return null;
}

function* readInlineExtentSteps(
  offset: number,
  remaining: number,
  maximumBytes: number,
): Generator<
  BuildInfoRead,
  { readonly location: GoStringLocation; readonly next: number },
  Buffer
> {
  const probeLength = Math.min(10, Math.max(0, remaining));
  const probe =
    probeLength === 0
      ? Buffer.alloc(0)
      : yield { offset, length: probeLength, label: "Go build-info varint" };
  const read = readLeb128(probe, 0, probe.length, ULEB64);
  if ("failure" in read)
    throw new BinaryFormatFailure(
      "malformed",
      read.failure === "truncated"
        ? "Go build-info varint is truncated"
        : "Go build-info varint overflows 64 bits",
    );
  const start = offset + read.next;
  const length = read.value;
  if (length > BigInt(remaining - read.next))
    throw new BinaryFormatFailure(
      "malformed",
      "Go build-info string range is truncated",
    );
  if (length > BigInt(maximumBytes))
    throw new BinaryResourceFailure(
      "build-info",
      maximumBytes,
      `Go build-info string length exceeds max_build_info_bytes=${String(maximumBytes)}`,
    );
  const size = Number(length);
  return {
    location: { offset: start, bytes: size },
    next: start + size,
  };
}

interface PointerStringContext {
  readonly fileSize: number;
  readonly little: boolean;
  readonly format: BinaryContainer["format"];
  readonly mappings: readonly FileMapping[];
  readonly zeroFills: readonly ZeroFillMapping[];
  readonly maximumBytes: number;
}

function* readPointerStringSteps(
  {
    fileSize,
    little,
    format,
    mappings,
    zeroFills,
    maximumBytes,
  }: PointerStringContext,
  address: bigint,
  pointerBits: 32 | 64,
): Generator<BuildInfoRead, LocatedString, Buffer> {
  const width = pointerBits / 8;
  const header = mappedFileOffset(mappings, address, width * 2, zeroFills);
  const headerBytes = yield {
    offset: header,
    length: width * 2,
    label: "Go build-info pointer header",
  };
  const headerReader = new BinaryReader(headerBytes, little, format);
  const valueAddress = headerReader.word(0, pointerBits);
  const length = headerReader.word(width, pointerBits);
  if (length > BigInt(fileSize))
    throw new BinaryFormatFailure(
      "malformed",
      "Go build-info pointer string length exceeds the file extent",
    );
  const size = Number(length);
  // Zero-length Go strings may carry a zero data pointer.
  const offset =
    size === 0 && valueAddress === 0n
      ? header
      : mappedFileOffset(mappings, valueAddress, size, zeroFills);
  if (length > BigInt(maximumBytes))
    throw new BinaryResourceFailure(
      "build-info",
      maximumBytes,
      `Go build-info pointer string length exceeds max_build_info_bytes=${String(maximumBytes)}`,
    );
  return {
    bytes:
      size === 0
        ? Buffer.alloc(0)
        : yield { offset, length: size, label: "Go build-info pointer string" },
    location: { offset, bytes: size },
  };
}

function* readOptionalModuleStringSteps(
  context: PointerStringContext,
  address: bigint,
  pointerField: number,
  pointerBits: 32 | 64,
): Generator<BuildInfoRead, LocatedString, Buffer> {
  if (
    isZeroFilledSpan(
      context.mappings,
      context.zeroFills,
      address,
      (pointerBits / 8) * 2,
    )
  )
    return {
      bytes: Buffer.alloc(0),
      location: { offset: pointerField, bytes: 0 },
    };
  return yield* readPointerStringSteps(context, address, pointerBits);
}

function* readBuildInfoString({
  offset,
  bytes: length,
}: GoStringLocation): Generator<BuildInfoRead, Buffer, Buffer> {
  return length === 0
    ? Buffer.alloc(0)
    : yield { offset, length, label: "Go build-info string" };
}
