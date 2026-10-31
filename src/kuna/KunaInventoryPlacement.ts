import { MAX_LOAD_COMMAND_BYTES } from "../artifacts/apple/MachoLoadCommandReader.js";
import {
  readMachoHeaderDeclarations,
  readMachoLoadCommandTableHeader,
} from "../domain/apple/machoLoadCommands.js";
import { decodeMachoFixedName } from "../native/AppleMachoNames.js";
import {
  MachoBinaryFormatError,
  MachoCommandNamesLimitError,
  readMachoCommandNames,
} from "../native/MachoCommandNames.js";
import type { KunaInputPrefix } from "./KunaCommand.js";
import type { KunaInventoryFunction } from "./KunaProjectFiles.js";

// Section types and attributes from <mach-o/loader.h>.
const SECTION_TYPE = 0xff;
const S_NON_LAZY_SYMBOL_POINTERS = 0x6;
const S_LAZY_SYMBOL_POINTERS = 0x7;
const S_SYMBOL_STUBS = 0x8;
const S_LAZY_DYLIB_SYMBOL_POINTERS = 0x10;
const S_ATTR_PURE_INSTRUCTIONS = 0x80000000;
const S_ATTR_SOME_INSTRUCTIONS = 0x00000400;

/** The pointer slots dyld binds to imported symbols; Kuna names calls through them. */
const IMPORT_SLOT_TYPES: ReadonlySet<number> = new Set([
  S_NON_LAZY_SYMBOL_POINTERS,
  S_LAZY_SYMBOL_POINTERS,
  S_LAZY_DYLIB_SYMBOL_POINTERS,
]);

/** Load commands, sections and their names are a small part of any real image. */
const MAX_LAYOUT_RECORDS = 65_536;

/** The region before the first section that holds `mach_header` and its commands. */
const MACHO_HEADER_REGION = "Mach-O header and load commands";

/** What the target's own layout says about one inventory address. */
type KunaEntryPlacement =
  | { readonly kind: "code" }
  | { readonly kind: "import-slot" }
  | { readonly kind: "data"; readonly region: string }
  /** No section or the header holds the address, so its content is unknown. */
  | { readonly kind: "unplaced" };

interface PlacedRegion {
  readonly start: bigint;
  readonly end: bigint;
  readonly name: string;
  readonly placement: Exclude<KunaEntryPlacement, { kind: "unplaced" }>;
}

/** The section table REA classifies Kuna's inventory with, or why it has none. */
export type KunaInventoryLayout =
  /** Only Mach-O inventories are classified; others are kept as Kuna reports them. */
  | { readonly status: "not-applicable" }
  | { readonly status: "unavailable"; readonly reason: string }
  | {
      readonly status: "mach-o";
      /** Non-empty sections, sorted by address and pairwise disjoint. */
      readonly regions: readonly PlacedRegion[];
      readonly header: { readonly start: bigint; readonly end: bigint } | null;
    };

export const KUNA_LAYOUT_NOT_APPLICABLE: KunaInventoryLayout = Object.freeze({
  status: "not-applicable",
});

const CODE = Object.freeze({ kind: "code" } as const);
const IMPORT_SLOT = Object.freeze({ kind: "import-slot" } as const);
const UNPLACED = Object.freeze({ kind: "unplaced" } as const);

const unavailable = (reason: string): KunaInventoryLayout => ({
  status: "unavailable",
  reason,
});

/**
 * Keep a thin Mach-O header and its load commands while the private copy is
 * hashed. Commands beyond REA's load-command limit are not kept; the layout
 * then reports that limit.
 */
export const MACHO_LOAD_COMMAND_PREFIX: KunaInputPrefix = Object.freeze({
  probeBytes: 32,
  length: (head: Buffer) => {
    const declared = readMachoHeaderDeclarations(head, head.length);
    // The layout read reports what is wrong with the header it keeps.
    if (!declared.ok || declared.value === null)
      return Math.min(head.length, 32);
    const { headerSize, commandBytes } = declared.value;
    return commandBytes > MAX_LOAD_COMMAND_BYTES
      ? headerSize
      : headerSize + commandBytes;
  },
});

