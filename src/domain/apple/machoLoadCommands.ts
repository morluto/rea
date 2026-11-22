import { BinaryReader } from "../binaryContainer.js";
import { LC } from "./machoLoadCommandCodes.js";
import { err, ok, type Result } from "../result.js";
import {
  machoLoadCommandAlignment,
  readMachoHeaderPrefixFacts,
} from "./machoContainer.js";

const MACHO_LOAD_COMMAND_HEADER_BYTES = 8;

/** Read numeric fields from exactly the supplied Mach-O view. */
export const machoWordReader = (
  bytes: Uint8Array,
  littleEndian: boolean,
): BinaryReader =>
  new BinaryReader(
    Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    littleEndian,
    "macho",
  );

/** Header commitments needed to walk commands without retaining their payloads. */
export interface MachoLoadCommandTableHeader {
  readonly headerSize: 28 | 32;
  readonly wide: boolean;
  readonly littleEndian: boolean;
  readonly commandCount: number;
  readonly commandBytes: number;
}

/** Byte offset of `mach_header.flags`, shared by the 32- and 64-bit headers. */
export const MACHO_HEADER_FLAGS_OFFSET = 24;

export interface MachoHeaderDeclarations extends MachoLoadCommandTableHeader {
  readonly fileType: number;
  readonly flags: number;
  readonly identity: { readonly cpuType: number; readonly cpuSubtype: number };
}

/** Decode the common 28-byte header without requiring the 64-bit reserved word. */
export const readMachoHeaderDeclarations = (
  bytes: Uint8Array,
  fileSize: number,
): Result<MachoHeaderDeclarations | null, string> => {
  const prefix = readMachoHeaderPrefixFacts(bytes);
  if (prefix.format === null) return ok(null);
  const { wide, headerSize, littleEndian } = prefix.format;
  if (bytes.byteLength < 28 || prefix.identity === null)
    return err(
      `truncated Mach-O header: a ${wide ? 64 : 32}-bit header needs ${headerSize} bytes; the file has ${fileSize}`,
    );
  const reader = machoWordReader(bytes, littleEndian);
  const commandBytes = reader.u32(20);
  return ok({
    headerSize,
    wide,
    littleEndian,
    commandCount: reader.u32(16),
    commandBytes,
    fileType: reader.u32(12),
    flags: reader.u32(MACHO_HEADER_FLAGS_OFFSET),
    identity: prefix.identity,
  });
};

/** Require the full declared 28/32-byte thin header, without admitting its command table. */
export const readMachoLoadCommandDeclarations = (
  bytes: Uint8Array,
  fileSize: number,
): Result<MachoHeaderDeclarations | null, string> => {
  const parsed = readMachoHeaderDeclarations(bytes, fileSize);
  if (!parsed.ok || parsed.value === null) return parsed;
  const { wide, headerSize } = parsed.value;
  if (bytes.byteLength < headerSize)
    return err(
      `truncated Mach-O header: a ${wide ? 64 : 32}-bit header needs ${headerSize} bytes; the file has ${fileSize}`,
    );
  return parsed;
};

/** The file span and minimum count framing must fit before payloads are read. */
export const machoCommandTableIssue = (
  {
    commandBytes,
    commandCount,
    headerSize,
  }: Pick<
    MachoLoadCommandTableHeader,
    "commandBytes" | "commandCount" | "headerSize"
  >,
  fileSize: number,
): { readonly kind: "extent" | "count"; readonly message: string } | null => {
  if (commandBytes > fileSize - headerSize)
    return {
      kind: "extent",
      message: `truncated Mach-O load commands: the header declares ${commandBytes} bytes after its ${headerSize}-byte header; the file has ${fileSize}`,
    };
  if (commandCount * MACHO_LOAD_COMMAND_HEADER_BYTES > commandBytes)
    return {
      kind: "count",
      message: `Mach-O load command count ${commandCount} cannot fit in its ${commandBytes}-byte command table`,
    };
  return null;
};

/** Admit the declared command table within the complete file's extent. */
export const readMachoLoadCommandTableHeader = (
  bytes: Uint8Array,
  fileSize: number,
): Result<MachoHeaderDeclarations | null, string> => {
  const parsed = readMachoLoadCommandDeclarations(bytes, fileSize);
  if (!parsed.ok || parsed.value === null) return parsed;
  const issue = machoCommandTableIssue(parsed.value, fileSize);
  return issue === null ? parsed : err(issue.message);
};

/** One owner's count, alignment and extent proof for a sequential command walk. */
export class MachoLoadCommandCursor {
  #index = 0;
  #offset = 0;

  constructor(
    private readonly table: Pick<
      MachoLoadCommandTableHeader,
      "wide" | "littleEndian" | "commandCount" | "commandBytes"
    >,
  ) {}

