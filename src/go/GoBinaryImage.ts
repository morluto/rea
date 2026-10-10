import {
  GoBinaryFormatFailure,
  GoBinaryResourceFailure,
  GoBinaryReader,
  goUtf8,
  mappedFileOffset,
  isZeroFilledSpan,
  type GoBinaryContainer,
  type GoFileMapping,
} from "./GoBinaryContainer.js";
import { readGoElfImage } from "./GoElfImage.js";
import { readGoMachoImage } from "./GoMachoImage.js";
import { readGoPeImage } from "./GoPeImage.js";

export {
  GoBinaryFormatFailure,
  GoBinaryResourceFailure,
} from "./GoBinaryContainer.js";

const MAGIC = Buffer.from("ff20476f206275696c64696e663a", "hex");
const MODULE_START = Buffer.from("3077af0c9274080241e1c107e6d618e6", "hex");
const MODULE_END = Buffer.from("f932433186182072008242104116d8f2", "hex");
const MAX_BUILD_INFO_BYTES = 1024 * 1024;

/** Exact file span of one embedded string's contents, excluding its length/header. */
export interface GoStringLocation {
  readonly offset: number;
  readonly bytes: number;
}

/** Observed compiler string and validated module body with its original framing bytes. */
export interface GoBuildInfo {
  readonly header_offset: number;
  readonly encoding: "inline" | "pointer";
  readonly go_version: string | null;
  readonly go_version_bytes_base64: string;
  readonly module_text: string | null;
  readonly module_bytes_base64: string;
  readonly version_location: GoStringLocation;
  readonly module_location: GoStringLocation;
}

/** Native image identity and optional Go build information; absence is not a language verdict. */
export interface GoBinaryImage {
  readonly format: "elf" | "pe" | "macho";
  readonly architecture: string;
  readonly bits: 32 | 64;
  readonly byte_order: "little" | "big";
  readonly build_info: GoBuildInfo | null;
}

/** Inspect bounded executable bytes using native mappings, without loading or executing code. */
export const readGoBinaryImage = (bytes: Buffer): GoBinaryImage => {
  const container = readContainer(bytes);
  const { format, architecture, bits, byte_order } = container;
  const search = container.search;
  const header = findHeader(bytes, search);
  if (header === null || search === null)
    return { format, architecture, bits, byte_order, build_info: null };
  const verifyMapping = (size: number): void => {
    const address = search.address + BigInt(header - search.offset);
    if (
      mappedFileOffset(
        container.mappings,
        address,
        size,
        container.zero_fills,
      ) !== header
    )
      throw new GoBinaryFormatFailure(
        "malformed",
        "Go build-info bytes disagree with their virtual mapping",
      );
  };
  verifyMapping(32);
  const reader = new GoBinaryReader(bytes, byte_order === "little");
  const ptrSize = bytes[header + 14];
  const flags = bytes[header + 15] ?? 0;
  if ((flags & ~3) !== 0)
    throw new GoBinaryFormatFailure(
      "unsupported",
      "Go build-info flags contain an unsupported format bit",
    );
  if ((flags & 2) === 0 && (flags & 1) !== (byte_order === "big" ? 1 : 0))
    throw new GoBinaryFormatFailure(
      "malformed",
      "Go build-info byte order disagrees with the image",
    );
  const encoding = (flags & 2) !== 0 ? "inline" : "pointer";
  const readInline = (offset: number, remaining: number) =>
    readInlineString(reader, offset, remaining);
  const sourceEnd = search.offset + search.size;
  let version: LocatedString;
  let module: LocatedString;
  if (encoding === "inline") {
    version = readInline(header + 32, sourceEnd - header - 32);
    const next = version.location.offset + version.location.bytes;
    module = readInline(next, sourceEnd - next);
    verifyMapping(module.location.offset + module.location.bytes - header);
  } else {
    if (ptrSize !== 4 && ptrSize !== 8)
      throw new GoBinaryFormatFailure(
        "malformed",
        "Go build-info pointer width must be 4 or 8",
      );
    if (ptrSize * 8 !== bits)
      throw new GoBinaryFormatFailure(
        "malformed",
        "Go build-info pointer width disagrees with the image",
      );
    const pointerBits = ptrSize === 8 ? 64 : 32;
    version = readPointerString(
      reader,
      container,
      reader.word(header + 16, pointerBits),
    );
    const moduleField = header + 16 + ptrSize;
    module = readOptionalModuleString(
      reader,
      container,
      reader.word(moduleField, pointerBits),
      moduleField,
    );
  }
  if (version.location.bytes + module.location.bytes > MAX_BUILD_INFO_BYTES)
    throw new GoBinaryResourceFailure(
      "build-info",
      MAX_BUILD_INFO_BYTES,
      "Go build-info strings exceed the aggregate 1 MiB limit",
    );
  if (version.bytes.length === 0)
    throw new GoBinaryFormatFailure(
      "malformed",
      "Go build-info compiler version is empty",
    );
  const goVersion = observedText(version.bytes);
  let moduleText: string | null = "";
  if (module.bytes.length !== 0) {
    if (
      module.bytes.length < 33 ||
      !module.bytes.subarray(0, 16).equals(MODULE_START) ||
      !module.bytes.subarray(-16).equals(MODULE_END) ||
      module.bytes[module.bytes.length - 17] !== 10
    )
      throw new GoBinaryFormatFailure(
        "malformed",
        "Go module string framing is invalid",
      );
    moduleText = observedText(module.bytes.subarray(16, -16));
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
    },
  };
};

