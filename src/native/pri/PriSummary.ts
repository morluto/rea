import {
  PRI_QUALIFIER_NAMES,
  PRI_VALUE_TYPES,
  type PriResources,
  type PriValueType,
} from "../../domain/native/priResources.js";
import type { PriFile } from "./PriFile.js";
import { cooperate, displayIdentifier } from "./PriLayout.js";
import type { PriResourceMap } from "./PriResourceMap.js";

const AUTO_MERGE = 0x1;
const DEPLOYMENT_MERGEABLE = 0x2;
const INTERPRETED_FLAGS = AUTO_MERGE | DEPLOYMENT_MERGEABLE;
const UNINTERPRETED_LISTED = 16;

/** Stored type name for a value type code, or Unknown outside codes 0-6. */
export const valueTypeName = (code: number): PriValueType =>
  PRI_VALUE_TYPES[code] ?? "Unknown";

/** Candidate counts over every item, independent of the selected page. */
export interface PriCensus {
  readonly maps: readonly {
    readonly itemsWithCandidates: number;
    readonly candidates: number;
  }[];
  readonly valueTypes: ReadonlyMap<PriValueType, number>;
  readonly unknownTypeCodes: ReadonlySet<number>;
  readonly externalCandidates: number;
}

const countMap = async (
  map: PriResourceMap,
  census: {
    valueTypes: Map<PriValueType, number>;
    unknownTypeCodes: Set<number>;
    externalCandidates: number;
  },
  signal: AbortSignal | undefined,
) => {
  let itemsWithCandidates = 0;
  let candidates = 0;
  for (let item = 0; item < map.schema.itemCount; item++) {
    await cooperate(item, signal);
    const sets = map.decisionInfo.decisions[map.itemDecision[item] ?? -1] ?? [];
    if (sets.length > 0) itemsWithCandidates += 1;
    candidates += sets.length;
    for (let entry = 0; entry < sets.length; entry++) {
      const candidate = map.candidate(
        (map.itemFirstCandidate[item] ?? 0) + entry,
      );
      const valueType = valueTypeName(candidate.typeCode);
      census.valueTypes.set(
        valueType,
        (census.valueTypes.get(valueType) ?? 0) + 1,
      );
      if (valueType === "Unknown")
        census.unknownTypeCodes.add(candidate.typeCode);
      if (candidate.kind === "external") census.externalCandidates += 1;
    }
  }
  return { itemsWithCandidates, candidates };
};

/** Count every item's candidates once, by map and by stored value type. */
export const takeCensus = async (
  maps: readonly PriResourceMap[],
  signal: AbortSignal | undefined,
): Promise<PriCensus> => {
  const census = {
    valueTypes: new Map<PriValueType, number>(),
    unknownTypeCodes: new Set<number>(),
    externalCandidates: 0,
  };
  const perMap: PriCensus["maps"][number][] = [];
  for (const map of maps) perMap.push(await countMap(map, census, signal));
  return { maps: perMap, ...census };
};

const summarizeSections = (file: PriFile): PriResources["section_summary"] => {
  const groups = new Map<string, PriResources["section_summary"][number]>();
  for (const section of file.layout.sections) {
    const group = groups.get(section.identifier) ?? {
      kind: section.kind,
      identifier: section.identifier,
      sections: 0,
      interpreted: 0,
      bytes: 0,
    };
    group.sections += 1;
    group.bytes += section.length;
    if (file.interpreted.has(section.index)) group.interpreted += 1;
    groups.set(section.identifier, group);
  }
  return [...groups.values()];
};

const summarizeMaps = (
  file: PriFile,
  census: PriCensus,
): PriResources["resource_maps"] =>
  file.maps.map((map, index) => ({
    section: map.section.index,
    version: map.version,
    primary: file.descriptor.primaryResourceMap === map.section.index,
    name: map.schema.name,
    unique_name: map.schema.uniqueName,
    schema: {
      section: map.schema.section,
      extended: map.schema.extended,
      major_version: map.schema.majorVersion,
      minor_version: map.schema.minorVersion,
      checksum: map.schema.checksum,
      scopes: map.schema.scopeCount,
      items: map.schema.itemCount,
    },
    decision_info_section: map.decisionInfo.section,
    environment_references: { ...map.environmentReferences },
    schema_reference_bytes: map.schemaReferenceBytes,
    items_with_candidates: census.maps[index]?.itemsWithCandidates ?? 0,
    candidates: census.maps[index]?.candidates ?? 0,
    top_level_scopes: map.schema.topLevelScopes.map((scope) => ({ ...scope })),
  }));

/** Referenced qualifier values grouped by name, in type-code order. */
const summarizeQualifierValues = (
  file: PriFile,
): PriResources["qualifier_values"] => {
  const values = new Map<string, string[]>();
  for (const decisionInfo of file.decisionInfos)
    for (const qualifier of decisionInfo.qualifiers) {
      if (!qualifier.referenced) continue;
      const list = values.get(qualifier.name) ?? [];
      if (!list.includes(qualifier.value)) list.push(qualifier.value);
      values.set(qualifier.name, list);
    }
  return [...PRI_QUALIFIER_NAMES, "Unknown" as const].flatMap((name) => {
    const list = values.get(name);
    return list === undefined ? [] : [{ name, values: list }];
  });
};

