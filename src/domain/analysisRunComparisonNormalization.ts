import type { z } from "zod";

import type {
  AnalysisRunEnvelope,
  AnalysisRunFindingRecord,
  AnalysisRunObligationRecord,
  AnalysisRunProcedureRecord,
  AnalysisRunUnknownRecord,
  NormalizedComparisonItem,
} from "./analysisRunComparisonSchemas.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import { canonicalJson } from "./comparisonSemantics.js";
import { type JsonValue, jsonObjectSchema } from "./jsonValue.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";

type JsonObject = z.infer<typeof jsonObjectSchema>;

export const sortUniqueStrings = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareUnicodeCodePoints);

export const setOwnJsonProperty = (
  target: Record<string, JsonValue>,
  key: string,
  value: JsonValue,
): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
};

export const getOwnJsonProperty = (
  source: Readonly<Record<string, JsonValue>>,
  key: string,
): JsonValue | undefined =>
  Object.hasOwn(source, key) ? source[key] : undefined;

export const filterObjectFields = (
  input: JsonObject | undefined,
  ignoredFields: ReadonlySet<string>,
): {
  readonly semantic: JsonObject;
  readonly presentation: JsonObject;
} => {
  if (input === undefined) return { semantic: {}, presentation: {} };
  const semantic: Record<string, JsonValue> = {};
  const presentation: Record<string, JsonValue> = {};
  for (const key of Object.keys(input).sort(compareUnicodeCodePoints)) {
    const value = getOwnJsonProperty(input, key);
    if (value === undefined) continue;
    if (ignoredFields.has(key)) {
      setOwnJsonProperty(presentation, key, value);
    } else {
      setOwnJsonProperty(semantic, key, value);
    }
  }
  return { semantic, presentation };
};

const moveIgnoredTopLevelFields = (
  semanticFields: Record<string, JsonValue>,
  presentationFields: Record<string, JsonValue>,
  ignoredFields: ReadonlySet<string>,
  protectedKeys: ReadonlySet<string>,
): void => {
  for (const ignored of ignoredFields) {
    if (protectedKeys.has(ignored)) continue;
    if (Object.hasOwn(semanticFields, ignored)) {
      const value = semanticFields[ignored]!;
      setOwnJsonProperty(presentationFields, ignored, value);
      delete semanticFields[ignored];
    }
  }
};

export const normalizeProcedureItem = (
  procedure: AnalysisRunProcedureRecord,
  index: number,
  run: AnalysisRunEnvelope,
  ignoredFields: ReadonlySet<string>,
): NormalizedComparisonItem => {
  const { semantic: semanticMeta, presentation: presentationMeta } =
    filterObjectFields(procedure.metadata, ignoredFields);
  const semanticFields: Record<string, JsonValue> = {
    address: procedure.address,
    name: procedure.name,
    signature: procedure.signature ?? null,
    size_bytes: procedure.size_bytes ?? null,
    callees: sortUniqueStrings(procedure.callees ?? []),
    callers: sortUniqueStrings(procedure.callers ?? []),
    pseudocode_sha256: procedure.pseudocode_sha256 ?? null,
    ...(Object.keys(semanticMeta).length > 0 ? { metadata: semanticMeta } : {}),
  };
  moveIgnoredTopLevelFields(
    semanticFields,
    presentationMeta,
    ignoredFields,
    new Set(["address"]),
  );
  return {
    item_kind: "procedure",
    item_key: `procedure:${procedure.address}`,
    matching_rule: "procedure-address",
    record_pointer: `/procedures/${String(index)}`,
    evidence_ids: sortUniqueStrings([
      run.evidence_id,
      ...(procedure.evidence_id === undefined ? [] : [procedure.evidence_id]),
      ...(procedure.evidence_ids ?? []),
    ]),
    semantic_fields: semanticFields,
    presentation_fields: presentationMeta,
    semantic_digest: digestCanonicalValue(
      semanticFields,
      "Procedure semantic comparison",
    ),
  };
};

