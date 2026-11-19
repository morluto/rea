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

export const elfDynamicEntryWidth = (bits: 32 | 64): 8 | 16 =>
  bits === 64 ? 16 : 8;

const readDynamicWords = (
  view: DataView,
  offset: number,
  width: 8 | 16,
  littleEndian: boolean,
) => ({
  tag:
    width === 16
      ? view.getBigInt64(offset, littleEndian)
      : BigInt(view.getInt32(offset, littleEndian)),
  value:
    width === 16
      ? view.getBigUint64(offset + 8, littleEndian)
      : BigInt(view.getUint32(offset + 4, littleEndian)),
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
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return ok(readDynamicWords(view, 0, width, littleEndian));
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
 * to the span. DT_NULL closes the table and its value has no meaning. Only
 * tags the caller consumes as singletons are tracked, so ignored extensions
 * and repeated DT_NEEDED do not enlarge the reader's retained state.
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
  { readonly terminatorOffset: number | null },
  DynamicTableFailure<E>
> => {
  const width = elfDynamicEntryWidth(bits);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstOffsets = new Map<bigint, number>();
  for (let offset = 0; offset + width <= bytes.byteLength; offset += width) {
    const { tag, value } = readDynamicWords(view, offset, width, littleEndian);
    if (tag === 0n) return ok({ terminatorOffset: offset });
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
  return ok({ terminatorOffset: null });
};