const coverage = (
  file: PriFile,
  census: PriCensus,
): PriResources["coverage"] => {
  const items = file.maps.reduce((sum, map) => sum + map.schema.itemCount, 0);
  const sum = (key: "itemsWithCandidates" | "candidates") =>
    census.maps.reduce((total, map) => total + map[key], 0);
  return {
    status: "complete",
    sections: file.layout.sections.length,
    interpreted_sections: file.interpreted.size,
    items,
    items_without_candidates: items - sum("itemsWithCandidates"),
    candidates: sum("candidates"),
    external_candidates: census.externalCandidates,
  };
};

const sectionUnknowns = (file: PriFile): string[] => {
  const uninterpreted = file.layout.sections.filter(
    ({ index }) => !file.interpreted.has(index),
  );
  if (uninterpreted.length === 0) return [];
  const listed = uninterpreted
    .slice(0, UNINTERPRETED_LISTED)
    .map(
      ({ index, identifier, kind }) =>
        `${String(index)} ${JSON.stringify(displayIdentifier(identifier))} (${kind})`,
    )
    .join(", ");
  const more = uninterpreted.length - UNINTERPRETED_LISTED;
  return [
    `Sections reported but not interpreted (${String(uninterpreted.length)}): ${listed}${more > 0 ? `, and ${String(more)} more in the sections collection` : ""}.`,
  ];
};

const mapUnknowns = (map: PriResourceMap): string[] => [
  ...(map.environmentReferences.count > 0 || map.environmentReferences.bytes > 0
    ? [
        `Resource map section ${String(map.section.index)} carries ${String(map.environmentReferences.count)} environment references (${String(map.environmentReferences.bytes)} bytes) that were not decoded.`,
      ]
    : []),
  ...(map.schemaReferenceBytes > 0
    ? [
        `Resource map section ${String(map.section.index)} carries a ${String(map.schemaReferenceBytes)}-byte hierarchical schema reference that was not decoded.`,
      ]
    : []),
];

/** File-specific facts this inspection could not establish. */
const describeUnknowns = (
  file: PriFile,
  census: PriCensus,
  counts: PriResources["coverage"],
): string[] => {
  const unknowns: string[] = [];
  if (counts.items_without_candidates > 0)
    unknowns.push(
      `${String(counts.items_without_candidates)} of ${String(counts.items)} named resources have no candidates in this file; other PRI files, such as resource packs, may supply their values.`,
    );
  if (census.externalCandidates > 0)
    unknowns.push(
      `${String(census.externalCandidates)} candidate values are stored in files listed by [def_file_list] sections; those files were not read.`,
    );
  const unknownTypes = census.valueTypes.get("Unknown");
  if (unknownTypes !== undefined)
    unknowns.push(
      `${String(unknownTypes)} candidates use value type codes outside 0-6 (${[...census.unknownTypeCodes].join(", ")}); their values are reported as opaque bytes.`,
    );
  if (
    file.decisionInfos.some(({ qualifiers }) =>
      qualifiers.some(({ name }) => name === "Unknown"),
    )
  )
    unknowns.push(
      "Some qualifier type codes have no established name for this PRI format generation and are named Unknown; their stored type_code is reported.",
    );
  unknowns.push(...sectionUnknowns(file), ...file.maps.flatMap(mapUnknowns));
  const flags = file.descriptor.flags & ~INTERPRETED_FLAGS;
  if (flags !== 0)
    unknowns.push(
      `Descriptor flag bits 0x${flags.toString(16)} are not interpreted.`,
    );
  return unknowns;
};

/** Every summary field of the result except identity, page and limitations. */
export const summarizePri = (file: PriFile, census: PriCensus) => {
  const counts = coverage(file, census);
  const { descriptor } = file;
  return {
    header: file.layout.header,
    descriptor: {
      section: descriptor.section,
      flags: descriptor.flags,
      auto_merge: (descriptor.flags & AUTO_MERGE) !== 0,
      deployment_mergeable: (descriptor.flags & DEPLOYMENT_MERGEABLE) !== 0,
      primary_resource_map_section: descriptor.primaryResourceMap,
      included_file_list_section: descriptor.includedFileList,
    },
    section_summary: summarizeSections(file),
    resource_maps: summarizeMaps(file, census),
    qualifier_values: summarizeQualifierValues(file),
    value_types: [...PRI_VALUE_TYPES, "Unknown" as const].flatMap(
      (valueType) => {
        const candidates = census.valueTypes.get(valueType);
        return candidates === undefined
          ? []
          : [{ value_type: valueType, candidates }];
      },
    ),
    coverage: counts,
    unknowns: describeUnknowns(file, census, counts),
  } satisfies Omit<PriResources, "artifact" | "page" | "limitations">;
};
