import { z } from "zod";

import { uniqueSorted } from "./canonicalOrdering.js";
import { digestSchema, prefixedDigestSchema } from "./digests.js";
import { evidenceSchema, type Evidence } from "./evidence.js";
import type { EvidenceBundle } from "./evidenceBundle.js";
import { nativeValueFlowMetadataSchema } from "./native/nativeValueFlow.js";

/** Exact retained-record selectors; selection never resolves a provider address. */
export const evidenceRecordFiltersSchema = z.strictObject({
  evidence_id: prefixedDigestSchema("ev").optional(),
  operation: z.string().min(1).optional(),
  target_sha256: digestSchema.optional(),
  analysis_profile_digest: digestSchema.optional(),
  procedure_address: z.string().min(1).optional(),
});
export type EvidenceRecordFilters = z.infer<typeof evidenceRecordFiltersSchema>;

const countSchema = z.int().nonnegative();
const nativeMetadataSchema = z.object({
  procedure: z.object({ address: z.string(), name: z.string().nullish() }),
  native_value_flow: z.unknown().optional(),
});

const nativeSummarySchema = z.discriminatedUnion("available", [
  z.strictObject({
    available: z.literal(true),
    procedure_address: z.string(),
    procedure_name: z.string().nullable(),
    value_flow: z.discriminatedUnion("status", [
      z.strictObject({
        status: z.literal("observed"),
        truncated: z.boolean(),
        omitted_operations_lower_bound: countSchema.nullable(),
        known_omitted_inputs: countSchema.nullable(),
        known_omitted_edges: countSchema.nullable(),
      }),
      z.strictObject({ status: z.literal("unavailable"), reason: z.string() }),
      z.strictObject({ status: z.literal("not-recorded") }),
      z.strictObject({ status: z.literal("unknown"), reason: z.string() }),
    ]),
  }),
  z.strictObject({
    available: z.literal(false),
    reason: z.enum(["different-operation", "not-recorded-or-incompatible"]),
  }),
]);

/** Metadata for complete retained records, independent of analysis completeness. */
export const evidenceBundleSummarySchema = z.strictObject({
  kind: z.literal("evidence-bundle-summary"),
  filters: z.record(z.string(), z.string()),
  total_retained_records: countSchema,
  matching_records: countSchema,
  unknown_revisions: countSchema,
  direct_links: countSchema.describe(
    "Distinct evidence_links of each matching record; detail links names them.",
  ),
  missing_direct_links: countSchema.describe(
    "Those direct links whose records this session or bundle does not retain. Zero establishes no transitive closure or analysis coverage.",
  ),
  records: z.array(
    z.strictObject({
      evidence_id: evidenceSchema.shape.evidence_id,
      subject: evidenceSchema.shape.subject,
      provider: evidenceSchema.shape.provider,
      operation: evidenceSchema.shape.operation,
      confidence: evidenceSchema.shape.confidence,
      authority: evidenceSchema.shape.authority,
      analysis_profile_digest: digestSchema.nullable(),
      retention: z.literal("complete-record"),
      limitation_count: countSchema,
      native_dossier: nativeSummarySchema,
    }),
  ),
});
export type EvidenceBundleSummary = z.infer<typeof evidenceBundleSummarySchema>;

const nativeSummary = (
  evidence: Evidence,
): z.infer<typeof nativeSummarySchema> => {
  if (evidence.operation !== "analyze_function")
    return { available: false, reason: "different-operation" };
  // Read only producer metadata. Parsing the full dossier would allocate every
  // large collection merely to discover its already authenticated parent ID.
  const parsed = nativeMetadataSchema.safeParse(evidence.normalized_result);
  if (!parsed.success)
    return { available: false, reason: "not-recorded-or-incompatible" };
  const flow = nativeValueFlowMetadataSchema.safeParse(
    parsed.data.native_value_flow,
  );
  return {
    available: true,
    procedure_address: parsed.data.procedure.address,
    procedure_name: parsed.data.procedure.name ?? null,
    value_flow:
      parsed.data.native_value_flow == null
        ? { status: "not-recorded" }
        : !flow.success
          ? {
              status: "unknown",
              reason: "Value-flow metadata has an incompatible representation.",
            }
          : flow.data.available
            ? {
                status: "observed",
                truncated: flow.data.truncated,
                omitted_operations_lower_bound:
                  flow.data.omitted_operations_lower_bound ?? null,
                known_omitted_inputs: flow.data.known_omitted_inputs ?? null,
                known_omitted_edges: flow.data.known_omitted_edges ?? null,
              }
            : { status: "unavailable", reason: flow.data.reason },
  };
};

/** Caller-selected filters with omitted fields removed, echoed by every selection. */
const selectedFilters = (
  filters: EvidenceRecordFilters,
): Record<string, string> => {
  const selected: Record<string, string> = {};
  for (const [field, value] of Object.entries(filters))
    if (value !== undefined) selected[field] = value;
  return selected;
};

