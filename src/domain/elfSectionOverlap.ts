import type {
  ElfSectionExtent,
  ElfSectionOverlap,
  ElfSectionWitness,
} from "./binaryTargetTypes.js";
import type {
  ElfDeclarationRead,
  ElfTableDeclarations,
} from "./elfDeclaredRanges.js";
import type { ElfSectionHeader } from "./elfSectionHeader.js";

const SHT_NULL = 0;
const SHT_PROGBITS = 1;
const SHT_NOBITS = 8;
const SHF_ALLOC = 0x2n;
const SHF_EXECINSTR = 0x4n;
/** Names are display only; a larger section-name table is left unread. */
const SECTION_NAMES_MAX_BYTES = 64 * 1024;
/**
 * The allocated sections the sweep keeps: SHN_LORESERVE, from which ELF counts
 * sections through section zero. NOBITS headers take no file bytes, so the
 * file size alone would not bound the records.
 */
const ALLOCATED_SECTIONS_MAX = 0xff00;

/** One allocated, non-empty section: the only facts the sweep keeps. */
interface Allocated {
  readonly index: number;
  readonly type: number;
  readonly executable: boolean;
  readonly address: bigint;
  readonly end: bigint;
  readonly offset: bigint;
  readonly nameOffset: number;
}

type Pair = readonly [Allocated, Allocated];

const hex = (value: bigint): string => `0x${value.toString(16)}`;

const overlaps = (first: Allocated, second: Allocated): boolean =>
  first.address < second.end && second.address < first.end;

/** A NOBITS section that starts with executable PROGBITS and covers it. */
const isReservation = ([code, reservation]: Pair): boolean =>
  code.type === SHT_PROGBITS &&
  code.executable &&
  reservation.type === SHT_NOBITS &&
  !reservation.executable &&
  reservation.address === code.address &&
  reservation.end >= code.end;

/**
 * The first two overlaps that involve an executable section, in address order.
 * Each pair is found once, when its later-starting section is visited, with the
 * executable section first. The sweep stops at the second pair, so its work
 * stays O(n log n) on any table.
 */
const executableOverlaps = (sorted: readonly Allocated[]): Pair[] => {
  const pairs: Pair[] = [];
  // reach[i]: the furthest end of sorted[0..i], which bounds the backward scan.
  const reach: bigint[] = [];
  let active: Allocated[] = [];
  let furthest = -1n;
  for (const [position, section] of sorted.entries()) {
    if (section.executable) {
      for (let earlier = position - 1; earlier >= 0; earlier -= 1) {
        if (pairs.length >= 2 || (reach[earlier] ?? -1n) <= section.address)
          break;
        const other = sorted[earlier];
        if (other !== undefined && other.end > section.address)
          pairs.push([section, other]);
      }
    } else {
      active = active.filter((code) => code.end > section.address);
      for (const code of active.slice(0, 2 - pairs.length))
        pairs.push([code, section]);
    }
    if (pairs.length >= 2) break;
    if (section.executable) active.push(section);
    if (section.end > furthest) furthest = section.end;
    reach.push(furthest);
  }
  return pairs;
};

/**
 * Collect allocated sections during one section-table pass, then derive the
 * overlap fact. Section addresses are load addresses only in fixed-address
 * (`ET_EXEC`) images, so callers collect for those. Overlaps between two
 * non-executable sections are outside the fact, unless one of them is the
 * reservation, which then departs from the verified shape.
 */
export const elfSectionOverlapCollector = () => {
  const allocated: Allocated[] = [];
  let names: ElfSectionHeader | undefined;
  let exceeded = false;
  return {
    visit(
      section: ElfSectionHeader,
      index: number,
      tables: ElfTableDeclarations,
    ): void {
      if (index === tables.sections.namesIndex && index !== 0) names = section;
      if (
        section.type === SHT_NULL ||
        (section.flags & SHF_ALLOC) === 0n ||
        section.size === 0n
      )
        return;
      if (allocated.length === ALLOCATED_SECTIONS_MAX) {
        exceeded = true;
        return;
      }
      allocated.push({
        index,
        type: section.type,
        executable: (section.flags & SHF_EXECINSTR) !== 0n,
        address: section.address,
        end: section.address + section.size,
        offset: section.offset,
        nameOffset: section.nameOffset,
      });
    },
    *finish(
      fileSize: number,
    ): Generator<ElfDeclarationRead, ElfSectionOverlap, Buffer> {
      if (exceeded)
        return {
          status: "unavailable",
          reason: `the section table declares more than ${String(ALLOCATED_SECTIONS_MAX)} allocated sections, the most the overlap check keeps`,
        };
      const sorted = allocated.sort((first, second) =>
        first.address === second.address
          ? first.index - second.index
          : first.address < second.address
            ? -1
            : 1,
      );
      const [first, second] = executableOverlaps(sorted);
      if (first === undefined) return { status: "none" };
      const [code, reservation] = first;
      const shaped = isReservation(first);
      // Only the reservation can reach a third section: the code overlaps one.
      const intruder =
        second === undefined && shaped
          ? sorted.find(
              (other) =>
                other !== code &&
                other !== reservation &&
                overlaps(reservation, other),
            )
          : undefined;
      const nameOf = yield* readSectionNames(names, fileSize);
      const extent = (section: Allocated): ElfSectionExtent => ({
        index: section.index,
        name: nameOf(section.nameOffset),
        address: hex(section.address),
        size: hex(section.end - section.address),
      });
      if (second === undefined && shaped && intruder === undefined)
        return {
          status: "code-reservation",
          code: { ...extent(code), offset: hex(code.offset) },
          reservation: extent(reservation),
        };
      const witness = (section: Allocated): ElfSectionWitness => ({
        ...extent(section),
        nobits: section.type === SHT_NOBITS,
        executable: section.executable,
      });
      // Name the sections that cause the refusal, not a pair of the verified shape.
      const [left, right] =
        intruder !== undefined
          ? [reservation, intruder]
          : second !== undefined && shaped
            ? second
            : first;
      return {
        status: "unsupported",
        witnesses: [witness(left), witness(right)],
      };
    },
  };
};

/** Section names for display, or null for each name when the table is unreadable. */
function* readSectionNames(
  names: ElfSectionHeader | undefined,
  fileSize: number,
): Generator<
  ElfDeclarationRead,
  (nameOffset: number) => string | null,
  Buffer
> {
  const unknown = (): null => null;
  if (
    names === undefined ||
    names.type === SHT_NOBITS ||
    names.size === 0n ||
    names.size > BigInt(SECTION_NAMES_MAX_BYTES) ||
    names.offset > BigInt(fileSize) - names.size
  )
    return unknown;
  const size = Number(names.size);
  const bytes = yield { offset: Number(names.offset), size };
  if (bytes.length !== size) return unknown;
  return (start) => {
    const end = start < size ? bytes.indexOf(0, start) : -1;
    return end < 0 ? null : bytes.toString("latin1", start, end);
  };
}
