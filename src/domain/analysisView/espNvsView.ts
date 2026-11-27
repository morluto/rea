import { z } from "zod";
import { espNvsReportSchema } from "../firmware/espNvs.js";
import { ok } from "../result.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { invalidAnalysisView } from "./analysisViewErrors.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";
import {
  boundedViewLimitations,
  completeWithinViewCoverage,
  selectedViewPage,
} from "./analysisViewCoverage.js";
import { selectViewRows } from "./selectViewRows.js";

export const espNvsViewRequestSchema = z.strictObject({
  kind: z.literal("esp-nvs"),
  collection: z.enum(["entries", "pages", "namespaces", "anomalies"]),
  namespace: z
    .string()
    .optional()
    .describe(
      "Exact NVS namespace name filter; supported only for the entries collection",
    ),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().max(1024).default(64),
});

const sourceIndex = { source_index: z.int().nonnegative() };

export const espNvsViewItemsSchema = z.union([
  z.array(espNvsReportSchema.shape.entries.element.extend(sourceIndex)),
  z.array(espNvsReportSchema.shape.pages.element.extend(sourceIndex)),
  z.array(espNvsReportSchema.shape.namespaces.element.extend(sourceIndex)),
  z.array(
    z.strictObject({
      anomaly: z.string(),
      ...sourceIndex,
    }),
  ),
]);

const {
  artifact,
  partition_range,
  coverage,
  namespaces,
  corrupt_entry_count,
  undecoded_page_count,
} = espNvsReportSchema.shape;

const counts = {
  page_count: z.int().nonnegative(),
  namespace_count: z.int().nonnegative(),
  entry_count: z.int().nonnegative(),
  corrupt_entry_count,
  undecoded_page_count,
  anomaly_count: z.int().nonnegative(),
};

export const espNvsSummarySchema = z.strictObject({
  artifact,
  partition_range,
  coverage,
  namespaces,
  ...counts,
});

export const espNvsPageContextSchema = z.strictObject({
  artifact,
  partition_range,
  coverage,
  ...counts,
});

const readReport = createAnalysisViewResultReader(espNvsReportSchema);

export const projectEspNvsView = (
  parent: AnalysisViewParent,
  view: AdmittedView,
) => {
  if (view.kind !== "summary" && view.kind !== "esp-nvs")
    return invalidAnalysisView(
      "ESP-IDF NVS Evidence supports summary and esp-nvs views.",
    );
  assertOwnedView<
    SummaryAnalysisView | z.output<typeof espNvsViewRequestSchema>
  >(view, "summary", "esp-nvs");
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const r = parsed.value;
  const context = {
    artifact: r.artifact,
    partition_range: r.partition_range,
    coverage: r.coverage,
    page_count: r.pages.length,
    namespace_count: r.namespaces.length,
    entry_count: r.entries.length,
    corrupt_entry_count: r.corrupt_entry_count,
    undecoded_page_count: r.undecoded_page_count,
    anomaly_count: r.anomalies.length,
  };
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_esp_nvs" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: r.artifact.path, sha256: r.artifact.sha256 },
    limitations: boundedViewLimitations(parent, r.limitations),
    unknowns: [
      "Encrypted NVS entries (XTS-AES with nvs_keys) cannot be decrypted without key material; their pages decode with every item header unreadable.",
    ],
  };
  if (view.kind === "summary")
    return ok({
      ...shared,
      kind: "summary" as const,
      view,
      summary: { ...context, namespaces: r.namespaces },
      coverage: completeWithinViewCoverage(r.entries.length),
    });

  if (view.namespace !== undefined && view.collection !== "entries")
    return invalidAnalysisView(
      "namespace filters only the entries collection.",
    );

  const selected =
    view.collection === "entries"
      ? selectViewRows(
          r.entries,
          view,
          view.namespace === undefined
            ? undefined
            : (entry) => entry.namespace === view.namespace,
          (entry, source_index) => ({ ...entry, source_index }),
        )
      : view.collection === "pages"
        ? selectViewRows(r.pages, view, undefined, (row, source_index) => ({
            ...row,
            source_index,
          }))
        : view.collection === "namespaces"
          ? selectViewRows(
              r.namespaces,
              view,
              undefined,
              (row, source_index) => ({ ...row, source_index }),
            )
          : selectViewRows(
              r.anomalies,
              view,
              undefined,
              (anomaly, source_index) => ({ anomaly, source_index }),
            );

  return ok({
    ...shared,
    kind: "esp-nvs" as const,
    view,
    nvs: context,
    ...selectedViewPage(view.offset, selected),
  });
};