const mergePresentationAttrAndMeta = (
  presentationAttrs: JsonObject,
  presentationMeta: JsonObject,
): Record<string, JsonValue> => {
  const presentationFields: Record<string, JsonValue> = {};
  const keys = sortUniqueStrings([
    ...Object.keys(presentationAttrs),
    ...Object.keys(presentationMeta),
  ]);
  for (const key of keys) {
    const hasAttr = Object.hasOwn(presentationAttrs, key);
    const hasMeta = Object.hasOwn(presentationMeta, key);
    if (hasAttr && hasMeta) {
      setOwnJsonProperty(presentationFields, key, {
        attributes: presentationAttrs[key]!,
        metadata: presentationMeta[key]!,
      });
    } else if (hasAttr) {
      setOwnJsonProperty(presentationFields, key, presentationAttrs[key]!);
    } else if (hasMeta) {
      setOwnJsonProperty(presentationFields, key, presentationMeta[key]!);
    }
  }
  return presentationFields;
};

export const normalizeFindingItem = (
  finding: AnalysisRunFindingRecord,
  index: number,
  run: AnalysisRunEnvelope,
  ignoredFields: ReadonlySet<string>,
): NormalizedComparisonItem => {
  const { semantic: semanticAttrs, presentation: presentationAttrs } =
    filterObjectFields(finding.attributes, ignoredFields);
  const { semantic: semanticMeta, presentation: presentationMeta } =
    filterObjectFields(finding.metadata, ignoredFields);

  const semanticFields: Record<string, JsonValue> = {
    finding_id: finding.finding_id,
    category: finding.category,
    severity: finding.severity,
    confidence: finding.confidence,
    title: finding.title,
    summary: finding.summary,
    locations: sortUniqueStrings(finding.locations ?? []),
    ...(Object.keys(semanticAttrs).length > 0
      ? { attributes: semanticAttrs }
      : {}),
    ...(Object.keys(semanticMeta).length > 0 ? { metadata: semanticMeta } : {}),
  };
  const presentationFields = mergePresentationAttrAndMeta(
    presentationAttrs,
    presentationMeta,
  );
  moveIgnoredTopLevelFields(
    semanticFields,
    presentationFields,
    ignoredFields,
    new Set(["finding_id"]),
  );
  return {
    item_kind: "finding",
    item_key: `finding:${finding.finding_id}`,
    matching_rule: "finding-id",
    record_pointer: `/findings/${String(index)}`,
    evidence_ids: sortUniqueStrings([
      run.evidence_id,
      ...(finding.evidence_id === undefined ? [] : [finding.evidence_id]),
      ...(finding.evidence_ids ?? []),
    ]),
    semantic_fields: semanticFields,
    presentation_fields: presentationFields,
    semantic_digest: digestCanonicalValue(
      semanticFields,
      "Finding semantic comparison",
    ),
  };
};

export const normalizeObligationItem = (
  obligation: AnalysisRunObligationRecord,
  index: number,
  run: AnalysisRunEnvelope,
  ignoredFields: ReadonlySet<string>,
): NormalizedComparisonItem => {
  const { semantic: semanticMeta, presentation: presentationMeta } =
    filterObjectFields(obligation.metadata, ignoredFields);
  const semanticFields: Record<string, JsonValue> = {
    obligation_id: obligation.obligation_id,
    category: obligation.category,
    description: obligation.description,
    status: obligation.status,
    ...(Object.keys(semanticMeta).length > 0 ? { metadata: semanticMeta } : {}),
  };
  moveIgnoredTopLevelFields(
    semanticFields,
    presentationMeta,
    ignoredFields,
    new Set(["obligation_id", "status"]),
  );
  return {
    item_kind: "obligation",
    item_key: `obligation:${obligation.obligation_id}`,
    matching_rule: "obligation-id",
    record_pointer: `/obligations/${String(index)}`,
    evidence_ids: sortUniqueStrings([
      run.evidence_id,
      ...(obligation.evidence_ids ?? []),
    ]),
    semantic_fields: semanticFields,
    presentation_fields: presentationMeta,
    semantic_digest: digestCanonicalValue(
      semanticFields,
      "Obligation semantic comparison",
    ),
    obligation_status: obligation.status,
  };
};