/** One owner for exact filter semantics, in canonical bundle (Evidence ID) order. */
function* matchingEvidenceRecords(
  bundle: EvidenceBundle,
  filters: EvidenceRecordFilters,
): Generator<{
  readonly evidence: Evidence;
  readonly native: z.infer<typeof nativeSummarySchema>;
}> {
  for (const evidence of bundle.records) {
    if (
      (filters.evidence_id !== undefined &&
        filters.evidence_id !== evidence.evidence_id) ||
      (filters.operation !== undefined &&
        filters.operation !== evidence.operation) ||
      (filters.target_sha256 !== undefined &&
        filters.target_sha256 !== evidence.subject?.digest.sha256) ||
      (filters.analysis_profile_digest !== undefined &&
        filters.analysis_profile_digest !== evidence.analysis_profile?.digest)
    )
      continue;
    const native = nativeSummary(evidence);
    if (
      filters.procedure_address !== undefined &&
      (!native.available ||
        filters.procedure_address !== native.procedure_address)
    )
      continue;
    yield { evidence, native };
  }
}

/** A record's distinct direct links; the Evidence schema does not deduplicate them. */
const directLinksOf = ({ evidence_links: links }: Evidence): string[] =>
  uniqueSorted(links);

/** Discover retained Evidence without reading or copying its complete payloads. */
export const summarizeEvidenceBundle = (
  bundle: EvidenceBundle,
  filters: EvidenceRecordFilters = {},
): EvidenceBundleSummary => {
  const records: EvidenceBundleSummary["records"] = [];
  const retained = new Set(bundle.records.map(({ evidence_id: id }) => id));
  let directLinks = 0;
  let missingDirectLinks = 0;
  for (const { evidence, native } of matchingEvidenceRecords(bundle, filters)) {
    for (const link of directLinksOf(evidence)) {
      directLinks += 1;
      if (!retained.has(link)) missingDirectLinks += 1;
    }
    records.push({
      evidence_id: evidence.evidence_id,
      subject: evidence.subject,
      provider: evidence.provider,
      operation: evidence.operation,
      confidence: evidence.confidence,
      authority: evidence.authority,
      analysis_profile_digest: evidence.analysis_profile?.digest ?? null,
      retention: "complete-record",
      limitation_count: evidence.limitations.length,
      native_dossier: native,
    });
  }
  return {
    kind: "evidence-bundle-summary",
    filters: selectedFilters(filters),
    total_retained_records: bundle.records.length,
    matching_records: records.length,
    unknown_revisions: bundle.unknowns.length,
    direct_links: directLinks,
    missing_direct_links: missingDirectLinks,
    records,
  };
};

/** Default page size for complete record selection; each record may be large. */
export const EVIDENCE_RECORD_SELECTION_LIMIT = 8;

/** Labels every record selection as historical and as distinct from an importable bundle. */
const EVIDENCE_RECORD_SELECTION_LIMITATIONS = [
  "Selected records are retained historical observations; they do not establish current live provider or database state.",
  "A record selection is not an Evidence bundle: it omits manifests and residual unknowns and cannot be imported. Use export_evidence_bundle for a portable bundle.",
] as const;

/** Complete selected records with their retained identities and direct-link closure. */
export const evidenceRecordSelectionSchema = z.strictObject({
  kind: z.literal("evidence-record-selection"),
  filters: z.record(z.string(), z.string()),
  total_retained_records: countSchema,
  matching_records: countSchema,
  offset: countSchema,
  limit: z.int().positive(),
  next_offset: countSchema.nullable(),
  records: z.array(evidenceSchema),
  missing_evidence_links: z
    .array(prefixedDigestSchema("ev"))
    .describe(
      "Direct evidence_links of the returned records that this session or bundle does not retain; links are not traversed.",
    ),
  limitations: z.array(z.string()),
});
export type EvidenceRecordSelection = z.infer<
  typeof evidenceRecordSelectionSchema
>;

/** Select one page of complete authenticated records without copying the rest of the ledger. */
export const selectEvidenceRecords = (
  bundle: EvidenceBundle,
  filters: EvidenceRecordFilters = {},
  page: {
    readonly offset?: number | undefined;
    readonly limit?: number | undefined;
  } = {},
): EvidenceRecordSelection => {
  const offset = page.offset ?? 0;
  const limit = page.limit ?? EVIDENCE_RECORD_SELECTION_LIMIT;
  const records: Evidence[] = [];
  let matching = 0;
  for (const { evidence } of matchingEvidenceRecords(bundle, filters)) {
    if (matching >= offset && records.length < limit) records.push(evidence);
    matching += 1;
  }
  const retained = new Set(bundle.records.map(({ evidence_id: id }) => id));
  const missing = records.flatMap(({ evidence_links: links }) =>
    links.filter((link) => !retained.has(link)),
  );
  const end = offset + records.length;
  return {
    kind: "evidence-record-selection",
    filters: selectedFilters(filters),
    total_retained_records: bundle.records.length,
    matching_records: matching,
    offset,
    limit,
    next_offset: end < matching ? end : null,
    records,
    missing_evidence_links: uniqueSorted(missing),
    limitations: [...EVIDENCE_RECORD_SELECTION_LIMITATIONS],
  };
};

