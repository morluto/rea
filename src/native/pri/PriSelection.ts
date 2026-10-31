import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { jsonParts } from "../../domain/jsonSerialization.js";
import {
  PRI_VALUE_TYPES,
  priNameSelection,
  priQualifierSelection,
  type InspectPriResourcesInput,
  type PriCandidateRow,
  type PriItemRow,
  type PriPage,
  type PriQualifierRow,
  type PriSectionRow,
  type PriValueType,
} from "../../domain/native/priResources.js";
import type { PriFile } from "./PriFile.js";
import { cooperate, priFailure } from "./PriLayout.js";
import type { PriResourceMap } from "./PriResourceMap.js";
import type { PriDecisionInfo } from "./PriSections.js";
import { valueTypeName } from "./PriSummary.js";
import { decodeValueText, type ValueEncoding } from "./PriText.js";

/** Serialized rows one page may carry before it ends early. */
const PAGE_BYTES = 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;

/** Count bytes through the canonical bounded JSON writer. */
export const serializedBytes = (value: unknown, maximum: number): number => {
  let size = 0;
  for (const part of jsonParts(value)) {
    size += Buffer.byteLength(part, "utf8");
    if (size > maximum) return size;
  }
  return size;
};

const encodingOf = (valueType: PriValueType): ValueEncoding | undefined => {
  if (valueType === "String" || valueType === "Path") return "utf-16le";
  if (valueType === "AsciiString" || valueType === "AsciiPath") return "ascii";
  if (valueType === "Utf8String" || valueType === "Utf8Path") return "utf-8";
  return undefined;
};

/** Offset/limit paging with a serialized-row budget; totals always cover every match. */
class Pager<Row> {
  total = 0;
  readonly rows: Row[] = [];
  #bytes = 0;
  #end: PriPage["end"] = "exhausted";

  constructor(private readonly input: InspectPriResourcesInput) {}

