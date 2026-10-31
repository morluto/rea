import {
  EXTENDED_SCHEMA_IDENTIFIER,
  priFailure,
  type PriSection,
  type SectionContent,
} from "./PriLayout.js";
import {
  readAsciiTerminated,
  readUtf16Terminated,
  type TextBudget,
} from "./PriText.js";

/** Names tables of [mrm_hschemaex]; only [def_hnamesx] stores an ASCII pool length. */
const NAMES_TABLES: ReadonlyMap<string, boolean> = new Map([
  ["[def_hnames]   \0", false],
  ["[def_hnamesx]  \0", true],
]);
const ENTRY_BYTES = 12;
const SCOPE_FLAG = 0x10;
const ASCII_NAME_FLAG = 0x20;
const NAME_OFFSET_HIGH_BITS = 0x0f;
const UNKNOWN_FLAGS = 0xc0;
/** Scope and item indices, parents and child ranges are 16-bit fields. */
const MAXIMUM_INDEXED_ENTRIES = 0x10000;

/** Scopes and named items of one hierarchical schema, keyed by item index. */
export interface PriSchema {
  readonly section: number;
  readonly extended: boolean;
  readonly majorVersion: number;
  readonly minorVersion: number;
  readonly checksum: number;
  readonly scopeCount: number;
  readonly itemCount: number;
  readonly uniqueName: string;
  readonly name: string;
  /** Slash-separated full names, indexed by item index. */
  readonly itemNames: readonly string[];
  /** Direct children of the root scope, with the number of items below each. */
  readonly topLevelScopes: readonly { name: string; items: number }[];
}

/** Section-relative table offsets declared by the schema header. */
interface SchemaTables {
  readonly scopeCount: number;
  readonly itemCount: number;
  readonly entriesAt: number;
  readonly scopeTableAt: number;
  readonly itemTableAt: number;
  readonly unicodeAt: number;
  readonly asciiAt: number;
  readonly asciiEnd: number;
}

interface Entry {
  readonly parent: number;
  readonly fullPathLength: number;
  readonly nameLength: number;
  readonly flags: number;
  readonly nameOffset: number;
  readonly index: number;
  readonly scope: boolean;
}

/** Entries with their decoded full names and index-to-position tables. */
interface SchemaEntries {
  readonly entries: readonly Entry[];
  readonly fullNames: readonly string[];
  readonly scopeEntries: Int32Array;
  readonly itemEntries: Int32Array;
}

const readHeaderName = (
  content: SectionContent,
  at: number,
  units: number,
  budget: TextBudget,
): string => {
  if (units < 1) priFailure(`${content.label} header name length is zero.`);
  const text = readUtf16Terminated(
    content,
    { start: at, end: at + units * 2 },
    budget,
    "header name",
  );
  if (text.length !== units - 1)
    priFailure(
      `${content.label} header name length disagrees with its terminator.`,
    );
  return text;
};

/** Names table identifier of an extended schema; true when it sizes the ASCII pool. */
const readNamesTable = (content: SectionContent): boolean => {
  content.require(8, 16, "names table identifier");
  const names = content.bytes.toString(
    "latin1",
    content.offset + 8,
    content.offset + 24,
  );
  const sized = NAMES_TABLES.get(names);
  if (sized === undefined)
    return priFailure(
      `${content.label} uses an unsupported names table ${JSON.stringify(names)}.`,
    );
  return sized;
};

