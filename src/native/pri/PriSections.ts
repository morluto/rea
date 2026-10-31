import {
  PRI_QUALIFIER_NAMES,
  type PriQualifierName,
  type PriResources,
  type PriSectionKind,
} from "../../domain/native/priResources.js";
import {
  priFailure,
  priLimit,
  type PriSection,
  type SectionContent,
} from "./PriLayout.js";
import { readUtf16Terminated, type TextBudget } from "./PriText.js";

type PriMagic = PriResources["header"]["magic"];

const NONE = 0xffff;

/** Section roles declared by the single [mrm_pridescex] section. */
export interface PriDescriptor {
  readonly section: number;
  readonly flags: number;
  readonly includedFileList: number | null;
  readonly schemas: readonly number[];
  readonly decisionInfos: readonly number[];
  readonly resourceMaps: readonly number[];
  readonly primaryResourceMap: number | null;
  readonly referencedFiles: readonly number[];
  readonly dataItems: readonly number[];
}

export const readDescriptor = (
  sections: readonly PriSection[],
): PriDescriptor => {
  const candidates = sections.filter(({ kind }) => kind === "descriptor");
  const descriptor = candidates[0];
  if (descriptor === undefined || candidates.length !== 1)
    return priFailure(
      `PRI file needs exactly one [mrm_pridescex] section; found ${String(candidates.length)}.`,
    );
  const content = descriptor.content;
  const flags = content.u16(0, "flags");
  const includedFileList = content.u16(2, "included file list");
  const counts = [6, 8, 10, 14, 16].map((at) =>
    content.u16(at, "section count"),
  );
  const primary = content.u16(12, "primary resource map");
  if (
    content.u16(4, "reserved field") !== 0 ||
    content.u16(18, "reserved field") !== 0
  )
    priFailure(`${content.label} has nonzero reserved fields.`);
  let cursor = 20;
  const kinds: readonly PriSectionKind[] = [
    "hierarchical-schema",
    "decision-info",
    "resource-map",
    "referenced-files",
    "data-items",
  ];
  const [schemas, decisionInfos, resourceMaps, referencedFiles, dataItems] =
    kinds.map((kind, list) => {
      const indices: number[] = [];
      for (let entry = 0; entry < (counts[list] ?? 0); entry++, cursor += 2) {
        const index = content.u16(cursor, `${kind} section reference`);
        if (sections[index]?.kind !== kind || indices.includes(index))
          priFailure(
            `${content.label} lists section ${String(index)} as a ${kind} section, but it is not one or is repeated.`,
          );
        indices.push(index);
      }
      return indices;
    });
  if (
    schemas === undefined ||
    decisionInfos === undefined ||
    resourceMaps === undefined ||
    referencedFiles === undefined ||
    dataItems === undefined
  )
    return priFailure(`${content.label} section lists are incomplete.`);
  if (primary !== NONE && !resourceMaps.includes(primary))
    priFailure(`${content.label} primary resource map is not a listed map.`);
  if (
    includedFileList !== NONE &&
    sections[includedFileList]?.kind !== "referenced-files"
  )
    priFailure(
      `${content.label} included file list is not a [def_file_list] section.`,
    );
  return {
    section: descriptor.index,
    flags,
    includedFileList: includedFileList === NONE ? null : includedFileList,
    schemas,
    decisionInfos,
    resourceMaps,
    primaryResourceMap: primary === NONE ? null : primary,
    referencedFiles,
    dataItems,
  };
};

/**
 * Real decision tables reference a few hundred qualifier-set and decision
 * entries (Windows 11's largest stock PRI: 264 sets, 32 decisions). Ranges
 * into the shared index table may overlap, so their total expansion is bounded.
 */
const DECISION_EXPANSION_ENTRIES = 1 << 20;

/** Windows 8.x qualifier type codes 0-8, as makepri names them. */
const WINDOWS_8_QUALIFIERS: readonly PriQualifierName[] = [
  "Language",
  "Contrast",
  "Scale",
  "HomeRegion",
  "TargetSize",
  "LayoutDirection",
  "Configuration",
  "AlternateForm",
  "DXFeatureLevel",
];

/**
 * Qualifier names by stored type code. The table belongs to the format
 * generation: makepri names code 6 Configuration in mrm_pri0/mrm_pri1 files,
 * which have no codes 9-11, and Theme in mrm_pri2 files. The mrm_prif table is
 * not established, so its codes stay unnamed.
 */
const QUALIFIER_TABLES: Readonly<
  Record<PriMagic, readonly PriQualifierName[]>
