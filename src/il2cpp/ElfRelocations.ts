import { readElfRelocationEntry } from "../domain/elfRelocation.js";
import { readElfDynamicEntry } from "../domain/elfDynamicEntry.js";
import {
  BinaryMappingFailure,
  mappedFileOffset,
  isZeroFilledSpan,
  type BinaryContainer,
  type ElfDynamicSegment,
  type FileMapping,
  type ZeroFillMapping,
} from "../native/metadata/BinaryContainer.js";
import { Il2cppBinaryFormatFailure } from "./Il2cppBinaryFormat.js";

const DT_RELA = 7n,
  DT_RELASZ = 8n,
  DT_RELAENT = 9n;
const DT_PLTRELSZ = 2n,
  DT_PLTREL = 20n,
  DT_JMPREL = 23n;
const MAX_OVERLAY_ENTRIES = 65536;
const malformed = (message: string) =>
  new Il2cppBinaryFormatFailure("malformed-container", message);
const unsupported = (message: string) =>
  new Il2cppBinaryFormatFailure("unsupported-pointer-encoding", message);

interface RelocatedImage {
  readonly bytes: Buffer;
  readonly unresolved: Map<bigint, number>;
  readonly zeroFillPointers: Map<bigint, bigint>;
}
interface RelocationSource {
  readonly image: Buffer;
  readonly mappings: readonly FileMapping[];
  readonly zeroFills: readonly ZeroFillMapping[];
  readonly relative: number;
  readonly unknownPointerWidths: ReadonlyMap<number, number>;
}

/** Standard dynamic relocations whose destination spans at most eight bytes.
 * Other encodings (including COPY and TLS descriptors) need their own width
 * semantics; do not silently apply them or turn their stored zero into absence.
 */
const RELOCATION_KINDS = new Map([
  [
    183,
    {
      relative: 1027,
      unknownPointerWidths: new Map([
        [257, 8],
        [258, 4],
        [259, 2],
        [260, 8],
        [261, 4],
        [262, 2],
        [1025, 8],
        [1026, 8],
        [1028, 8],
        [1029, 8],
        [1030, 8],
        [1032, 8],
      ]),
    },
  ],
  [
    62,
    {
      relative: 8,
      unknownPointerWidths: new Map([
        [1, 8],
        [2, 4],
        [6, 8],
        [7, 8],
        [10, 4],
        [11, 4],
        [16, 8],
        [17, 8],
        [18, 8],
        [24, 8],
        [37, 8],
      ]),
    },
  ],
]);

function* dynamicTags(
  image: Buffer,
  declarations: readonly ElfDynamicSegment[],
): Generator<void, Map<bigint, bigint>> {
  yield;
  if (declarations.length > 1) throw malformed("multiple PT_DYNAMIC segments");
  const declaration = declarations[0];
  if (declaration === undefined)
    throw new Il2cppBinaryFormatFailure(
      "unsupported-container",
      "ELF image has no PT_DYNAMIC segment",
    );
  if (
    declaration.size % 16n !== 0n ||
    declaration.offset > BigInt(image.length) ||
    declaration.size > BigInt(image.length) - declaration.offset
  )
    throw malformed("PT_DYNAMIC is truncated or outside the file");
  const dynamic = {
    offset: Number(declaration.offset),
    size: Number(declaration.size),
  };
  const tags = new Map<bigint, bigint>();
  const unique = new Set([
    DT_RELA,
    DT_RELASZ,
    DT_RELAENT,
    DT_JMPREL,
    DT_PLTRELSZ,
    DT_PLTREL,
  ]);
  for (let at = dynamic.offset; at < dynamic.offset + dynamic.size; at += 16) {
    if ((at - dynamic.offset) % 65536 === 0) yield;
    const parsedEntry = readElfDynamicEntry(
      image.subarray(at, at + 16),
      64,
      true,
    );
    if (!parsedEntry.ok) throw malformed(parsedEntry.error.message);
    const { tag, value } = parsedEntry.value;
    if (tag === 0n) return tags;
    if (tags.has(tag) && unique.has(tag))
      throw malformed(`duplicate dynamic tag ${tag}`);
    tags.set(tag, value);
  }
  throw malformed("PT_DYNAMIC has no DT_NULL terminator");
}

const fileOffset = (
  source: RelocationSource,
  address: bigint,
  size: number,
): number | null => {
  try {
    return mappedFileOffset(source.mappings, address, size, source.zeroFills);
  } catch (cause) {
    if (cause instanceof BinaryMappingFailure && cause.reason === "unmapped")
      return null;
    throw cause;
  }
};

