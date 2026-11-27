import {
  BinaryReader,
  DEFAULT_NATIVE_STRUCTURE_BYTES,
} from "./binaryContainer.js";
import { err, ok, type Result } from "./result.js";

export const DT_NEEDED = 1n;
export const DT_HASH = 4n;
export const DT_STRTAB = 5n;
export const DT_SYMTAB = 6n;
export const DT_STRSZ = 10n;
export const DT_SYMENT = 11n;
export const DT_RPATH = 15n;
export const DT_RUNPATH = 29n;
export const DT_FLAGS = 30n;
export const DT_GNU_HASH = 0x6ffffef5n;
export const DT_FLAGS_1 = 0x6ffffffbn;

const elfDynamicEntryWidth = (bits: 32 | 64): 8 | 16 => (bits === 64 ? 16 : 8);

/** Geometry of a bounded file extent, independent of the logical DT_NULL. */
export const elfDynamicTableGeometry = (bytes: number, bits: 32 | 64) => {
  const width = elfDynamicEntryWidth(bits);
  const trailingBytes = bytes % width;
  return { width, completeBytes: bytes - trailingBytes, trailingBytes };
};

/** Admit the strict native directory before applying its byte budget. */
export const admitElfDynamicDirectory = (
  fileBytes: number,
  span: { readonly offset: bigint; readonly size: bigint },
  bits: 32 | 64,
  maximum: number = DEFAULT_NATIVE_STRUCTURE_BYTES,
): Result<
  { readonly offset: number; readonly size: number; readonly width: number },
  | { readonly kind: "malformed"; readonly message: string }
  | {
      readonly kind: "capacity";
      readonly message: string;
      readonly size: number;
      readonly maximum: number;
    }
> => {
  const malformed = () =>
    err({
      kind: "malformed" as const,
      message: "PT_DYNAMIC is truncated or outside the file",
    });
  if (
    span.offset < 0n ||
    span.size < 0n ||
    span.offset + span.size > BigInt(fileBytes)
  )
    return malformed();
  const size = Number(span.size);
  const { width, trailingBytes } = elfDynamicTableGeometry(size, bits);
  if (trailingBytes !== 0) return malformed();
  if (size > maximum)
    return err({
      kind: "capacity",
      message: `ELF dynamic directory requires ${String(size)} bytes, above the ${String(maximum)}-byte structural allowance`,
      size,
      maximum,
    });
  return ok({ offset: Number(span.offset), size, width });
};

const dynamicReader = (
  bytes: Uint8Array,
  littleEndian: boolean,
): BinaryReader =>
  new BinaryReader(
    Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    littleEndian,
    "elf",
  );

const readDynamicWords = (
  reader: BinaryReader,
  offset: number,
  bits: 32 | 64,
) => ({
  tag: bits === 64 ? reader.i64(offset) : BigInt(reader.i32(offset)),
  value: reader.word(offset + bits / 8, bits),
});

/** Fixed Elf32_Dyn/Elf64_Dyn: signed d_tag and unsigned d_un, without tag or value admission. */
export const readElfDynamicEntry = (
  bytes: Uint8Array,
  bits: 32 | 64,
  littleEndian: boolean,
) => {
  const width = elfDynamicEntryWidth(bits);
  if (bytes.byteLength < width)
    return err({
      kind: "malformed" as const,
      message: "ELF dynamic entry is truncated",
    });
  const reader = dynamicReader(bytes, littleEndian);
  return ok(readDynamicWords(reader, 0, bits));
};

type DynamicRow = ReturnType<typeof readDynamicWords> & {
  readonly offset: number;
  readonly singleton: boolean;
};

type DynamicTableFailure<E> =
  | {
      readonly kind: "duplicate-singleton";
      readonly tag: bigint;
      readonly firstOffset: number;
      readonly offset: number;
    }
  | { readonly kind: "visitor"; readonly error: E };

/**
 * Walk an admitted dynamic-table byte span in order. All offsets are relative
 * to the span. DT_NULL closes the table and its value has no meaning. Report
 * incomplete trailing bytes independently of the terminator. Only tags the
 * caller consumes as singletons are tracked, so ignored extensions and
 * repeated DT_NEEDED do not enlarge the reader's retained state.
 */
export const walkElfDynamicTable = <E>(
  bytes: Uint8Array,
  {
    bits,
    littleEndian,
  }: { readonly bits: 32 | 64; readonly littleEndian: boolean },
  singletonTags: ReadonlySet<bigint>,
  visit: (row: DynamicRow) => Result<void, E> | void,
): Result<
  {
    readonly terminatorOffset: number | null;
    readonly trailingBytes: number;
  },
  DynamicTableFailure<E>
> => {
  const { width, completeBytes, trailingBytes } = elfDynamicTableGeometry(
    bytes.byteLength,
    bits,
  );
  const reader = dynamicReader(bytes, littleEndian);
  const firstOffsets = new Map<bigint, number>();
  for (let offset = 0; offset < completeBytes; offset += width) {
    const { tag, value } = readDynamicWords(reader, offset, bits);
    if (tag === 0n) return ok({ terminatorOffset: offset, trailingBytes });
    const singleton = singletonTags.has(tag);
    if (singleton) {
      const firstOffset = firstOffsets.get(tag);
      if (firstOffset !== undefined)
        return err({ kind: "duplicate-singleton", tag, firstOffset, offset });
      firstOffsets.set(tag, offset);
    }
    const visited = visit({ tag, value, offset, singleton });
    if (visited !== undefined && !visited.ok)
      return err({ kind: "visitor", error: visited.error });
  }
  return ok({ terminatorOffset: null, trailingBytes });
};