const sectionPlacement = (
  flags: number,
  name: string,
): PlacedRegion["placement"] => {
  const type = flags & SECTION_TYPE;
  if (
    (flags & (S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS)) !== 0 ||
    type === S_SYMBOL_STUBS
  )
    return CODE;
  if (IMPORT_SLOT_TYPES.has(type)) return IMPORT_SLOT;
  return { kind: "data", region: name };
};

/**
 * Read a thin Mach-O's section table from its header and load commands, as
 * inspect_macho reports them. A section that declares no instructions holds
 * data; a format failure leaves the inventory unclassified with its reason.
 */
export const readKunaMachoLayout = async (head: {
  readonly bytes: number;
  readonly prefix: Buffer;
}): Promise<KunaInventoryLayout> => {
  const { bytes, prefix } = head;
  const declared = readMachoLoadCommandTableHeader(prefix, bytes);
  if (!declared.ok) return unavailable(declared.error);
  if (declared.value === null) return unavailable("it has no Mach-O header");
  const { headerSize, commandBytes } = declared.value;
  if (commandBytes > MAX_LOAD_COMMAND_BYTES)
    return unavailable(
      `its load commands occupy ${String(commandBytes)} bytes, above the ${String(MAX_LOAD_COMMAND_BYTES)}-byte load-command limit`,
    );
  let commands: Awaited<ReturnType<typeof readMachoCommandNames>>["commands"];
  try {
    ({ commands } = await readMachoCommandNames(
      (offset, size) => Promise.resolve(prefix.subarray(offset, offset + size)),
      bytes,
      MAX_LOAD_COMMAND_BYTES,
      MAX_LAYOUT_RECORDS,
    ));
  } catch (cause: unknown) {
    if (
      cause instanceof MachoBinaryFormatError ||
      cause instanceof MachoCommandNamesLimitError
    )
      return unavailable(cause.message);
    throw cause;
  }
  const name = (field: Uint8Array) =>
    decodeMachoFixedName(
      Buffer.from(field.buffer, field.byteOffset, field.byteLength),
    );
  const regions: PlacedRegion[] = [];
  let header: { start: bigint; end: bigint } | null = null;
  for (const { segment, sections } of commands) {
    if (segment === undefined) continue;
    // The segment that maps file offset 0 maps the header and its commands.
    if (header === null && segment.fileOffset === 0n && segment.fileSize > 0n)
      header = {
        start: segment.address,
        end: segment.address + BigInt(headerSize + commandBytes),
      };
    for (const section of sections ?? []) {
      if (section.size === 0n) continue;
      const region = `${name(section.segmentName)},${name(section.name)}`;
      regions.push({
        start: section.address,
        end: section.address + section.size,
        name: region,
        placement: sectionPlacement(section.flags, region),
      });
    }
  }
  regions.sort((left, right) =>
    left.start < right.start ? -1 : left.start > right.start ? 1 : 0,
  );
  // Sorted by start, any overlap shows between neighbors. Overlapping
  // declarations cannot say which content an address holds.
  for (let index = 1; index < regions.length; index += 1) {
    const previous = regions[index - 1]!;
    const current = regions[index]!;
    if (current.start < previous.end)
      return unavailable(
        `sections ${previous.name} and ${current.name} overlap`,
      );
  }
  return { status: "mach-o", regions, header };
};

