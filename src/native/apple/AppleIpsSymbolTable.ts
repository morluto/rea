import { readMachoSymtabCommand } from "../../domain/apple/machoLoadCommands.js";
import type { RecordedInteger } from "../../domain/native/appleIps.js";
import { machoRuntimeSymbolName } from "../../domain/native/machoSymbolName.js";

/**
 * Symbol-table resolution for Apple .ips Mach-O joins.
 *
 * A joined frame already carries its static address (slice `__TEXT` vmaddr
 * plus the recorded `imageOffset`). This module answers the remaining
 * question from the joined slice itself: which symbol-table symbol contains
 * that address. Only `LC_SYMTAB` `nlist` entries are read; DWARF debug info
 * is never consulted, so a stripped slice simply resolves nothing.
 *
 * Symbols are section symbols (`N_SECT`) whose value falls inside one of
 * the slice's admitted segments. Resolution is the nearest preceding symbol
 * in the same segment as the static address, the same rule `atos` applies.
 * The symbol-table name stays the source fact; the runtime spelling drops
 * the one leading underscore Darwin compilers add.
 */

export interface AppleIpsJoinSegment {
  readonly address: bigint;
  readonly size: bigint;
}

export interface AppleIpsJoinSymbol {
  readonly name: string;
  readonly runtimeName: string | null;
  readonly value: bigint;
}

export type AppleIpsJoinSymbolTable =
  | {
      readonly kind: "symbols";
      readonly symbols: readonly AppleIpsJoinSymbol[];
    }
  | { readonly kind: "absent" }
  | { readonly kind: "unusable"; readonly reason: string };

export interface AppleIpsJoinFrameSymbol {
  readonly name: string;
  readonly runtimeName: string | null;
  readonly address: bigint;
  readonly offset: bigint;
}

/**
 * Schema-shaped containing symbol for a joined frame, or null when no
 * symbol in the static address's segment starts at or before it.
 * `recordUnsigned` retains the derived integers with the caller's reader.
 */
export const appleIpsJoinFrameSymbol = (
  symbols: readonly AppleIpsJoinSymbol[],
  segments: readonly AppleIpsJoinSegment[],
  staticAddress: bigint,
  recordUnsigned: (value: bigint) => RecordedInteger,
): {
  readonly name: string;
  readonly runtime_name: string | null;
  readonly address: RecordedInteger;
  readonly offset: RecordedInteger;
} | null => {
  const resolved = resolveAppleIpsJoinSymbol(symbols, segments, staticAddress);
  if (resolved === null) return null;
  return {
    name: resolved.name,
    runtime_name: resolved.runtimeName,
    address: recordUnsigned(resolved.address),
    offset: recordUnsigned(resolved.offset),
  };
};

/** Hard ceiling on symbol-table entries retained from one joined slice. */
export const MAX_APPLE_IPS_JOIN_SYMBOLS = 1048576;
/** Longest symbol-table name retained; longer names are skipped, not cut. */
const MAX_SYMBOL_NAME_BYTES = 1024;

const N_STAB = 0xe0;
const N_TYPE = 0x0e;
const N_SECT = 0x0e;

const utf8 = new TextDecoder("utf-8", { fatal: true });

const symbolName = (
  bytes: Buffer,
  strtab: number,
  strsize: number,
  strx: number,
): string | null => {
  if (strx === 0 || strx >= strsize) return null;
  const start = strtab + strx;
  const end = bytes.indexOf(0, start);
  if (end === -1 || end >= strtab + strsize) return null;
  if (end - start > MAX_SYMBOL_NAME_BYTES) return null;
  if (end === start) return null;
  try {
    return utf8.decode(bytes.subarray(start, end));
  } catch {
    return null;
  }
};

/**
 * Read the `LC_SYMTAB` table of one slice. `symtabCommand` is the admitted
 * command body, or null when the slice carries no `LC_SYMTAB`. Offsets in
 * the command are slice-relative. Returns `absent` when there is no command
 * and `unusable` with a reason when the table cannot be trusted.
 */