/** How far link inspection reads from the selected records. */
export const evidenceLinkTraversalSchema = z.enum([
  "direct",
  "retained-closure",
]);
/** Which inspected links a page returns; counts always cover all of them. */
export const evidenceLinkStatusFilterSchema = z.enum([
  "missing",
  "retained",
  "all",
]);

/** Default page size for link rows, which carry two identifiers each. */
export const EVIDENCE_LINK_INSPECTION_LIMIT = 64;

/** Bounds what link membership establishes, in every inspection. */
const EVIDENCE_LINK_INSPECTION_LIMITATIONS = [
  "Link status is membership in this session or bundle: missing means absent here, not nonexistent, and neither status describes analysis coverage or a record's meaning.",
] as const;

/** Direct links, or the retained closure, of selected records without their payloads. */
export const evidenceLinkInspectionSchema = z.strictObject({
  kind: z.literal("evidence-link-inspection"),
  filters: z.record(z.string(), z.string()),
  traversal: evidenceLinkTraversalSchema,
  link_status: evidenceLinkStatusFilterSchema,
  total_retained_records: countSchema,
  matching_records: countSchema,
  examined_records: countSchema.describe(
    "Retained records whose evidence_links were read: the matching records, plus those reached through retained links when traversal is retained-closure.",
  ),
  links: z
    .strictObject({
      total: countSchema,
      retained: countSchema,
      missing: countSchema,
    })
    .describe("Every link read from the examined records, before link_status."),
  retained_closure: z
    .enum(["complete", "incomplete"])
    .nullable()
    .describe(
      "With retained-closure traversal, incomplete means a link could not be followed, so what lies beyond it remains unknown. Null for direct traversal or an empty selection, which make no closure claim.",
    ),
  offset: countSchema,
  limit: z.int().positive(),
  matching_links: countSchema,
  next_offset: countSchema.nullable(),
  rows: z.array(
    z.strictObject({
      evidence_id: prefixedDigestSchema("ev"),
      linked_evidence_id: prefixedDigestSchema("ev"),
      status: z.enum(["retained", "missing"]),
    }),
  ),
  limitations: z.array(z.string()),
});
export type EvidenceLinkInspection = z.infer<
  typeof evidenceLinkInspectionSchema
>;

/** Read link membership without copying or parsing any record payload. */
export const inspectEvidenceLinks = (
  bundle: EvidenceBundle,
  filters: EvidenceRecordFilters = {},
  options: {
    readonly traversal?:
      | z.infer<typeof evidenceLinkTraversalSchema>
      | undefined;
    readonly linkStatus?:
      | z.infer<typeof evidenceLinkStatusFilterSchema>
      | undefined;
    readonly offset?: number | undefined;
    readonly limit?: number | undefined;
  } = {},
): EvidenceLinkInspection => {
  const traversal = options.traversal ?? "direct";
  const linkStatus = options.linkStatus ?? "missing";
  const offset = options.offset ?? 0;
  const limit = options.limit ?? EVIDENCE_LINK_INSPECTION_LIMIT;
  const retained = new Map(
    bundle.records.map((record) => [record.evidence_id, record]),
  );
  const examined = new Set<string>();
  const pending: string[] = [];
  for (const { evidence } of matchingEvidenceRecords(bundle, filters))
    pending.push(evidence.evidence_id);
  const matching = pending.length;
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || examined.has(id)) continue;
    examined.add(id);
    if (traversal === "direct") continue;
    for (const link of retained.get(id)?.evidence_links ?? [])
      if (retained.has(link) && !examined.has(link)) pending.push(link);
  }
  const rows: EvidenceLinkInspection["rows"] = [];
  const counts = { total: 0, retained: 0, missing: 0 };
  let matchingLinks = 0;
  // Bundle order is canonical, so a page stays stable across requests.
  for (const evidence of bundle.records) {
    const id = evidence.evidence_id;
    if (!examined.has(id)) continue;
    for (const link of directLinksOf(evidence)) {
      const status = retained.has(link) ? "retained" : "missing";
      counts.total += 1;
      counts[status] += 1;
      if (linkStatus !== "all" && linkStatus !== status) continue;
      if (matchingLinks >= offset && rows.length < limit)
        rows.push({ evidence_id: id, linked_evidence_id: link, status });
      matchingLinks += 1;
    }
  }
  const end = offset + rows.length;
  return {
    kind: "evidence-link-inspection",
    filters: selectedFilters(filters),
    traversal,
    link_status: linkStatus,
    total_retained_records: bundle.records.length,
    matching_records: matching,
    examined_records: examined.size,
    links: counts,
    // Nothing selected, or a direct read, supports no claim about a closure.
    retained_closure:
      traversal === "direct" || examined.size === 0
        ? null
        : counts.missing === 0
          ? "complete"
          : "incomplete",
    offset,
    limit,
    matching_links: matchingLinks,
    next_offset: end < matchingLinks ? end : null,
    rows,
    limitations: [...EVIDENCE_LINK_INSPECTION_LIMITATIONS],
  };
};
