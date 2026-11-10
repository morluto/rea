import {
  readElfRelocationWritesSteps,
  ElfPointerRelocationFailure,
} from "../native/metadata/ElfPointerRelocations.js";
import type {
  BinaryContainer,
  FileMapping,
  ZeroFillMapping,
} from "../native/metadata/BinaryContainer.js";
import { Il2cppBinaryFormatFailure } from "./Il2cppBinaryFormat.js";

/** File bytes with more than one virtual identity cannot share a relocated copy.
 * Sweep physical boundaries once, then test each write in logarithmic time.
 * Consistent duplicate/adjacent mappings keep one identity and remain supported.
 */
function* aliasedFileBytesSteps(
  mappings: readonly FileMapping[],
): Generator<void, (offset: number, width: number) => boolean> {
  const events: { offset: number; translation: bigint; delta: number }[] = [];
  for (const mapping of mappings) {
    if (mapping.size === 0) continue;
    const translation = mapping.address - BigInt(mapping.offset);
    events.push(
      { offset: mapping.offset, translation, delta: 1 },
      { offset: mapping.offset + mapping.size, translation, delta: -1 },
    );
  }
  events.sort((a, b) => a.offset - b.offset);
  const active = new Map<bigint, number>();
  const aliases: { start: number; end: number }[] = [];
  let previous = 0;
  for (const [index, event] of events.entries()) {
    if (index % 4096 === 0) yield;
    if (event.offset > previous && active.size > 1) {
      const last = aliases.at(-1);
      if (last?.end === previous) last.end = event.offset;
      else aliases.push({ start: previous, end: event.offset });
    }
    const count = (active.get(event.translation) ?? 0) + event.delta;
    if (count === 0) active.delete(event.translation);
    else active.set(event.translation, count);
    previous = event.offset;
  }
  return (offset, width) => {
    const end = offset + width;
    let low = 0,
      high = aliases.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (aliases[mid]!.start < end) low = mid + 1;
      else high = mid;
    }
    return low > 0 && aliases[low - 1]!.end > offset;
  };
}

/** Materialize the shared loader facts only for IL2CPP's existing private reader. */
export function* applyElfRelativeRelocationsSteps(
  image: Buffer,
  elf: Extract<BinaryContainer, { format: "elf" }>["elf"],
  mappings: readonly FileMapping[],
  zeroFills: readonly ZeroFillMapping[],
): Generator<
  void,
  {
    readonly bytes: Buffer;
    readonly unresolved: ReadonlyMap<bigint, number>;
    readonly zeroFillPointers: ReadonlyMap<bigint, bigint>;
  }
> {
  try {
    const steps = readElfRelocationWritesSteps(
      image,
      {
        bits: 64,
        little: true,
        machine: elf.machine,
        dynamicSegments: elf.dynamicSegments,
        mappings,
        zeroFills,
      },
      { requireDynamic: true },
    );
    const aliasesFileBytes = yield* aliasedFileBytesSteps(mappings);
    const bytes = Buffer.from(image),
      zeroFillPointers = new Map<bigint, bigint>(),
      unresolved = new Map<bigint, number>();
    // One bit per original file offset replaces per-relocation objects. Reads
    // of implicit addends continue using image, never this mutable private copy.
    const starts = Buffer.alloc(Math.ceil(image.length / 8));
    const wasWritten = (offset: number) =>
      offset >= 0 &&
      offset < image.length &&
      ((starts[Math.floor(offset / 8)] ?? 0) & (1 << (offset % 8))) !== 0;
    const admitState = () => {
      if (unresolved.size + zeroFillPointers.size >= 65_536)
        throw new Il2cppBinaryFormatFailure(
          "native-index-capacity",
          "ELF unresolved and zero-fill overlay exceeds 65536 entries",
        );
    };
    const unknown = (address: bigint, width: number) => {
      if (!unresolved.has(address)) admitState();
      unresolved.set(address, Math.max(unresolved.get(address) ?? 0, width));
    };
    let next = steps.next();
    while (!next.done) {
      const write = next.value;
      if (write === undefined) {
        yield;
        next = steps.next();
        continue;
      }
      const at = write.file_offset;
      if (at !== null && aliasesFileBytes(at, write.width))
        throw new Il2cppBinaryFormatFailure(
          "unsupported-pointer-encoding",
          `ELF relocation at 0x${write.address.toString(16)} has distinct virtual mappings of its file bytes; a shared relocated file copy cannot preserve their independent loader values`,
        );
      if (write.value === null) {
        unknown(write.address, write.width);
        if (at !== null) bytes.fill(0, at, at + write.width);
      } else if (at === null) {
        for (let delta = -7; delta <= 7; delta++) {
          const previous = zeroFillPointers.get(write.address + BigInt(delta));
          if (
            previous !== undefined &&
            (delta !== 0 || previous !== write.value)
          )
            unknown(write.address, 8);
        }
        if (!zeroFillPointers.has(write.address)) admitState();
        zeroFillPointers.set(write.address, write.value);
      } else {
        for (let delta = -7; delta <= 7; delta++)
          if (
            wasWritten(at + delta) &&
            (delta !== 0 || bytes.readBigUInt64LE(at) !== write.value)
          )
            unknown(write.address, 8);
        const byte = Math.floor(at / 8);
        starts[byte] = (starts[byte] ?? 0) | (1 << (at % 8));
        bytes.writeBigUInt64LE(write.value, at);
      }
      next = steps.next();
    }
    return { bytes, unresolved, zeroFillPointers };
  } catch (cause) {
    if (cause instanceof ElfPointerRelocationFailure)
      throw new Il2cppBinaryFormatFailure(cause.reason, cause.message);
    throw cause;
  }
}
