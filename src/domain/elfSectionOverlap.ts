import type {
  ElfSectionExtent,
  ElfSectionOverlap,
} from "./binaryTargetTypes.js";
import type { ElfDeclarationRead } from "./elfDeclaredRanges.js";
import type { ElfSectionHeader } from "./elfSectionHeader.js";
import { visitElfSectionHeaders } from "./elfSectionTable.js";

const SHT_NULL = 0;
const SHT_PROGBITS = 1;
const SHT_NOBITS = 8;
const SHF_ALLOC = 0x2n;
const SHF_EXECINSTR = 0x4n;
/** Names are display only; a larger section-name table is left unread. */
const SECTION_NAMES_MAX_BYTES = 64 * 1024;

interface Allocated {
  readonly index: number;
  readonly section: ElfSectionHeader;
  readonly end: bigint;
}

const hex = (value: bigint): string => `0x${value.toString(16)}`;

const executable = ({ section }: Allocated): boolean =>
  (section.flags & SHF_EXECINSTR) !== 0n;

const overlaps = (first: Allocated, second: Allocated): boolean =>
  first.section.address < second.end && second.section.address < first.end;

/** A NOBITS section that starts with executable PROGBITS and covers it. */
const isReservation = (code: Allocated, reservation: Allocated): boolean =>
  code.section.type === SHT_PROGBITS &&
  executable(code) &&
  reservation.section.type === SHT_NOBITS &&
  !executable(reservation) &&
  reservation.section.address === code.section.address &&
  reservation.section.size >= code.section.size;

/**
 * Find allocated address ranges that more than one section declares. Section
 * addresses are load addresses only in fixed-address (ET_EXEC) images, so
 * callers read this fact for those. Overlaps between two non-executable
 * sections are outside it.
 */
export function* readElfSectionOverlap(
  prefix: Buffer,
  fileSize: number,
): Generator<ElfDeclarationRead, ElfSectionOverlap, Buffer> {
  const allocated: Allocated[] = [];
  // Assigned by the visitor; the cast keeps control flow from narrowing it to undefined.
  let names = undefined as ElfSectionHeader | undefined;
  const visited = yield* visitElfSectionHeaders(
    prefix,
    fileSize,
    (section, index, tables) => {
      if (index === tables.sections.namesIndex && index !== 0) names = section;
      if (
        section.type !== SHT_NULL &&
        (section.flags & SHF_ALLOC) !== 0n &&
        section.size !== 0n
      )
        allocated.push({ index, section, end: section.address + section.size });
      return undefined;
    },
  );
  if (!visited.ok) return { status: "unavailable", reason: visited.error };
  const pairs: [Allocated, Allocated][] = [];
  for (const code of allocated.filter(executable))
    for (const other of allocated)
      if (
        other.index !== code.index &&
        overlaps(code, other) &&
        !(executable(other) && other.index < code.index)
      )
        pairs.push([code, other]);
  const first = pairs[0];
  if (first === undefined) return { status: "none" };
  const nameOf = yield* readSectionNames(names, fileSize);
  const extent = ({ index, section }: Allocated): ElfSectionExtent => ({
    index,
    name: nameOf(section),
    address: hex(section.address),
    size: hex(section.size),
  });
  const [code, reservation] = first;
  if (
    pairs.length === 1 &&
    isReservation(code, reservation) &&
    !allocated.some(
      (other) =>
        other.index !== code.index &&
        other.index !== reservation.index &&
        overlaps(reservation, other),
    )
  )
    return {
      status: "code-reservation",
      code: { ...extent(code), offset: hex(code.section.offset) },
      reservation: extent(reservation),
    };
  const describe = (item: Allocated): string => {
    const { index, name, address } = extent(item);
    return `[${index}]${name === null ? "" : ` ${name}`} (${address}..${hex(item.end)})`;
  };
  return {
    status: "unsupported",
    reason: `Sections ${describe(code)} and ${describe(reservation)} declare overlapping addresses${
      pairs.length > 1
        ? `, among ${pairs.length} overlaps that involve executable code`
        : ""
    }. REA prepares only a NOBITS section that starts with one executable PROGBITS section and covers it, as ESP-IDF's .flash_rodata_dummy reserves .flash.text.`,
  };
}

/** Section names for display, or null for each name when the table is not readable. */
function* readSectionNames(
  names: ElfSectionHeader | undefined,
  fileSize: number,
): Generator<
  ElfDeclarationRead,
  (section: ElfSectionHeader) => string | null,
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
  return (section) => {
    const start = section.nameOffset;
    const end = start < size ? bytes.indexOf(0, start) : -1;
    return end < 0 ? null : bytes.toString("latin1", start, end);
  };
}