/** Decode the fixed header, both names and the table layout of one schema. */
const readSchemaHeader = (section: PriSection, budget: TextBudget) => {
  const content = section.content;
  if (content.length === 0)
    priFailure(
      `${content.label} is empty; resource names held only by another PRI file are not supported.`,
    );
  if (content.u16(0, "schema marker") !== 1)
    priFailure(`${content.label} has an unsupported schema marker.`);
  if (content.u16(6, "reserved field") !== 0)
    priFailure(`${content.label} has a nonzero reserved field.`);
  const extended = section.identifier === EXTENDED_SCHEMA_IDENTIFIER;
  const asciiPoolLength = extended && readNamesTable(content);
  let at = extended ? 24 : 8;
  const version = {
    majorVersion: content.u16(at, "major version"),
    minorVersion: content.u16(at + 2, "minor version"),
    checksum: content.u32(at + 8, "checksum"),
  };
  if (content.u32(at + 4, "reserved field") !== 0)
    priFailure(`${content.label} has a nonzero reserved version field.`);
  const scopeCount = content.u32(at + 12, "scope count");
  const itemCount = content.u32(at + 16, "item count");
  at += 20;
  const uniqueNameUnits = content.u16(2, "unique name length");
  const uniqueName = readHeaderName(content, at, uniqueNameUnits, budget);
  at += uniqueNameUnits * 2;
  const nameUnits = content.u16(4, "name length");
  const name = readHeaderName(content, at, nameUnits, budget);
  at += nameUnits * 2;
  if (
    content.u16(at, "reserved field") !== 0 ||
    content.u16(at + 4, "reserved field") !== 0 ||
    content.u32(at + 6, "entry count") !== scopeCount + itemCount ||
    content.u32(at + 10, "scope count") !== scopeCount ||
    content.u32(at + 14, "item count") !== itemCount
  )
    priFailure(`${content.label} repeats inconsistent scope and item counts.`);
  if (
    scopeCount < 1 ||
    scopeCount > MAXIMUM_INDEXED_ENTRIES ||
    itemCount > MAXIMUM_INDEXED_ENTRIES
  )
    priFailure(
      `${content.label} declares ${String(scopeCount)} scopes and ${String(itemCount)} items outside the 16-bit index profile.`,
    );
  const unicodeUnits = content.u32(at + 18, "UTF-16 name pool length");
  const asciiBytes = asciiPoolLength
    ? content.u32(at + 26, "ASCII name pool length")
    : 0;
  const entriesAt = at + (asciiPoolLength ? 30 : 26);
  const scopeTableAt = entriesAt + (scopeCount + itemCount) * ENTRY_BYTES;
  const itemTableAt = scopeTableAt + scopeCount * 8;
  const unicodeAt = itemTableAt + itemCount * 2;
  const asciiAt = unicodeAt + unicodeUnits * 2;
  const asciiEnd = asciiPoolLength ? asciiAt + asciiBytes : content.length;
  content.require(entriesAt, asciiEnd - entriesAt, "tables and name pools");
  const tables: SchemaTables = {
    scopeCount,
    itemCount,
    entriesAt,
    scopeTableAt,
    itemTableAt,
    unicodeAt,
    asciiAt,
    asciiEnd,
  };
  return { extended, version, uniqueName, name, tables };
};

const readEntry = (content: SectionContent, at: number): Entry => {
  const flags = content.u8(at + 7, "entry flags");
  if ((flags & UNKNOWN_FLAGS) !== 0)
    priFailure(
      `${content.label} entry at ${String(at)} has unsupported flags 0x${flags.toString(16)}.`,
    );
  return {
    parent: content.u16(at, "entry parent"),
    fullPathLength: content.u16(at + 2, "entry full path length"),
    nameLength: content.u8(at + 6, "entry name length"),
    flags,
    nameOffset:
      content.u16(at + 8, "entry name offset") +
      (flags & NAME_OFFSET_HIGH_BITS) * 0x10000,
    index: content.u16(at + 10, "entry index"),
    scope: (flags & SCOPE_FLAG) !== 0,
  };
};

/** Decode every entry name and full name; parents must be earlier scopes. */
const readEntries = (
  content: SectionContent,
  tables: SchemaTables,
  budget: TextBudget,
): SchemaEntries => {
  const count = tables.scopeCount + tables.itemCount;
  const entries: Entry[] = [];
  const fullNames: string[] = [];
  const scopeEntries = new Int32Array(tables.scopeCount).fill(-1);
  const itemEntries = new Int32Array(tables.itemCount).fill(-1);
  const pooled = new Map<number, string>();
  const leafName = (entry: Entry): string => {
    const ascii = (entry.flags & ASCII_NAME_FLAG) !== 0;
    const key = ascii ? -1 - entry.nameOffset : entry.nameOffset;
    let leaf = pooled.get(key);
    if (leaf === undefined) {
      leaf = ascii
        ? readAsciiTerminated(
            content,
            { start: tables.asciiAt + entry.nameOffset, end: tables.asciiEnd },
            budget,
            "name",
          )
        : readUtf16Terminated(
            content,
            {
              start: tables.unicodeAt + entry.nameOffset * 2,
              end: tables.asciiAt,
            },
            budget,
            "name",
          );
      pooled.set(key, leaf);
    }
    return leaf;
  };
  for (let position = 0; position < count; position++) {
    const entry = readEntry(content, tables.entriesAt + position * ENTRY_BYTES);
    const label = `${content.label} entry ${String(position)}`;
    const owners = entry.scope ? scopeEntries : itemEntries;
    if (entry.index >= owners.length || owners[entry.index] !== -1)
      priFailure(`${label} has a missing or repeated index.`);
    owners[entry.index] = position;
    entries.push(entry);
    if (position === 0) {
      if (
        !entry.scope ||
        entry.index !== 0 ||
        entry.parent !== 0 ||
        entry.fullPathLength !== 0
      )
        priFailure(`${content.label} does not start with its root scope.`);
      fullNames.push("");
      continue;
    }
    if (entry.parent >= position || entries[entry.parent]?.scope !== true)
      priFailure(`${label} parent is not an earlier scope.`);
    budget.consume(entry.fullPathLength, `${content.label} full names`);
    const leaf = leafName(entry);
    if (
      leaf.length === 0 ||
      (leaf.length < 0x100 && leaf.length !== entry.nameLength)
    )
      priFailure(`${label} name length disagrees with its stored name.`);
    const fullName =
      entry.parent === 0 ? leaf : `${fullNames[entry.parent] ?? ""}/${leaf}`;
    if (fullName.length !== entry.fullPathLength)
      priFailure(`${label} full name length disagrees with its parents.`);
    fullNames.push(fullName);
  }
  return { entries, fullNames, scopeEntries, itemEntries };
};

