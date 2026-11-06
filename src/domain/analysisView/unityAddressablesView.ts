import { z } from "zod";
import { analysisViewInputError } from "./analysisViewErrors.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { isImmutableJsonSnapshot } from "../immutableJson.js";
import {
  UNITY_ADDRESSABLES_KEY_KINDS,
  unityAddressablesKeySchema,
  unityAddressablesLocationSchema,
  unityAddressablesObjectSchema,
  unityAddressablesProviderSchema,
  unityAddressablesSchema,
} from "../unity/unityAddressables.js";
import { err, ok, type Result } from "../result.js";
import { parseAnalysisViewResult } from "./analysisViewParent.js";
import { pageIndexedRows } from "./indexedRowPage.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  ownedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import {
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";

const count = z.number().int().nonnegative();
const countsSchema = z.strictObject({
  providers: count,
  keys: count,
  locations: count,
  /** Locations whose data is asset bundle request options. */
  bundles: count,
  dependency_edges: count,
});

export const unityAddressablesSummarySchema = unityAddressablesObjectSchema
  .omit({ providers: true, keys: true, locations: true })
  .extend({ counts: countsSchema });

const keyRowSchema = unityAddressablesKeySchema.extend({ index: count });
const locationRowSchema = unityAddressablesLocationSchema.extend({
  index: count,
});
const providerRowSchema = unityAddressablesProviderSchema.extend({
  index: count,
});
const page = {
  kind: z.literal("unity-addressables"),
  indices: z.array(count).optional(),
  offset: count.default(0),
  limit: z.number().int().positive().default(64),
};

/** Filters intersect; pages use catalog order and always retain the source row index. */
export const unityAddressablesViewRequestSchema = z.discriminatedUnion(
  "collection",
  [
    z.strictObject({
      ...page,
      collection: z.literal("keys"),
      values: z.array(z.string()).optional(),
      kinds: z.array(z.enum(UNITY_ADDRESSABLES_KEY_KINDS)).optional(),
      fields: z.array(keyRowSchema.keyof()).optional(),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("locations"),
      /** Locations selected by these key indices. */
      key_indices: z.array(count).optional(),
      primary_keys: z.array(z.string()).optional(),
      provider_ids: z.array(z.string()).optional(),
      internal_ids: z.array(z.string()).optional(),
      data_kinds: z.array(z.enum(["asset-bundle", "other", "none"])).optional(),
      fields: z.array(locationRowSchema.keyof()).optional(),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("providers"),
      fields: z.array(providerRowSchema.keyof()).optional(),
    }),
  ],
);

export const unityAddressablesViewItemsSchema = z.union([
  z.array(keyRowSchema.partial().required({ index: true })),
  z.array(locationRowSchema.partial().required({ index: true })),
  z.array(providerRowSchema.partial().required({ index: true })),
]);

export const unityAddressablesViewContextSchema = z.strictObject({
  format: unityAddressablesObjectSchema.shape.format,
  format_version: unityAddressablesObjectSchema.shape.format_version,
  counts: countsSchema,
});

type Report = z.infer<typeof unityAddressablesSchema>;
type Request = z.infer<typeof unityAddressablesViewRequestSchema>;
type Row =
  | Report["keys"][number]
  | Report["locations"][number]
  | Report["providers"][number];
interface CheckedReport {
  readonly report: Report;
  readonly counts: z.infer<typeof countsSchema>;
}

// Authenticated, frozen parents own these facts; cache validation for their lifetime.
const checkedReports = new WeakMap<object, CheckedReport>();

const parseCatalogReport = (
  parent: AnalysisViewParent,
): Result<CheckedReport, AnalysisError> => {
  const key = parent.normalizedResult;
  const reusable =
    parent.sealedResult === true &&
    typeof key === "object" &&
    key !== null &&
    isImmutableJsonSnapshot(key);
  const cached = reusable ? checkedReports.get(key) : undefined;
  if (cached !== undefined) return ok(cached);
  const parsed = parseAnalysisViewResult(unityAddressablesSchema, parent);
  if (!parsed.ok) return parsed;
  const report = reusable ? (key as Report) : parsed.value;
  const checked = {
    report,
    counts: {
      providers: report.providers.length,
      keys: report.keys.length,
      locations: report.locations.length,
      bundles: report.locations.filter(
        (location) => location.data?.kind === "asset-bundle",
      ).length,
      dependency_edges: report.locations.reduce(
        (total, location) => total + location.dependencies.length,
        0,
      ),
    },
  };
  if (reusable) checkedReports.set(key, checked);
  return ok(checked);
};

