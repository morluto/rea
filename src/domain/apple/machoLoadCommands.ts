import { err, ok, type Result } from "../result.js";
import {
  machoLoadCommandAlignment,
  readMachoHeaderPrefixFacts,
} from "./machoContainer.js";

/** Header commitments needed to walk commands without retaining their payloads. */
export interface MachoLoadCommandTableHeader {
  readonly headerSize: 28 | 32;
  readonly wide: boolean;
  readonly littleEndian: boolean;
  readonly commandCount: number;
  readonly commandBytes: number;
}

const LC_SYMTAB = 0x2;

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
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const commandBytes = view.getUint32(20, littleEndian);
  return ok({
    headerSize,
    wide,
    littleEndian,
    commandCount: view.getUint32(16, littleEndian),
    commandBytes,
    fileType: view.getUint32(12, littleEndian),
    flags: view.getUint32(MACHO_HEADER_FLAGS_OFFSET, littleEndian),
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

/** Admit the declared command table within the complete file's extent. */
export const readMachoLoadCommandTableHeader = (
  bytes: Uint8Array,
  fileSize: number,
): Result<MachoHeaderDeclarations | null, string> => {
  const parsed = readMachoLoadCommandDeclarations(bytes, fileSize);
  if (!parsed.ok || parsed.value === null) return parsed;
  const { commandBytes, headerSize } = parsed.value;
  if (commandBytes > fileSize - headerSize)
    return err(
      `truncated Mach-O load commands: the header declares ${commandBytes} bytes after its ${headerSize}-byte header; the file has ${fileSize}`,
    );
  return parsed;
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
    if (this.#offset + 8 > commandBytes || bytes.byteLength < 8)
      return err(`load command ${this.#index} starts beyond sizeofcmds`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = view.getUint32(4, littleEndian);
    if (
      size < 8 ||
      size % machoLoadCommandAlignment(wide) !== 0 ||
      size > commandBytes - this.#offset
    )
      return err(
        `load command ${this.#index} at offset ${this.#offset} has invalid cmdsize ${size}`,
      );
    const frame = {
      index: this.#index,
      offset: this.#offset,
      command: view.getUint32(0, littleEndian),
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
const FIXED_WORD_FIELDS: ReadonlyMap<number, readonly string[]> = new Map([
  [0x2, ["symoff", "nsyms", "stroff", "strsize"]],
  [0x3, ["offset", "size"]],
  [
    0xb,
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
  [0x16, ["offset", "nhints"]],
  [0x17, ["cksum"]],
  [0x1d, ["dataoff", "datasize"]],
  [0x1e, ["dataoff", "datasize"]],
  [0x21, ["cryptoff", "cryptsize", "cryptid"]],
  [
    0x22,
    [
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
    ],
  ],
  [
    0x80000022,
    [
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
    ],
  ],
  [0x26, ["dataoff", "datasize"]],
  [0x29, ["dataoff", "datasize"]],
  [0x2b, ["dataoff", "datasize"]],
  [0x2c, ["cryptoff", "cryptsize", "cryptid", "pad"]],
  [0x2e, ["dataoff", "datasize"]],
  [0x80000033, ["dataoff", "datasize"]],
  [0x80000034, ["dataoff", "datasize"]],
  [0x36, ["dataoff", "datasize"]],
  [0x37, ["dataoff", "datasize"]],
  [0x38, ["dataoff", "datasize"]],
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
  if (names === undefined) return undefined;
  if (fieldBytes.byteLength < names.length * 4) return null;
  const view = new DataView(
    fieldBytes.buffer,
    fieldBytes.byteOffset,
    fieldBytes.byteLength,
  );
  return Object.fromEntries(
    names.map((name, index) => [name, view.getUint32(index * 4, littleEndian)]),
  );
};

/** `symtab_command` fields from an admitted command body. Null when truncated. */
export const readMachoSymtabCommand = (
  body: Uint8Array,
  littleEndian: boolean,
): {
  readonly symoff: number;
  readonly nsyms: number;
  readonly stroff: number;
  readonly strsize: number;
} | null => {
  const fields = decodeMachoFixedWordFields(
    LC_SYMTAB,
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
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const offset = view.getUint32(8, littleEndian);
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