export const readAppleIpsJoinSymbols = (input: {
  readonly bytes: Buffer;
  readonly headerSize: number;
  readonly wide: boolean;
  readonly littleEndian: boolean;
  readonly symtabCommand: Uint8Array | null;
  readonly segments: readonly AppleIpsJoinSegment[];
}): AppleIpsJoinSymbolTable => {
  const { bytes, headerSize, wide, littleEndian, symtabCommand, segments } =
    input;
  if (symtabCommand === null) return { kind: "absent" };
  const symtab = readMachoSymtabCommand(symtabCommand, littleEndian);
  if (symtab === null)
    return { kind: "unusable", reason: "LC_SYMTAB command is truncated" };
  const { symoff, nsyms, stroff, strsize } = symtab;
  if (nsyms > MAX_APPLE_IPS_JOIN_SYMBOLS)
    return {
      kind: "unusable",
      reason: `LC_SYMTAB declares ${String(nsyms)} entries, above the ${String(MAX_APPLE_IPS_JOIN_SYMBOLS)}-entry ceiling`,
    };
  const entrySize = wide ? 16 : 12;
  if (
    symoff < headerSize ||
    stroff < headerSize ||
    nsyms * entrySize > bytes.length - symoff ||
    strsize > bytes.length - stroff
  )
    return {
      kind: "unusable",
      reason: "LC_SYMTAB table or string table lies outside the slice",
    };
  const read32 = (at: number): number =>
    littleEndian ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);
  const read64 = (at: number): bigint =>
    littleEndian ? bytes.readBigUInt64LE(at) : bytes.readBigUInt64BE(at);
  const symbols: AppleIpsJoinSymbol[] = [];
  for (let index = 0; index < nsyms; index += 1) {
    const at = symoff + index * entrySize;
    const strx = read32(at);
    const type = bytes.readUInt8(at + 4);
    if ((type & N_STAB) !== 0 || (type & N_TYPE) !== N_SECT) continue;
    const value = wide ? read64(at + 8) : BigInt(read32(at + 8));
    if (
      !segments.some(
        (segment) =>
          segment.size > 0n &&
          value >= segment.address &&
          value < segment.address + segment.size,
      )
    )
      continue;
    const name = symbolName(bytes, stroff, strsize, strx);
    if (name === null) continue;
    symbols.push({
      name,
      runtimeName: machoRuntimeSymbolName(name),
      value,
    });
  }
  symbols.sort((left, right) => {
    if (left.value !== right.value) return left.value < right.value ? -1 : 1;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  const deduped = symbols.filter(
    (symbol, index) =>
      index === 0 ||
      symbol.value !== symbols[index - 1]?.value ||
      symbol.name !== symbols[index - 1]?.name,
  );
  return { kind: "symbols", symbols: deduped };
};

/**
 * Containing symbol for a static address: the nearest preceding symbol in
 * the same segment. Returns null when no symbol in that segment starts at
 * or before the address.
 */
export const resolveAppleIpsJoinSymbol = (
  symbols: readonly AppleIpsJoinSymbol[],
  segments: readonly AppleIpsJoinSegment[],
  staticAddress: bigint,
): AppleIpsJoinFrameSymbol | null => {
  const segment = segments.find(
    (candidate) =>
      candidate.size > 0n &&
      staticAddress >= candidate.address &&
      staticAddress < candidate.address + candidate.size,
  );
  if (segment === undefined) return null;
  let low = 0;
  let high = symbols.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const middleValue = symbols[middle]?.value;
    if (middleValue === undefined || middleValue > staticAddress) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  for (let index = low - 1; index >= 0; index -= 1) {
    const symbol = symbols[index];
    if (symbol === undefined) return null;
    if (
      symbol.value >= segment.address &&
      symbol.value < segment.address + segment.size
    )
      return {
        name: symbol.name,
        runtimeName: symbol.runtimeName,
        address: symbol.value,
        offset: staticAddress - symbol.value,
      };
  }
  return null;
};