const set = <T>(values: readonly T[] | undefined) =>
  values === undefined ? undefined : new Set(values);

/** Compile caller selections once; undefined means every row matches. */
const selection = (view: Request, report: Report) => {
  if (view.collection === "keys") {
    const values = set(view.values);
    const kinds = set<string>(view.kinds);
    if (values === undefined && kinds === undefined) return undefined;
    return (row: Row) =>
      "kind" in row &&
      "locations" in row &&
      (values === undefined || (row.value !== null && values.has(row.value))) &&
      (kinds === undefined || kinds.has(row.kind));
  }
  if (view.collection === "providers") return undefined;
  const keyed =
    view.key_indices === undefined
      ? undefined
      : keyedLocations(report, view.key_indices);
  const primary = set(view.primary_keys);
  const providers = set(view.provider_ids);
  const internal = set(view.internal_ids);
  const dataKinds = set<string>(view.data_kinds);
  if (
    [keyed, primary, providers, internal, dataKinds].every(
      (filter) => filter === undefined,
    )
  )
    return undefined;
  return (row: Row, index: number) =>
    "internal_id" in row &&
    (keyed === undefined || keyed.has(index)) &&
    (primary === undefined ||
      (row.primary_key !== null && primary.has(row.primary_key))) &&
    (providers === undefined ||
      (row.provider_id !== null && providers.has(row.provider_id))) &&
    (internal === undefined ||
      (row.internal_id !== null && internal.has(row.internal_id))) &&
    (dataKinds === undefined || dataKinds.has(row.data?.kind ?? "none"));
};

/** Walk each distinct key once, so repeated indices do not copy its locations again. */
const keyedLocations = (
  report: { keys: readonly { locations: readonly number[] }[] },
  keyIndices: readonly number[],
): Set<number> => {
  const selected = new Set<number>();
  for (const index of new Set(keyIndices))
    for (const location of report.keys[index]?.locations ?? [])
      selected.add(location);
  return selected;
};

/** Reuse retained facts; source indices stay distinct from filtered page offsets. */
export const projectUnityAddressablesView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const view = ownedView<
    SummaryAnalysisView | z.output<typeof unityAddressablesViewRequestSchema>
  >(admitted, "summary", "unity-addressables");
  if (view === undefined)
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Unity Addressables Evidence supports summary and selected keys, locations and providers pages.",
        },
      ]),
    );
  const parsed = parseCatalogReport(parent);
  if (!parsed.ok) return parsed;
  const { report, counts } = parsed.value;
  // An index past the key table names no key; it must not read as a key without locations.
  const missingKey =
    view.kind === "unity-addressables" && view.collection === "locations"
      ? (view.key_indices ?? []).findIndex(
          (index) => index >= report.keys.length,
        )
      : -1;
  if (missingKey >= 0)
    return err(
      analysisViewInputError([
        {
          path: ["view", "key_indices", missingKey],
          reason: "invalid_value",
          message: `The catalog has ${report.keys.length} keys; key_indices must name one of them.`,
        },
      ]),
    );
  if (
    parent.subject != null &&
    (parent.subject.format !== "file" ||
      parent.subject.local_path !== report.artifact.path ||
      parent.subject.digest.sha256 !== report.artifact.sha256)
  )
    return err(
      analysisViewInputError([
        {
          path: ["source", "subject"],
          reason: "invalid_value",
          message:
            "Unity Addressables artifact identity does not match its parent subject.",
        },
      ]),
    );
  const { providers, keys, locations, ...identity } = report;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_unity_addressables" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    limitations: [...parent.limitations],
    unknowns: [
      "Runtime values of internal id placeholders, bundle bytes and whether the catalog is the one a build loads remain unknown.",
      ...(parent.subject == null
        ? [
            "The parent has no recorded subject; its normalized artifact identity cannot be cross-checked against a subject digest.",
          ]
        : []),
    ],
  };
  if (view.kind === "summary")
    return ok({
      kind: "summary" as const,
      view,
      ...shared,
      summary: { ...identity, counts },
      coverage: completeWithinViewCoverage(1, 1),
    });
  const rows: readonly Row[] = { keys, locations, providers }[view.collection];
  const { items, total } = pageIndexedRows(rows, view, selection(view, report));
  return ok({
    kind: "unity-addressables" as const,
    view,
    ...shared,
    items,
    format: report.format,
    format_version: report.format_version,
    counts,
    coverage: pageViewCoverage(view.offset, items.length, total),
  });
};