  offer(build: () => Row): void {
    const position = this.total;
    this.total += 1;
    if (position < this.input.offset || this.#end !== "exhausted") return;
    if (this.rows.length >= this.input.limit) {
      this.#end = "limit";
      return;
    }
    const row = build();
    const size = serializedBytes(row, PAGE_BYTES) + 1;
    if (this.rows.length > 0 && this.#bytes + size > PAGE_BYTES) {
      this.#end = "byte_budget";
      return;
    }
    this.rows.push(row);
    this.#bytes += size;
  }

  page() {
    return {
      offset: this.input.offset,
      limit: this.input.limit,
      total: this.total,
      returned: this.rows.length,
      next_offset:
        this.#end === "exhausted" ? null : this.input.offset + this.rows.length,
      end: this.#end,
    };
  }
}

interface PendingDigest {
  readonly value: { sha256: string };
  readonly offset: number;
  readonly bytes: number;
}

/** Hash opaque values after paging, sharing identical ranges and honoring cancellation. */
const fillDigests = async (
  bytes: Buffer,
  pending: readonly PendingDigest[],
  signal: AbortSignal | undefined,
): Promise<void> => {
  const digests = new Map<string, string>();
  for (const { value, offset, bytes: size } of pending) {
    const key = `${String(offset)}:${String(size)}`;
    let digest = digests.get(key);
    if (digest === undefined) {
      const hash = createHash("sha256");
      for (let at = 0; at < size; at += HASH_CHUNK_BYTES) {
        await setImmediate();
        signal?.throwIfAborted();
        hash.update(
          bytes.subarray(
            offset + at,
            offset + Math.min(size, at + HASH_CHUNK_BYTES),
          ),
        );
      }
      digest = hash.digest("hex");
      digests.set(key, digest);
    }
    value.sha256 = digest;
  }
};

/** Shared inputs for building candidate rows of one map. */
interface RowContext {
  readonly file: PriFile;
  readonly map: PriResourceMap;
  readonly mapIndex: number;
  readonly digests: PendingDigest[];
}

const candidateRow = (
  { file, map, mapIndex, digests }: RowContext,
  row: {
    readonly item: number;
    readonly name: string;
    readonly candidate: number;
    readonly qualifierSet: number;
  },
): PriCandidateRow => {
  const candidate = map.candidate(row.candidate);
  const valueType = valueTypeName(candidate.typeCode);
  const base = {
    map: mapIndex,
    item: row.item,
    name: row.name,
    candidate: row.candidate,
    qualifier_set: row.qualifierSet,
    qualifiers: (map.decisionInfo.qualifierSets[row.qualifierSet] ?? []).map(
      (index) => ({
        index,
        name: map.decisionInfo.qualifiers[index]?.name ?? "Unknown",
        value: map.decisionInfo.qualifiers[index]?.value ?? "",
      }),
    ),
    value_type: valueType,
    value_type_code: candidate.typeCode,
  };
  if (candidate.kind === "external")
    return {
      ...base,
      source: {
        kind: "external",
        referenced_file: candidate.referencedFile,
        section: candidate.section,
        index: candidate.index,
      },
      value: null,
    };
  const owner =
    candidate.kind === "inline"
      ? map.section
      : file.layout.sections[candidate.section];
  if (owner === undefined)
    return priFailure(
      `PRI candidate ${String(row.candidate)} data section is missing.`,
    );
  const location = owner.content.fileRange(
    candidate.at,
    candidate.bytes,
    "candidate value",
  );
  const source =
    candidate.kind === "inline"
      ? { kind: "inline" as const, location }
      : {
          kind: "data-item" as const,
          section: candidate.section,
          index: candidate.index,
          location,
        };
  const encoding = encodingOf(valueType);
  if (encoding === undefined) {
    const value = { kind: "bytes" as const, sha256: "0".repeat(64) };
    digests.push({ value, ...location });
    return { ...base, source, value };
  }
  const stored = file.bytes.subarray(
    location.offset,
    location.offset + location.bytes,
  );
  return {
    ...base,
    source,
    value: { kind: "text", encoding, ...decodeValueText(stored, encoding) },
  };
};

/** Per-set qualifier matches for one decision info section, or undefined when unfiltered. */
const qualifierSetMatches = (
  decisionInfo: PriDecisionInfo,
  filter: InspectPriResourcesInput["qualifiers"],
): readonly boolean[] | undefined => {
  const selected = priQualifierSelection(filter);
  if (selected === undefined) return undefined;
  return decisionInfo.qualifierSets.map((set) =>
    selected(set.flatMap((index) => decisionInfo.qualifiers[index] ?? [])),
  );
};

/** Item and candidate rows that satisfy the caller's name, qualifier and type selection. */
const selectResources = async (
  file: PriFile,
  input: InspectPriResourcesInput,
  signal: AbortSignal | undefined,
): Promise<{ readonly page: PriPage; readonly digests: PendingDigest[] }> => {
  const selectedName = priNameSelection(input);
  const valueTypes =
    input.value_types === undefined
      ? undefined
      : new Set(input.value_types.map((name) => PRI_VALUE_TYPES.indexOf(name)));
  const candidateFilter =
    input.qualifiers !== undefined || valueTypes !== undefined;
  const items = new Pager<PriItemRow>(input);
  const candidates = new Pager<PriCandidateRow>(input);
  const digests: PendingDigest[] = [];
  for (const [mapIndex, map] of file.maps.entries()) {
    const context = { file, map, mapIndex, digests };
    const setMatches = qualifierSetMatches(map.decisionInfo, input.qualifiers);
    for (let item = 0; item < map.schema.itemCount; item++) {
      await cooperate(item, signal);
      const name = map.schema.itemNames[item] ?? "";
      if (!selectedName(name)) continue;
      const decision = map.itemDecision[item] ?? -1;
      const sets = map.decisionInfo.decisions[decision] ?? [];
      const first = map.itemFirstCandidate[item] ?? 0;
      const matching = sets.flatMap((set, entry) =>
        (setMatches === undefined || setMatches[set] === true) &&
        (valueTypes === undefined ||
          valueTypes.has(map.candidate(first + entry).typeCode))
          ? [{ candidate: first + entry, qualifierSet: set }]
          : [],
      );
      if (input.collection === "candidates") {
        for (const match of matching)
          candidates.offer(() =>
            candidateRow(context, { item, name, ...match }),
          );
        continue;
      }
      if (candidateFilter && matching.length === 0) continue;
      items.offer(() => ({
        map: mapIndex,
        item,
        name,
        decision: decision === -1 ? null : decision,
        candidates: matching.length,
        value_types: [
          ...new Set(
            matching
              .map(({ candidate }) => map.candidate(candidate).typeCode)
              .sort((left, right) => left - right)
              .map(valueTypeName),
          ),
        ],
      }));
    }
  }
  return {
    page:
      input.collection === "candidates"
        ? {
            collection: "candidates",
            ...candidates.page(),
            candidates: candidates.rows,
          }
        : { collection: "items", ...items.page(), items: items.rows },
    digests,
  };
};

/** One page of the caller's collection, with opaque values hashed. */
export const selectPriPage = async (
  file: PriFile,
  input: InspectPriResourcesInput,
  signal: AbortSignal | undefined,
): Promise<PriPage> => {
  if (input.collection === "sections") {
    const pager = new Pager<PriSectionRow>(input);
    for (const section of file.layout.sections)
      pager.offer(() => ({
        index: section.index,
        identifier: section.identifier,
        kind: section.kind,
        interpreted: file.interpreted.has(section.index),
        qualifier: section.qualifier,
        flags: section.flags,
        section_flags: section.sectionFlags,
        location: { offset: section.offset, bytes: section.length },
      }));
    return { collection: "sections", ...pager.page(), sections: pager.rows };
  }
  if (input.collection === "qualifiers") {
    const pager = new Pager<PriQualifierRow>(input);
    for (const decisionInfo of file.decisionInfos)
      for (const qualifier of decisionInfo.qualifiers)
        pager.offer(() => ({
          decision_info_section: decisionInfo.section,
          index: qualifier.index,
          name: qualifier.name,
          type_code: qualifier.typeCode,
          value: qualifier.value,
          priority: qualifier.priority,
          fallback_score: qualifier.fallbackScore,
          referenced: qualifier.referenced,
        }));
    return {
      collection: "qualifiers",
      ...pager.page(),
      qualifiers: pager.rows,
    };
  }
  const { page, digests } = await selectResources(file, input, signal);
  await fillDigests(file.bytes, digests, signal);
  return page;
};