const observedText = (bytes: Buffer): string | null => {
  try {
    return goUtf8(bytes, "Go build string");
  } catch (cause) {
    if (cause instanceof GoBinaryFormatFailure) return null;
    throw cause;
  }
};

interface LocatedString {
  readonly bytes: Buffer;
  readonly location: GoStringLocation;
}

const readContainer = (bytes: Buffer): GoBinaryContainer => {
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
    return readGoElfImage(bytes);
  if (bytes.subarray(0, 2).equals(Buffer.from("MZ")))
    return readGoPeImage(bytes);
  if (bytes.length >= 4) {
    const magic = bytes.readUInt32BE();
    if ([0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic))
      throw new GoBinaryFormatFailure(
        "unsupported",
        "Universal/fat Mach-O containers require selecting a thin slice",
      );
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic))
      return readGoMachoImage(bytes);
  }
  throw new GoBinaryFormatFailure(
    "unsupported",
    "Only ELF, PE, and thin Mach-O native images are supported",
  );
};

const findHeader = (
  bytes: Buffer,
  search: GoFileMapping | null,
): number | null => {
  if (search === null || search.size === 0) return null;
  const end = search.offset + search.size;
  const selected = bytes.subarray(search.offset, end);
  let offset = Number((16n - (search.address % 16n)) % 16n);
  while (offset < selected.length) {
    const match = selected.indexOf(MAGIC, offset);
    if (match < 0) return null;
    const candidate = search.offset + match;
    const address = search.address + BigInt(candidate - search.offset);
    if (address % 16n === 0n) {
      if (end - candidate < 32)
        throw new GoBinaryFormatFailure(
          "malformed",
          "Go build-info header is truncated",
        );
      return candidate;
    }
    offset = match + 1;
  }
  return null;
};

const readInlineString = (
  reader: GoBinaryReader,
  offset: number,
  remaining: number,
): LocatedString => {
  let length = 0n;
  for (let index = 0; index < 10; index++) {
    if (index >= remaining)
      throw new GoBinaryFormatFailure(
        "malformed",
        "Go build-info varint is truncated",
      );
    const byte = reader.bytes[offset + index] ?? 0;
    if (index === 9 && byte > 1)
      throw new GoBinaryFormatFailure(
        "malformed",
        "Go build-info varint overflows 64 bits",
      );
    length |= BigInt(byte & 127) << BigInt(index * 7);
    if ((byte & 128) === 0) {
      if (length > BigInt(MAX_BUILD_INFO_BYTES))
        throw new GoBinaryResourceFailure(
          "build-info",
          MAX_BUILD_INFO_BYTES,
          "Go build-info string length exceeds the 1 MiB limit",
        );
      const size = Number(length);
      if (size > remaining - index - 1)
        throw new GoBinaryFormatFailure(
          "malformed",
          "Go build-info string range is truncated",
        );
      const start = offset + index + 1;
      return {
        bytes: reader.range(start, size, "Go build-info string"),
        location: { offset: start, bytes: size },
      };
    }
  }
  throw new GoBinaryFormatFailure(
    "malformed",
    "Go build-info varint is unterminated",
  );
};

const readPointerString = (
  reader: GoBinaryReader,
  container: GoBinaryContainer,
  address: bigint,
): LocatedString => {
  const { mappings, zero_fills: zeroFills, bits } = container;
  const width = bits / 8;
  const header = mappedFileOffset(mappings, address, width * 2, zeroFills);
  const valueAddress = reader.word(header, bits);
  const length = reader.word(header + width, bits);
  if (length > BigInt(MAX_BUILD_INFO_BYTES))
    throw new GoBinaryResourceFailure(
      "build-info",
      MAX_BUILD_INFO_BYTES,
      "Go build-info pointer string length exceeds the 1 MiB limit",
    );
  const size = Number(length);
  // Zero-length Go strings may carry a zero data pointer.
  const offset =
    size === 0 && valueAddress === 0n
      ? header
      : mappedFileOffset(mappings, valueAddress, size, zeroFills);
  return {
    bytes: reader.range(offset, size, "Go build-info pointer string"),
    location: { offset, bytes: size },
  };
};

const readOptionalModuleString = (
  reader: GoBinaryReader,
  container: GoBinaryContainer,
  address: bigint,
  pointerField: number,
): LocatedString =>
  isZeroFilledSpan(
    container.mappings,
    container.zero_fills,
    address,
    (container.bits / 8) * 2,
  )
    ? { bytes: Buffer.alloc(0), location: { offset: pointerField, bytes: 0 } }
    : readPointerString(reader, container, address);
