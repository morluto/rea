import {
  RESOURCE_MAP_V2_IDENTIFIER,
  cooperate,
  priFailure,
  type PriSection,
  type SectionContent,
} from "./PriLayout.js";
import type { PriSchema } from "./PriSchema.js";
import type { PriDataItems, PriDecisionInfo } from "./PriSections.js";

/** Decoded sections a resource map may reference, validated by role. */
export interface PriSectionLookup {
  schema(index: number): PriSchema;
  decisionInfo(index: number): PriDecisionInfo;
  dataItems(index: number): PriDataItems;
}

/** One validated candidate table entry. */
export type PriCandidate =
  | {
      readonly kind: "inline";
      readonly typeCode: number;
      /** Resource-map content offset and length of the stored value. */
      readonly at: number;
      readonly bytes: number;
    }
  | {
      readonly kind: "data-item";
      readonly typeCode: number;
      readonly section: number;
      readonly index: number;
      /** Data-item content offset and length of the stored value. */
      readonly at: number;
      readonly bytes: number;
    }
  | {
      readonly kind: "external";
      readonly typeCode: number;
      /** Zero-based [def_file_list] file index. */
      readonly referencedFile: number;
      readonly section: number;
      readonly index: number;
    };

/** Item-to-candidate index of one [mrm_res_map__] or [mrm_res_map2_] section. */
export interface PriResourceMap {
  readonly section: PriSection;
  readonly version: 1 | 2;
  readonly schema: PriSchema;
  readonly decisionInfo: PriDecisionInfo;
  readonly environmentReferences: {
    readonly count: number;
    readonly bytes: number;
  };
  readonly schemaReferenceBytes: number;
  /** Decision index per item, or -1 when this map stores no candidates for it. */
  readonly itemDecision: Int32Array;
  readonly itemFirstCandidate: Uint32Array;
  readonly candidateCount: number;
  candidate(index: number): PriCandidate;
}

const CANDIDATE_BYTES = 8;
const LARGE_TABLE_HEADER_BYTES = 12;

/**
 * A pair table: 16-bit pairs in the small table, then 32-bit pairs in the
 * optional large table, addressed as one sequence.
 */
interface PairTable {
  readonly small: number;
  readonly smallAt: number;
  readonly large: number;
  readonly largeAt: number;
}

/** Content-relative table positions and counts declared by a map header. */
interface MapTables {
  readonly valueTypesAt: number;
  readonly valueTypeCount: number;
  readonly itemGroupMaps: PairTable;
  readonly itemGroups: PairTable;
  readonly itemInfos: PairTable;
  readonly candidatesAt: number;
  readonly candidateCount: number;
  readonly dataAt: number;
  readonly dataBytes: number;
}

const tableSize = (table: PairTable): number => table.small + table.large;

const readPair = (
  content: SectionContent,
  table: PairTable,
  index: number,
  what: string,
): readonly [number, number] =>
  index < table.small
    ? [
        content.u16(table.smallAt + index * 4, what),
        content.u16(table.smallAt + index * 4 + 2, what),
      ]
    : [
        content.u32(table.largeAt + (index - table.small) * 8, what),
        content.u32(table.largeAt + (index - table.small) * 8 + 4, what),
      ];

