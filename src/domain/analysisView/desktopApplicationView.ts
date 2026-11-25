import { z } from "zod";
import {
  desktopApplicationSchema,
  desktopFileSchema,
  desktopOmissionSchema,
  desktopCandidateSchema,
  desktopComponentSchema,
  desktopProbeSchema,
  desktopDeferredProbeSchema,
  desktopFamilySchema,
  desktopCoverageSchema,
  type DesktopApplication,
} from "../desktopApplication.js";
import {
  invalidAnalysisViewSubject,
  invalidAnalysisView,
} from "./analysisViewErrors.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";
import {
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  ownedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { pickFields, selectViewRows } from "./selectViewRows.js";
import { ok } from "../result.js";
import { evidenceFileTarget } from "../evidence.js";

// Bound diagnostic context independently of the retained report size. Previews
// are display values; stable file IDs select the original paths and all issues.
const DIAGNOSTIC_PREVIEW_FILES = 2;
const DIAGNOSTIC_PREVIEW_UNITS = 256;

const hasProbeIssues = (file: {
  readonly issues: readonly string[];
}): boolean => file.issues.length > 0;

const diagnosticTextPreview = (value: string) => {
  let end = Math.min(value.length, DIAGNOSTIC_PREVIEW_UNITS);
  const last = value.charCodeAt(end - 1);
  if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
  return { text: value.slice(0, end), truncated: end < value.length };
};

const page = {
  kind: z.literal("desktop-application"),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(64),
};
export const desktopViewRequestSchema = z.discriminatedUnion("collection", [
  z.strictObject({
    ...page,
    collection: z.literal("files"),
    paths: z.array(z.string()).optional(),
    file_ids: z.array(desktopFileSchema.shape.file_id).optional(),
    has_issues: z.boolean().optional(),
    fields: z.array(desktopFileSchema.keyof()).optional(),
  }),
  z.strictObject({
    ...page,
    collection: z.literal("candidates"),
    families: z.array(desktopFamilySchema).optional(),
    fields: z.array(desktopCandidateSchema.keyof()).optional(),
  }),
  z.strictObject({
    ...page,
    collection: z.literal("omissions"),
    paths: z.array(z.string()).optional(),
    omission_ids: z.array(desktopOmissionSchema.shape.omission_id).optional(),
    fields: z.array(desktopOmissionSchema.keyof()).optional(),
  }),
  z.strictObject({
    ...page,
    collection: z.literal("components"),
    fields: z.array(desktopComponentSchema.keyof()).optional(),
  }),
  z.strictObject({
    ...page,
    collection: z.literal("next_probes"),
    fields: z.array(desktopProbeSchema.keyof()).optional(),
  }),
]);
export const desktopViewItemsSchema = z.array(
  z.union([
    desktopFileSchema.partial(),
    desktopOmissionSchema.partial(),
    desktopCandidateSchema.partial(),
    desktopComponentSchema.partial(),
    desktopProbeSchema.partial(),
  ]),
);
export const desktopSummarySchema = z.strictObject({
  root: desktopApplicationSchema.shape.root,
  source_coverage: desktopCoverageSchema,
  available_counts: z.strictObject({
    files: z.number().int().nonnegative(),
    omissions: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
    components: z.number().int().nonnegative(),
    next_probes: z.number().int().nonnegative(),
  }),
  probe_issues: z.strictObject({
    file_count: z.number().int().nonnegative(),
    issue_count: z.number().int().nonnegative(),
    preview: z
      .array(
        z.strictObject({
          file_id: desktopFileSchema.shape.file_id,
          path_preview: z.string(),
          read_status: desktopFileSchema.shape.read_status,
          issue_count: z.number().int().positive(),
          first_issue_preview: z.string(),
          text_truncated: z.boolean(),
        }),
      )
      .max(DIAGNOSTIC_PREVIEW_FILES),
    preview_truncated: z
      .boolean()
      .describe(
        "More retained files have probe issues than fit in the preview.",
      ),
  }),
  candidates: z.array(
    desktopCandidateSchema.omit({ basis_file_ids: true }).extend({
      basis_file_count: z.number().int().positive(),
      basis_path_preview: z.array(z.string()),
    }),
  ),
  components: z.array(
    desktopComponentSchema.omit({ basis_file_ids: true }).extend({
      basis_file_count: z.number().int().positive(),
      basis_path_preview: z.array(z.string()),
    }),
  ),
  next_probe_groups: z.array(
    z.strictObject({
      operation: desktopProbeSchema.shape.operation,
      count: z.number().int().positive(),
      example: desktopProbeSchema,
    }),
  ),
  /** Probes counted rather than listed: one bounded group per operation and reason. */
  deferred_probes: z.array(desktopDeferredProbeSchema),
});

type DesktopCollection = z.infer<typeof desktopViewRequestSchema>["collection"];
type DesktopViewRow = DesktopApplication[DesktopCollection][number];

// Only immutable authenticated parent objects are reused. They are not live filesystem caches.
const readDesktopApplication = createAnalysisViewResultReader(
  desktopApplicationSchema,
);
export const projectDesktopApplicationView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const view = ownedView<
    SummaryAnalysisView | z.output<typeof desktopViewRequestSchema>
  >(admitted, "summary", "desktop-application");
  if (view === undefined)
    return invalidAnalysisView(
      "Desktop directory Evidence supports summary and desktop-application views.",
    );
  const parsed = readDesktopApplication(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const subject = evidenceFileTarget(parent);
  if (
    subject === undefined ||
    subject.format !== "directory" ||
    subject.sha256 !== report.root.snapshot_sha256
  )
    return invalidAnalysisViewSubject(
      "Parent must identify the same examined directory snapshot.",
    );
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_desktop_application" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.root.path, sha256: report.root.snapshot_sha256 },
    limitations: [...new Set([...parent.limitations, ...report.limitations])],
    unknowns: [
      "Runtime behavior and unread bytes remain unknown.",
      ...(report.coverage.status === "partial"
        ? [
            "Source inspection is partial; an exhausted page does not establish absence.",
          ]
        : []),
    ],
  };
  if (view.kind === "summary") {
    const byId = new Map<string, string>();
    const probeIssues: z.infer<typeof desktopSummarySchema>["probe_issues"] = {
      file_count: 0,
      issue_count: 0,
      preview: [],
      preview_truncated: false,
    };
    // Reuse the path-index pass; do not allocate another full file selection or
    // traverse every issue string just to form this bounded diagnostic summary.
    for (const file of report.files) {
      byId.set(file.file_id, file.path);
      if (!hasProbeIssues(file)) continue;
      probeIssues.file_count++;
      probeIssues.issue_count += file.issues.length;
      if (probeIssues.preview.length === DIAGNOSTIC_PREVIEW_FILES) continue;
      const firstIssue = file.issues[0];
      if (firstIssue === undefined) continue;
      const path = diagnosticTextPreview(file.path);
      const issue = diagnosticTextPreview(firstIssue);
      probeIssues.preview.push({
        file_id: file.file_id,
        path_preview: path.text,
        read_status: file.read_status,
        issue_count: file.issues.length,
        first_issue_preview: issue.text,
        text_truncated: path.truncated || issue.truncated,
      });
    }
    probeIssues.preview_truncated =
      probeIssues.file_count > probeIssues.preview.length;
    const summarizeBasis = <T extends { basis_file_ids: string[] }>(row: T) => {
      const { basis_file_ids, ...value } = row;
      return {
        ...value,
        basis_file_count: basis_file_ids.length,
        basis_path_preview: basis_file_ids
          .slice(0, 2)
          .map((id) => byId.get(id) ?? id),
      };
    };
    const groups = new Map<
      string,
      {
        operation: DesktopApplication["next_probes"][number]["operation"];
        count: number;
        example: DesktopApplication["next_probes"][number];
      }
    >();
    for (const probe of report.next_probes) {
      const group = groups.get(probe.operation);
      if (group === undefined)
        groups.set(probe.operation, {
          operation: probe.operation,
          count: 1,
          example: probe,
        });
      else group.count++;
    }
    return ok({
      kind: "summary" as const,
      view,
      ...shared,
      summary: {
        root: report.root,
        source_coverage: report.coverage,
        available_counts: {
          files: report.files.length,
          omissions: report.omissions.length,
          candidates: report.candidates.length,
          components: report.components.length,
          next_probes: report.next_probes.length,
        },
        probe_issues: probeIssues,
        candidates: report.candidates.map(summarizeBasis),
        components: report.components.map(summarizeBasis),
        next_probe_groups: [...groups.values()],
        deferred_probes: report.deferred_probes,
      },
      coverage: completeWithinViewCoverage(report.files.length),
    });
  }
  const rows: readonly DesktopViewRow[] = report[view.collection];
  let matches: ((row: DesktopViewRow) => boolean) | undefined;
  if (view.collection === "files" || view.collection === "omissions") {
    const paths = view.paths === undefined ? undefined : new Set(view.paths);
    const ids = view.collection === "files" ? view.file_ids : view.omission_ids;
    const selected = ids === undefined ? undefined : new Set(ids);
    const withIssues =
      view.collection === "files" ? view.has_issues : undefined;
    if (
      paths !== undefined ||
      selected !== undefined ||
      withIssues !== undefined
    )
      matches = (row) =>
        (paths === undefined || ("path" in row && paths.has(row.path))) &&
        (selected === undefined ||
          ("file_id" in row
            ? selected.has(row.file_id)
            : "omission_id" in row && selected.has(row.omission_id))) &&
        (withIssues === undefined ||
          ("issues" in row && hasProbeIssues(row) === withIssues));
  } else if (view.collection === "candidates" && view.families !== undefined) {
    const selected = new Set(view.families);
    matches = (row) => "family" in row && selected.has(row.family);
  }
  const idField = {
    files: "file_id",
    omissions: "omission_id",
    candidates: "candidate_id",
    components: "component_id",
    next_probes: "probe_id",
  }[view.collection];
  const fields =
    view.fields === undefined
      ? undefined
      : new Set<string>([idField, ...view.fields]);
  const selected = selectViewRows(rows, view, matches, (row) =>
    fields === undefined
      ? row
      : pickFields(row as Record<string, unknown>, fields),
  );
  return ok({
    kind: "desktop-application" as const,
    view,
    ...shared,
    source_coverage: report.coverage,
    items: desktopViewItemsSchema.parse(selected.rows),
    coverage: pageViewCoverage(
      view.offset,
      selected.rows.length,
      selected.total,
    ),
  });
};