  /** Offset relative to the command table; null when every declared row was read. */
  get nextOffset(): number | null {
    return this.#index < this.table.commandCount ? this.#offset : null;
  }

  /** Consume exactly one command's eight-byte header, leaving its payload to callers. */
  read(bytes: Uint8Array): Result<
    {
      readonly index: number;
      readonly offset: number;
      readonly command: number;
      readonly size: number;
    },
    string
  > {
    const { commandBytes, littleEndian, wide } = this.table;
    if (
      this.#offset + MACHO_LOAD_COMMAND_HEADER_BYTES > commandBytes ||
      bytes.byteLength < MACHO_LOAD_COMMAND_HEADER_BYTES
    )
      return err(`load command ${this.#index} starts beyond sizeofcmds`);
    const reader = machoWordReader(bytes, littleEndian);
    const size = reader.u32(4);
    if (
      size < MACHO_LOAD_COMMAND_HEADER_BYTES ||
      size % machoLoadCommandAlignment(wide) !== 0 ||
      size > commandBytes - this.#offset
    )
      return err(
        `load command ${this.#index} at offset ${this.#offset} has invalid cmdsize ${size}`,
      );
    const frame = {
      index: this.#index,
      offset: this.#offset,
      command: reader.u32(0),
      size,
    };
    this.#index += 1;
    this.#offset += size;
    return ok(frame);
  }

  /** A successful walk must exhaust both ncmds and sizeofcmds. */
  finish(): Result<null, string> {
    return this.#index === this.table.commandCount &&
      this.#offset === this.table.commandBytes
      ? ok(null)
      : err(
          `load commands declare ${this.table.commandCount} commands but sizeofcmds holds ${this.table.commandBytes} bytes`,
        );
  }
}

// Fields with fixed uint32 layouts in mach-o/loader.h. This table is the single
// owner of those layouts; consumers read decoded fields rather than offsets.
const DYLD_INFO_WORD_FIELDS = [
  "rebase_off",
  "rebase_size",
  "bind_off",
  "bind_size",
  "weak_bind_off",
  "weak_bind_size",
  "lazy_bind_off",
  "lazy_bind_size",
  "export_off",
  "export_size",
] as const;

const FIXED_WORD_FIELDS: ReadonlyMap<number, readonly string[]> = new Map<
  number,
  readonly string[]
>([
  [LC.SYMTAB, ["symoff", "nsyms", "stroff", "strsize"]],
  [LC.SYMSEG, ["offset", "size"]],
  [
    LC.DYSYMTAB,
    [
      "ilocalsym",
      "nlocalsym",
      "iextdefsym",
      "nextdefsym",
      "iundefsym",
      "nundefsym",
      "tocoff",
      "ntoc",
      "modtaboff",
      "nmodtab",
      "extrefsymoff",
      "nextrefsyms",
      "indirectsymoff",
      "nindirectsyms",
      "extreloff",
      "nextrel",
      "locreloff",
      "nlocrel",
    ],
  ],
  [LC.TWOLEVEL_HINTS, ["offset", "nhints"]],
  [LC.PREBIND_CKSUM, ["cksum"]],
  [LC.CODE_SIGNATURE, ["dataoff", "datasize"]],
  [LC.SEGMENT_SPLIT_INFO, ["dataoff", "datasize"]],
  [LC.ENCRYPTION_INFO, ["cryptoff", "cryptsize", "cryptid"]],
  [LC.DYLD_INFO, DYLD_INFO_WORD_FIELDS],
  [LC.DYLD_INFO_ONLY, DYLD_INFO_WORD_FIELDS],
  [LC.FUNCTION_STARTS, ["dataoff", "datasize"]],
  [LC.DATA_IN_CODE, ["dataoff", "datasize"]],
  [LC.DYLIB_CODE_SIGN_DRS, ["dataoff", "datasize"]],
  [LC.ENCRYPTION_INFO_64, ["cryptoff", "cryptsize", "cryptid", "pad"]],
  [LC.LINKER_OPTIMIZATION_HINT, ["dataoff", "datasize"]],
  [LC.DYLD_EXPORTS_TRIE, ["dataoff", "datasize"]],
  [LC.DYLD_CHAINED_FIXUPS, ["dataoff", "datasize"]],
  [LC.ATOM_INFO, ["dataoff", "datasize"]],
  [LC.FUNCTION_VARIANTS, ["dataoff", "datasize"]],
  [LC.FUNCTION_VARIANT_FIXUPS, ["dataoff", "datasize"]],
  [LC.LAZY_LOAD_DYLIB_INFO, ["dataoff", "datasize"]],
]);

/** Names of a command's fixed uint32 fields, or undefined for other layouts. */
export const machoFixedWordFieldNames = (
  command: number,
): readonly string[] | undefined => FIXED_WORD_FIELDS.get(command);