const admitOverlay = (output: RelocatedImage) => {
  if (
    output.unresolved.size + output.zeroFillPointers.size >=
    MAX_OVERLAY_ENTRIES
  )
    throw new Il2cppBinaryFormatFailure(
      "native-index-capacity",
      `ELF relocation overlay exceeds ${MAX_OVERLAY_ENTRIES} entries`,
    );
};

/** Each admitted record is interpreted once from the original immutable bytes. */
function* applyRelaTable(
  source: RelocationSource,
  output: RelocatedImage,
  address: bigint,
  size: bigint | undefined,
  entry: bigint,
): Generator<void> {
  if (
    size === undefined ||
    size < 0n ||
    entry !== 24n ||
    size % entry !== 0n ||
    size > BigInt(source.image.length)
  )
    throw malformed("invalid DT_RELASZ or DT_RELAENT");
  const start = fileOffset(source, address, Number(size));
  if (start === null) throw malformed("RELA table is not file-backed");
  for (let at = start; at < start + Number(size); at += 24) {
    if ((at - start) % (24 * 4096) === 0) yield;
    const parsedEntry = readElfRelocationEntry(
      source.image.subarray(at, at + 24),
      64,
      true,
      "rela",
    );
    if (!parsedEntry.ok) throw malformed(parsedEntry.error.message);
    const {
      type: kind,
      offset: destination,
      symbolIndex,
      addend,
    } = parsedEntry.value;
    if (kind === 0) continue;
    if (kind !== source.relative || symbolIndex !== 0) {
      const width = source.unknownPointerWidths.get(kind);
      if (width === undefined)
        throw unsupported(`ELF relocation kind ${kind} is not decoded`);
      const priorWidth = output.unresolved.get(destination);
      if (priorWidth === undefined) admitOverlay(output);
      output.unresolved.set(destination, Math.max(priorWidth ?? 0, width));
      // Registration scans read this private image directly. Clear unknown
      // fields so their stored bytes cannot masquerade as resolved pointers.
      const target = fileOffset(source, destination, width);
      if (target !== null) output.bytes.fill(0, target, target + width);
      continue;
    }
    const target = fileOffset(source, destination, 8);
    const value = BigInt.asUintN(64, addend);
    if (target !== null) output.bytes.writeBigUInt64LE(value, target);
    else if (
      isZeroFilledSpan(source.mappings, source.zeroFills, destination, 8)
    ) {
      if (!output.zeroFillPointers.has(destination)) admitOverlay(output);
      output.zeroFillPointers.set(destination, value);
    } else
      throw malformed(
        "RELATIVE relocation target is outside unambiguous loaded memory",
      );
  }
}

/** Materialize relative pointers in a private copy, preserving unknown and .bss facts. */
export function* applyElfRelativeRelocationsSteps(
  image: Buffer,
  elf: Extract<BinaryContainer, { format: "elf" }>["elf"],
  mappings: readonly FileMapping[],
  zeroFills: readonly ZeroFillMapping[],
): Generator<void, RelocatedImage> {
  const kinds = RELOCATION_KINDS.get(elf.machine);
  if (kinds === undefined)
    throw new Il2cppBinaryFormatFailure(
      "unsupported-container",
      "ELF relocations require AArch64 or x86-64",
    );
  const tags = yield* dynamicTags(image, elf.dynamicSegments);
  if (tags.has(0x6000000fn) || tags.has(0x60000011n) || tags.has(17n))
    throw unsupported(
      "Android packed (APS2) or REL relocations are not decoded",
    );
  yield;
  const output: RelocatedImage = {
    bytes: Buffer.from(image),
    unresolved: new Map(),
    zeroFillPointers: new Map(),
  };
  const source = { image, mappings, zeroFills, ...kinds };
  const rela = tags.get(DT_RELA);
  if (rela !== undefined)
    yield* applyRelaTable(
      source,
      output,
      rela,
      tags.get(DT_RELASZ),
      tags.get(DT_RELAENT) ?? 24n,
    );
  else if ((tags.get(DT_RELASZ) ?? 0n) !== 0n)
    throw malformed("DT_RELASZ has no DT_RELA");
  const plt = tags.get(DT_JMPREL);
  if (plt !== undefined) {
    if (tags.get(DT_PLTREL) !== DT_RELA)
      throw unsupported("PLT relocations require RELA encoding");
    yield* applyRelaTable(source, output, plt, tags.get(DT_PLTRELSZ), 24n);
  }
  return output;
}