/** Lay out the map tables and check they fit before any entry is read. */
const readMapTables = (
  content: SectionContent,
  prefixBytes: number,
): MapTables => {
  const valueTypeCount = content.u16(10, "value type count");
  const smallMaps = content.u16(12, "item group map count");
  const smallGroups = content.u16(14, "item group count");
  const smallInfos = content.u32(16, "item info count");
  const candidateCount = content.u32(20, "candidate count");
  const dataBytes = content.u32(24, "data length");
  const largeBytes = content.u32(28, "large table length");
  const valueTypesAt = 32 + prefixBytes;
  const mapsAt = valueTypesAt + valueTypeCount * 8;
  const groupsAt = mapsAt + smallMaps * 4;
  const infosAt = groupsAt + smallGroups * 4;
  const largeAt = infosAt + smallInfos * 4;
  const [largeMaps, largeGroups, largeInfos] =
    largeBytes === 0
      ? [0, 0, 0]
      : [0, 4, 8].map((at) => content.u32(largeAt + at, "large table count"));
  if (
    largeBytes !== 0 &&
    LARGE_TABLE_HEADER_BYTES +
      ((largeMaps ?? 0) + (largeGroups ?? 0) + (largeInfos ?? 0)) * 8 !==
      largeBytes
  )
    priFailure(
      `${content.label} large table length disagrees with its counts.`,
    );
  const largeMapsAt = largeAt + LARGE_TABLE_HEADER_BYTES;
  const largeGroupsAt = largeMapsAt + (largeMaps ?? 0) * 8;
  const largeInfosAt = largeGroupsAt + (largeGroups ?? 0) * 8;
  const candidatesAt = largeAt + largeBytes;
  const dataAt = candidatesAt + candidateCount * CANDIDATE_BYTES;
  content.require(
    valueTypesAt,
    dataAt + dataBytes - valueTypesAt,
    "tables and data",
  );
  return {
    valueTypesAt,
    valueTypeCount,
    itemGroupMaps: {
      small: smallMaps,
      smallAt: mapsAt,
      large: largeMaps ?? 0,
      largeAt: largeMapsAt,
    },
    itemGroups: {
      small: smallGroups,
      smallAt: groupsAt,
      large: largeGroups ?? 0,
      largeAt: largeGroupsAt,
    },
    itemInfos: {
      small: smallInfos,
      smallAt: infosAt,
      large: largeInfos ?? 0,
      largeAt: largeInfosAt,
    },
    candidatesAt,
    candidateCount,
    dataAt,
    dataBytes,
  };
};

const readValueTypes = (
  content: SectionContent,
  tables: MapTables,
): readonly number[] =>
  Array.from({ length: tables.valueTypeCount }, (_unused, entry) => {
    const at = tables.valueTypesAt + entry * 8;
    if (content.u32(at, "value type descriptor") !== 4)
      priFailure(
        `${content.label} value type ${String(entry)} has an unsupported descriptor.`,
      );
    return content.u32(at + 4, "value type");
  });

/** Resolve item groups to each item's decision and first candidate. */
const assignItems = async (
  content: SectionContent,
  tables: MapTables,
  owners: {
    readonly schema: PriSchema;
    readonly decisionInfo: PriDecisionInfo;
  },
  signal: AbortSignal | undefined,
) => {
  const { schema, decisionInfo } = owners;
  const itemDecision = new Int32Array(schema.itemCount).fill(-1);
  const itemFirstCandidate = new Uint32Array(schema.itemCount);
  const ranges: (readonly [number, number])[] = [];
  const groupCount = tableSize(tables.itemGroups);
  for (let map = 0; map < tableSize(tables.itemGroupMaps); map++) {
    await cooperate(map, signal);
    const [firstItem, group] = readPair(
      content,
      tables.itemGroupMaps,
      map,
      "item group map",
    );
    // A group index past the group table denotes one item info at the excess.
    const [size, firstInfo] =
      group < groupCount
        ? readPair(content, tables.itemGroups, group, "item group")
        : [1, group - groupCount];
    if (
      firstInfo + size > tableSize(tables.itemInfos) ||
      firstItem + size > schema.itemCount
    )
      priFailure(
        `${content.label} item group map ${String(map)} leaves the item or item info table.`,
      );
    for (let offset = 0; offset < size; offset++) {
      const item = firstItem + offset;
      if (itemDecision[item] !== -1)
        priFailure(
          `${content.label} assigns item ${String(item)} more than once.`,
        );
      const [decision, firstCandidate] = readPair(
        content,
        tables.itemInfos,
        firstInfo + offset,
        "item info",
      );
      const sets = decisionInfo.decisions[decision];
      if (
        sets === undefined ||
        firstCandidate + sets.length > tables.candidateCount
      )
        return priFailure(
          `${content.label} item ${String(item)} references a missing decision or candidate.`,
        );
      itemDecision[item] = decision;
      itemFirstCandidate[item] = firstCandidate;
      if (sets.length > 0) ranges.push([firstCandidate, sets.length]);
    }
  }
  ranges.sort((left, right) => left[0] - right[0]);
  ranges.forEach(([start], index) => {
    const [previousStart, previousSize] = ranges[index - 1] ?? [0, 0];
    if (index > 0 && start < previousStart + previousSize)
      priFailure(`${content.label} items share overlapping candidate ranges.`);
  });
  return { itemDecision, itemFirstCandidate };
};