export const normalizeUnknownItem = (
  unknownRecord: AnalysisRunUnknownRecord,
  index: number,
  run: AnalysisRunEnvelope,
  ignoredFields: ReadonlySet<string>,
): NormalizedComparisonItem => {
  const { semantic: semanticMeta, presentation: presentationMeta } =
    filterObjectFields(unknownRecord.metadata, ignoredFields);
  const semanticFields: Record<string, JsonValue> = {
    unknown_id: unknownRecord.unknown_id,
    question: unknownRecord.question,
    status: unknownRecord.status,
    disposition: unknownRecord.disposition ?? null,
    ...(unknownRecord.revision === undefined
      ? {}
      : { revision: unknownRecord.revision }),
    ...(Object.keys(semanticMeta).length > 0 ? { metadata: semanticMeta } : {}),
  };
  moveIgnoredTopLevelFields(
    semanticFields,
    presentationMeta,
    ignoredFields,
    new Set(["unknown_id", "status"]),
  );
  return {
    item_kind: "residual_unknown",
    item_key: `unknown:${unknownRecord.unknown_id}`,
    matching_rule: "unknown-id",
    record_pointer: `/unknowns/${String(index)}`,
    evidence_ids: sortUniqueStrings([
      run.evidence_id,
      ...(unknownRecord.evidence_ids ?? []),
    ]),
    semantic_fields: semanticFields,
    presentation_fields: presentationMeta,
    semantic_digest: digestCanonicalValue(
      semanticFields,
      "Residual unknown semantic comparison",
    ),
    unknown_status: unknownRecord.status,
  };
};

export const extractNormalizedRunItems = (
  run: AnalysisRunEnvelope,
  ignoredFields: ReadonlySet<string>,
): Map<string, NormalizedComparisonItem> => {
  const map = new Map<string, NormalizedComparisonItem>();
  for (const [index, procedure] of (run.procedures ?? []).entries()) {
    const item = normalizeProcedureItem(procedure, index, run, ignoredFields);
    map.set(item.item_key, item);
  }
  for (const [index, finding] of (run.findings ?? []).entries()) {
    const item = normalizeFindingItem(finding, index, run, ignoredFields);
    map.set(item.item_key, item);
  }
  for (const [index, obligation] of (run.obligations ?? []).entries()) {
    const item = normalizeObligationItem(obligation, index, run, ignoredFields);
    map.set(item.item_key, item);
  }
  for (const [index, unknownRecord] of (run.unknowns ?? []).entries()) {
    const item = normalizeUnknownItem(unknownRecord, index, run, ignoredFields);
    map.set(item.item_key, item);
  }
  return map;
};

export const diffRecordFieldNames = (
  leftFields: Readonly<Record<string, JsonValue>>,
  rightFields: Readonly<Record<string, JsonValue>>,
): string[] => {
  const allKeys = sortUniqueStrings([
    ...Object.keys(leftFields),
    ...Object.keys(rightFields),
  ]);
  const changed: string[] = [];
  for (const key of allKeys) {
    const leftVal = getOwnJsonProperty(leftFields, key);
    const rightVal = getOwnJsonProperty(rightFields, key);
    if (leftVal === undefined || rightVal === undefined) {
      changed.push(key);
      continue;
    }
    if (canonicalJson(leftVal) !== canonicalJson(rightVal)) {
      changed.push(key);
    }
  }
  return changed;
};