> = {
  mrm_pri0: WINDOWS_8_QUALIFIERS,
  mrm_pri1: WINDOWS_8_QUALIFIERS,
  mrm_pri2: PRI_QUALIFIER_NAMES,
  mrm_prif: [],
};

export interface PriQualifier {
  readonly index: number;
  readonly typeCode: number;
  readonly name: PriQualifierName;
  readonly value: string;
  readonly priority: number;
  readonly fallbackScore: number;
  readonly referenced: boolean;
}

/** Qualifiers, qualifier sets and decisions of one [mrm_decn_info] section. */
export interface PriDecisionInfo {
  readonly section: number;
  readonly qualifiers: readonly PriQualifier[];
  /** Qualifier indices of each qualifier set. */
  readonly qualifierSets: readonly (readonly number[])[];
  /** Qualifier-set indices of each decision, in candidate order. */
  readonly decisions: readonly (readonly number[])[];
}

/** Content-relative table layout of one decision info section. */
interface DecisionTables {
  readonly distinct: number;
  readonly qualifiers: number;
  readonly sets: number;
  readonly decisions: number;
  readonly dataUnits: number;
  readonly setsAt: number;
  readonly qualifiersAt: number;
  readonly distinctAt: number;
  readonly dataAt: number;
  readonly indexTable: readonly number[];
}

const DECISIONS_AT = 12;

const readDecisionTables = (content: SectionContent): DecisionTables => {
  const [distinct = 0, qualifiers = 0, sets = 0, decisions = 0, index = 0] = [
    0, 2, 4, 6, 8,
  ].map((at) => content.u16(at, "table count"));
  const dataUnits = content.u16(10, "string pool length");
  const setsAt = DECISIONS_AT + decisions * 4;
  const qualifiersAt = setsAt + sets * 4;
  const distinctAt = qualifiersAt + qualifiers * 8;
  const indexAt = distinctAt + distinct * 12;
  const dataAt = indexAt + index * 2;
  content.require(
    DECISIONS_AT,
    dataAt + dataUnits * 2 - DECISIONS_AT,
    "tables",
  );
  return {
    distinct,
    qualifiers,
    sets,
    decisions,
    dataUnits,
    setsAt,
    qualifiersAt,
    distinctAt,
    dataAt,
    indexTable: Array.from({ length: index }, (_unused, entry) =>
      content.u16(indexAt + entry * 2, "index table entry"),
    ),
  };
};

/**
 * Expand (first, size) ranges into the shared index table. Every value must
 * name an entry below `limit`; the running total is bounded across tables.
 */
const expandRanges = (
  content: SectionContent,
  indexTable: readonly number[],
  ranges: {
    readonly at: number;
    readonly count: number;
    readonly limit: number;
    readonly what: string;
  },
  expansion: { total: number },
): number[][] =>
  Array.from({ length: ranges.count }, (_unused, entry) => {
    const label = `${content.label} ${ranges.what} ${String(entry)}`;
    const first = content.u16(ranges.at + entry * 4, `${ranges.what} index`);
    const size = content.u16(ranges.at + entry * 4 + 2, `${ranges.what} size`);
    if (first + size > indexTable.length)
      priFailure(`${label} leaves the index table.`);
    expansion.total += size;
    if (expansion.total > DECISION_EXPANSION_ENTRIES)
      priLimit(
        `${content.label} expands to more than ${String(DECISION_EXPANSION_ENTRIES)} decision entries; no partial inventory was returned.`,
      );
    const values = indexTable.slice(first, first + size);
    if (values.some((value) => value >= ranges.limit))
      priFailure(`${label} references a missing entry.`);
    return values;
  });

/** Distinct qualifier definitions: stored type code and pooled UTF-16 value. */
const readDefinitions = (
  content: SectionContent,
  tables: DecisionTables,
  budget: TextBudget,
): readonly { readonly typeCode: number; readonly value: string }[] => {
  const values = new Map<number, string>();
  return Array.from({ length: tables.distinct }, (_unused, entry) => {
    const at = tables.distinctAt + entry * 12;
    const valueUnits = content.u32(at + 8, "qualifier value offset");
    if (valueUnits >= tables.dataUnits)
      priFailure(
        `${content.label} qualifier value ${String(entry)} leaves its string pool.`,
      );
    let value = values.get(valueUnits);
    if (value === undefined) {
      value = readUtf16Terminated(
        content,
        {
          start: tables.dataAt + valueUnits * 2,
          end: tables.dataAt + tables.dataUnits * 2,
        },
        budget,
        `qualifier value ${String(entry)}`,
      );
      values.set(valueUnits, value);
    }
    return { typeCode: content.u16(at + 2, "qualifier type"), value };
  });
};