/** Decode candidate table entries, checking their value and data references. */
const candidateDecoder =
  (
    content: SectionContent,
    tables: MapTables,
    valueTypeCodes: readonly number[],
    sections: PriSectionLookup,
  ) =>
  (index: number): PriCandidate => {
    const at = tables.candidatesAt + index * CANDIDATE_BYTES;
    const label = `${content.label} candidate ${String(index)}`;
    const kind = content.u8(at, "candidate kind");
    const typeCode = valueTypeCodes[content.u8(at + 1, "candidate value type")];
    if (typeCode === undefined)
      return priFailure(`${label} references a missing value type.`);
    if (kind === 0) {
      const bytes = content.u16(at + 2, "inline value length");
      const offset = content.u32(at + 4, "inline value offset");
      if (offset + bytes > tables.dataBytes)
        priFailure(`${label} leaves the map data area.`);
      return { kind: "inline", typeCode, at: tables.dataAt + offset, bytes };
    }
    if (kind !== 1)
      return priFailure(`${label} has unsupported kind ${String(kind)}.`);
    const source = content.u16(at + 2, "candidate source file");
    const item = content.u16(at + 4, "candidate data item");
    const section = content.u16(at + 6, "candidate data item section");
    if (source !== 0)
      return {
        kind: "external",
        typeCode,
        referencedFile: source - 1,
        section,
        index: item,
      };
    const dataItems = sections.dataItems(section);
    if (item >= dataItems.count)
      priFailure(`${label} references a missing data item.`);
    return {
      kind: "data-item",
      typeCode,
      section,
      index: item,
      ...dataItems.item(item),
    };
  };

/** Decode the map tables and validate every item and candidate reference. */
export const readResourceMap = async (
  section: PriSection,
  sections: PriSectionLookup,
  signal?: AbortSignal,
): Promise<PriResourceMap> => {
  const content = section.content;
  const environmentBytes = content.u16(0, "environment reference length");
  const schemaReferenceBytes = content.u16(6, "schema reference length");
  const schema = sections.schema(content.u16(4, "schema section"));
  const decisionInfo = sections.decisionInfo(
    content.u16(8, "decision section"),
  );
  const tables = readMapTables(
    content,
    environmentBytes + schemaReferenceBytes,
  );
  const items = await assignItems(
    content,
    tables,
    { schema, decisionInfo },
    signal,
  );
  const candidate = candidateDecoder(
    content,
    tables,
    readValueTypes(content, tables),
    sections,
  );
  for (let index = 0; index < tables.candidateCount; index++) {
    await cooperate(index, signal);
    candidate(index);
  }
  return {
    section,
    version: section.identifier === RESOURCE_MAP_V2_IDENTIFIER ? 2 : 1,
    schema,
    decisionInfo,
    environmentReferences: {
      count: content.u16(2, "environment reference count"),
      bytes: environmentBytes,
    },
    schemaReferenceBytes,
    ...items,
    candidateCount: tables.candidateCount,
    candidate,
  };
};