/** Each scope's child range must name exactly the entries whose parent it is. */
const checkScopeChildren = (
  content: SectionContent,
  tables: SchemaTables,
  { entries, scopeEntries }: SchemaEntries,
): void => {
  const covered = new Uint8Array(entries.length);
  for (let scope = 0; scope < tables.scopeCount; scope++) {
    const at = tables.scopeTableAt + scope * 8;
    const position = content.u16(at, "scope entry");
    const children = content.u16(at + 2, "scope child count");
    const first = content.u16(at + 4, "scope first child");
    if (
      position !== scopeEntries[scope] ||
      content.u16(at + 6, "reserved field") !== 0 ||
      first + children > entries.length
    )
      priFailure(
        `${content.label} scope ${String(scope)} has an inconsistent child range.`,
      );
    for (let child = first; child < first + children; child++) {
      if (child === 0 || entries[child]?.parent !== position || covered[child])
        priFailure(
          `${content.label} scope ${String(scope)} lists entry ${String(child)} that is not its own child.`,
        );
      covered[child] = 1;
    }
  }
  if (covered.indexOf(0, 1) !== -1)
    priFailure(`${content.label} has entries outside every scope child range.`);
};

/** Direct children of the root scope with the number of items below each. */
const topLevelScopes = ({
  entries,
  fullNames,
  itemEntries,
}: SchemaEntries): PriSchema["topLevelScopes"] => {
  const topLevel = new Int32Array(entries.length).fill(-1);
  entries.forEach((entry, position) => {
    if (position === 0) return;
    topLevel[position] =
      entry.parent !== 0
        ? (topLevel[entry.parent] ?? -1)
        : entry.scope
          ? position
          : -1;
  });
  const items = new Map<number, number>();
  for (const position of itemEntries) {
    const top = topLevel[position] ?? -1;
    if (top !== -1) items.set(top, (items.get(top) ?? 0) + 1);
  }
  return entries.flatMap((entry, position) =>
    position !== 0 && entry.parent === 0 && entry.scope
      ? [{ name: fullNames[position] ?? "", items: items.get(position) ?? 0 }]
      : [],
  );
};

/** Decode and cross-check a [mrm_hschema] or [mrm_hschemaex] section. */
export const readSchema = (
  section: PriSection,
  budget: TextBudget,
): PriSchema => {
  const content = section.content;
  const { extended, version, uniqueName, name, tables } = readSchemaHeader(
    section,
    budget,
  );
  const decoded = readEntries(content, tables, budget);
  checkScopeChildren(content, tables, decoded);
  for (let item = 0; item < tables.itemCount; item++)
    if (
      content.u16(tables.itemTableAt + item * 2, "item entry") !==
      decoded.itemEntries[item]
    )
      priFailure(
        `${content.label} item ${String(item)} maps to the wrong entry.`,
      );
  return {
    section: section.index,
    extended,
    ...version,
    scopeCount: tables.scopeCount,
    itemCount: tables.itemCount,
    uniqueName,
    name,
    itemNames: Array.from(
      decoded.itemEntries,
      (position) => decoded.fullNames[position] ?? "",
    ),
    topLevelScopes: topLevelScopes(decoded),
  };
};