export const readDecisionInfo = (
  section: PriSection,
  magic: PriMagic,
  budget: TextBudget,
): PriDecisionInfo => {
  const content = section.content;
  const tables = readDecisionTables(content);
  const expansion = { total: 0 };
  const decisions = expandRanges(
    content,
    tables.indexTable,
    {
      at: DECISIONS_AT,
      count: tables.decisions,
      limit: tables.sets,
      what: "decision",
    },
    expansion,
  );
  const qualifierSets = expandRanges(
    content,
    tables.indexTable,
    {
      at: tables.setsAt,
      count: tables.sets,
      limit: tables.qualifiers,
      what: "qualifier set",
    },
    expansion,
  );
  const definitions = readDefinitions(content, tables, budget);
  const referenced = new Set(qualifierSets.flat());
  const names = QUALIFIER_TABLES[magic];
  const qualifiers = Array.from(
    { length: tables.qualifiers },
    (_unused, index) => {
      const at = tables.qualifiersAt + index * 8;
      const definition =
        definitions[content.u16(at, "distinct qualifier index")];
      if (
        definition === undefined ||
        content.u16(at + 6, "reserved field") !== 0
      )
        return priFailure(
          `${content.label} qualifier ${String(index)} references a missing definition or sets a reserved field.`,
        );
      return {
        index,
        typeCode: definition.typeCode,
        name: names[definition.typeCode] ?? "Unknown",
        value: definition.value,
        priority: content.u16(at + 2, "qualifier priority"),
        fallbackScore: content.u16(at + 4, "qualifier fallback score"),
        referenced: referenced.has(index),
      } satisfies PriQualifier;
    },
  );
  return { section: section.index, qualifiers, qualifierSets, decisions };
};

/** String and blob table of one [mrm_dataitem] section. */
export interface PriDataItems {
  readonly section: number;
  readonly count: number;
  /** Content-relative byte range of one data item. */
  item(index: number): { readonly at: number; readonly bytes: number };
}

export const readDataItems = (section: PriSection): PriDataItems => {
  const content = section.content;
  if (content.u32(0, "reserved field") !== 0)
    priFailure(`${content.label} has a nonzero reserved field.`);
  const strings = content.u16(4, "string count");
  const blobs = content.u16(6, "blob count");
  const dataBytes = content.u32(8, "data length");
  const dataAt = 12 + strings * 4 + blobs * 8;
  content.require(12, dataAt - 12 + dataBytes, "item tables and data");
  const starts = new Uint32Array(strings + blobs);
  const lengths = new Uint32Array(strings + blobs);
  for (let index = 0; index < strings; index++) {
    starts[index] = content.u16(12 + index * 4, "string offset");
    lengths[index] = content.u16(14 + index * 4, "string length");
  }
  for (let index = 0; index < blobs; index++) {
    const at = 12 + strings * 4 + index * 8;
    starts[strings + index] = content.u32(at, "blob offset");
    lengths[strings + index] = content.u32(at + 4, "blob length");
  }
  for (let index = 0; index < strings + blobs; index++)
    if ((starts[index] ?? 0) + (lengths[index] ?? 0) > dataBytes)
      priFailure(
        `${content.label} item ${String(index)} leaves its data area.`,
      );
  // Identical ranges may be shared; after sorting, any partial overlap also
  // appears between neighbours.
  const order = Uint32Array.from(
    { length: strings + blobs },
    (_unused, index) => index,
  )
    .filter((index) => (lengths[index] ?? 0) > 0)
    .sort((left, right) => (starts[left] ?? 0) - (starts[right] ?? 0));
  let previous: number | undefined;
  for (const index of order) {
    const start = starts[index] ?? 0;
    const end = start + (lengths[index] ?? 0);
    if (previous !== undefined) {
      const priorStart = starts[previous] ?? 0;
      const priorEnd = priorStart + (lengths[previous] ?? 0);
      if (start < priorEnd && (start !== priorStart || end !== priorEnd))
        priFailure(
          `${content.label} items ${String(previous)} and ${String(index)} partially overlap.`,
        );
    }
    previous = index;
  }
  return {
    section: section.index,
    count: strings + blobs,
    item: (index) => ({
      at: dataAt + (starts[index] ?? 0),
      bytes: lengths[index] ?? 0,
    }),
  };
};