/**
 * Decode a command's fixed uint32 fields from the bytes after its 8-byte
 * header. Undefined for commands without a fixed layout; null when truncated.
 */
export const decodeMachoFixedWordFields = (
  command: number,
  fieldBytes: Uint8Array,
  littleEndian: boolean,
): Readonly<Record<string, number>> | null | undefined => {
  const names = FIXED_WORD_FIELDS.get(command);
  return names === undefined
    ? undefined
    : decodeMachoWordFields(names, fieldBytes, littleEndian);
};

const decodeMachoWordFields = <Field extends string>(
  names: readonly Field[],
  fieldBytes: Uint8Array,
  littleEndian: boolean,
): Readonly<Record<Field, number>> | null => {
  if (fieldBytes.byteLength < names.length * 4) return null;
  const reader = machoWordReader(fieldBytes, littleEndian);
  return Object.fromEntries(
    names.map((name, index) => [name, reader.u32(index * 4)]),
  ) as Readonly<Record<Field, number>>;
};

/** Typed `dyld_info_command` facts from a framed command, including its header. */
export const readMachoDyldInfoCommand = (
  body: Uint8Array,
  littleEndian: boolean,
) =>
  decodeMachoWordFields(DYLD_INFO_WORD_FIELDS, body.subarray(8), littleEndian);

interface MachoSymtabDeclaration {
  readonly symoff: number;
  readonly nsyms: number;
  readonly stroff: number;
  readonly strsize: number;
}

/** `symtab_command` fields from an admitted command body. Null when truncated. */
export const readMachoSymtabCommand = (
  body: Uint8Array,
  littleEndian: boolean,
): MachoSymtabDeclaration | null => {
  const fields = decodeMachoFixedWordFields(
    LC.SYMTAB,
    body.subarray(8),
    littleEndian,
  );
  if (fields === null || fields === undefined) return null;
  const { symoff, nsyms, stroff, strsize } = fields;
  if (
    symoff === undefined ||
    nsyms === undefined ||
    stroff === undefined ||
    strsize === undefined
  )
    return null;
  return { symoff, nsyms, stroff, strsize };
};

/** Admit slice-relative LC_SYMTAB ranges before applying a consumer's scan allowance. */
export const admitMachoSymtabRanges = (
  { symoff, nsyms, stroff, strsize }: MachoSymtabDeclaration,
  wide: boolean,
  sliceSize: number,
): {
  readonly width: 12 | 16;
  readonly symbolsEnd: number;
  readonly stringsEnd: number;
} | null => {
  const width = wide ? 16 : 12;
  const symbolsEnd = symoff + nsyms * width;
  const stringsEnd = stroff + strsize;
  return symbolsEnd <= sliceSize && stringsEnd <= sliceSize
    ? { width, symbolsEnd, stringsEnd }
    : null;
};

/**
 * `linkedit_data_command` fields from an admitted command body. Null when
 * truncated or when `command` does not use the linkedit_data_command layout.
 */
export const readMachoLinkeditDataCommand = (
  command: number,
  body: Uint8Array,
  littleEndian: boolean,
): { readonly dataOffset: number; readonly dataSize: number } | null => {
  const fields = decodeMachoFixedWordFields(
    command,
    body.subarray(8),
    littleEndian,
  );
  if (fields === null || fields === undefined) return null;
  const { dataoff, datasize } = fields;
  if (dataoff === undefined || datasize === undefined) return null;
  return { dataOffset: dataoff, dataSize: datasize };
};

export type MachoCommandStringFailure =
  | {
      readonly _tag: "InvalidMachoCommandString";
      readonly reason: "truncated-offset" | "unterminated";
    }
  | {
      readonly _tag: "InvalidMachoCommandString";
      readonly reason: "invalid-offset";
      readonly offset: number;
    };

/** Locate an lc_str payload within one admitted command; callers own text interpretation. */
export const readMachoCommandStringBytes = (
  body: Uint8Array,
  minimumOffset: number,
  littleEndian: boolean,
): Result<
  { readonly offset: number; readonly bytes: Uint8Array },
  MachoCommandStringFailure
> => {
  if (body.byteLength < 12)
    return err({
      _tag: "InvalidMachoCommandString",
      reason: "truncated-offset",
    });
  const reader = machoWordReader(body, littleEndian);
  const offset = reader.u32(8);
  if (offset < minimumOffset || offset >= body.byteLength)
    return err({
      _tag: "InvalidMachoCommandString",
      reason: "invalid-offset",
      offset,
    });
  const end = body.indexOf(0, offset);
  if (end < 0)
    return err({ _tag: "InvalidMachoCommandString", reason: "unterminated" });
  return ok({ offset, bytes: body.subarray(offset, end) });
};