/** Where a Mach-O layout places one address; a section takes precedence over the header. */
const placeAddress = (
  layout: Extract<KunaInventoryLayout, { status: "mach-o" }>,
  address: bigint,
): KunaEntryPlacement => {
  const { regions, header } = layout;
  let low = 0;
  let high = regions.length - 1;
  let found: PlacedRegion | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const region = regions[middle]!;
    if (region.start <= address) {
      found = region;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (found !== undefined && address < found.end) return found.placement;
  if (header !== null && address >= header.start && address < header.end)
    return { kind: "data", region: MACHO_HEADER_REGION };
  return UNPLACED;
};

/** Kuna's inventory split by what the target's layout says each entry is. */
interface KunaInventoryPlacements {
  readonly layout: KunaInventoryLayout;
  /** The data region of each entry the layout places outside code and import slots. */
  readonly data: ReadonlyMap<KunaInventoryFunction, string>;
  /** Entries a Mach-O layout holds in no section and not in its header. */
  readonly unplaced: ReadonlySet<KunaInventoryFunction>;
}

/** Place every inventory entry in the target's layout. */
export const placeKunaInventory = (
  inventory: readonly KunaInventoryFunction[],
  layout: KunaInventoryLayout,
): KunaInventoryPlacements => {
  const data = new Map<KunaInventoryFunction, string>();
  const unplaced = new Set<KunaInventoryFunction>();
  if (layout.status === "mach-o")
    for (const entry of inventory) {
      const placement = placeAddress(layout, BigInt(entry.address));
      if (placement.kind === "data") data.set(entry, placement.region);
      else if (placement.kind === "unplaced") unplaced.add(entry);
    }
  return { layout, data, unplaced };
};

const describeRegion = (region: string): string =>
  region === MACHO_HEADER_REGION
    ? `the ${MACHO_HEADER_REGION}`
    : `${region}, a Mach-O section whose attributes declare no instructions`;

/** Why a procedure operation refuses an entry Kuna lists in a data region. */
export const kunaDataEntryMessage = (
  entry: KunaInventoryFunction,
  region: string,
): string =>
  `${entry.name} (${entry.address}) lies in ${describeRegion(region)}, so it is data that Kuna lists, not a procedure. address_name and xrefs accept its address.`;

/** How address_name qualifies a name Kuna lists for data. */
export const kunaDataNameLimitation = (
  entry: KunaInventoryFunction,
  region: string,
): string =>
  `Kuna lists ${entry.name} in its function inventory, but ${entry.address} lies in ${describeRegion(region)}, so the name labels data.`;

/**
 * What a listing omitted as data, and what it kept without a classification,
 * among the inventory entries its query selected.
 */
export const kunaInventoryLimitations = (
  layout: KunaInventoryLayout,
  omittedRegions: readonly string[],
  unplaced: number,
): readonly string[] => {
  if (layout.status === "unavailable")
    return [
      `REA could not read the target's Mach-O section table (${layout.reason}), so Kuna's inventory is kept unclassified and may include data symbols.`,
    ];
  const limitations: string[] = [];
  if (omittedRegions.length > 0) {
    const counts = new Map<string, number>();
    for (const region of omittedRegions)
      counts.set(region, (counts.get(region) ?? 0) + 1);
    const one = omittedRegions.length === 1;
    limitations.push(
      `Kuna's inventory also lists ${String(omittedRegions.length)} ${one ? "entry" : "entries"} in Mach-O data regions (${[
        ...counts,
      ]
        .map(([region, count]) => `${region}: ${String(count)}`)
        .join(
          "; ",
        )}): the header, or sections whose attributes declare no instructions. REA omits ${one ? "it as data rather than a procedure entry" : "them as data rather than procedure entries"}; address_name and xrefs still accept ${one ? "its address" : "their addresses"}.`,
    );
  }
  if (unplaced > 0) {
    const one = unplaced === 1;
    limitations.push(
      `${String(unplaced)} Kuna inventory ${one ? "entry lies" : "entries lie"} outside every Mach-O section and the header, so REA cannot tell whether ${one ? "it is" : "they are"} code or data and keeps ${one ? "it" : "them"}.`,
    );
  }
  return limitations;
};
