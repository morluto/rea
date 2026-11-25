import { BinaryReader } from "./binaryContainer.js";
import { err, ok } from "./result.js";
import type { FileMapping, ZeroFillMapping } from "./virtualFileMapping.js";

export const PT_INTERP = 3;

export const elfProgramHeaderWidth = (bits: 32 | 64): 32 | 56 =>
  bits === 64 ? 56 : 32;

export type ElfProgramHeader = Extract<
  ReturnType<typeof readElfProgramHeader>,
  { readonly ok: true }
>["value"];

/** Fixed ELF32/ELF64 program declarations; consumers own type, precision and mapping admission. */
export const readElfProgramHeader = (
  bytes: Uint8Array,
  bits: 32 | 64,
  littleEndian: boolean,
) => {
  const wide = bits === 64;
  if (bytes.byteLength < elfProgramHeaderWidth(bits))
    return err({
      kind: "malformed" as const,
      message: "ELF program header is truncated",
    });
  const reader = new BinaryReader(
    Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    littleEndian,
    "elf",
  );
  return ok({
    type: reader.u32(0),
    flags: reader.u32(wide ? 4 : 24),
    offset: reader.word(wide ? 8 : 4, bits),
    virtualAddress: reader.word(wide ? 16 : 8, bits),
    physicalAddress: reader.word(wide ? 24 : 12, bits),
    fileSize: reader.word(wide ? 32 : 16, bits),
    memorySize: reader.word(wide ? 40 : 20, bits),
    alignment: reader.word(wide ? 48 : 28, bits),
  });
};

/** Admit PT_LOAD sizes once for consumers that read through load mappings. */
export const admitElfLoadSegment = (
  segment: {
    readonly virtualAddress: bigint;
    readonly memorySize: bigint;
    readonly fileSize: bigint;
  },
  bits: 32 | 64,
) =>
  segment.fileSize > segment.memorySize ||
  segment.virtualAddress + segment.memorySize > 1n << BigInt(bits)
    ? err({
        kind: "malformed" as const,
        message: "ELF load segment sizes or addresses are invalid",
      })
    : ok(null);

export interface ElfLoadMappings {
  readonly fileBacked: readonly FileMapping[];
  readonly zeroFills: readonly ZeroFillMapping[];
}

/** Project an admitted PT_LOAD into its file-backed prefix and zero-filled tail. */
export const elfLoadSpans = ({
  virtualAddress,
  offset,
  fileSize,
  memorySize,
}: Pick<
  ElfProgramHeader,
  "virtualAddress" | "offset" | "fileSize" | "memorySize"
>): {
  readonly fileBacked: FileMapping | undefined;
  readonly zeroFill: ZeroFillMapping | undefined;
} => ({
  fileBacked:
    fileSize === 0n
      ? undefined
      : {
          address: virtualAddress,
          offset: Number(offset),
          size: Number(fileSize),
        },
  zeroFill:
    memorySize > fileSize
      ? { address: virtualAddress + fileSize, size: memorySize - fileSize }
      : undefined,
});
