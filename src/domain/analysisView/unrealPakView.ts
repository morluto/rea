import { analysisViewInputError } from "./analysisViewErrors.js";
import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import {
  UNREAL_PAK_ISSUE_KINDS,
  unrealPakEntrySchema,
  unrealPakIssueSchema,
  unrealPakSchema,
} from "../unreal/unrealPak.js";
import { err, ok, type Result } from "../result.js";
import { isImmutableJsonSnapshot } from "../immutableJson.js";
import { parseAnalysisViewResult } from "./analysisViewParent.js";
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

/** Unknown added when the pak index is encrypted and its pages are unread. */
export const UNREAD_ENCRYPTED_INDEX_UNKNOWN =
  "The pak index is encrypted and was not read; empty entry pages mean unread, not absent.";

const count = z.number().int().nonnegative();
const countsSchema = z.strictObject({
  entries: count,
  encoded_records: count,
  full_records: count,
  compressed: count,
  encrypted: count,
  deleted: count,
  without_path: count,
  issues: count,
});

/** Footer and index facts with entry counts instead of entries. */
export const unrealPakSummarySchema = unrealPakSchema
  .omit({ entries: true, issues: true })
  .extend({ counts: countsSchema });

const indexSchema = z.number().int().nonnegative();
const entryRowSchema = unrealPakEntrySchema.extend({ index: indexSchema });
const issueRowSchema = unrealPakIssueSchema.extend({ index: indexSchema });
const page = {
  kind: z.literal("unreal-pak"),
  indices: z.array(indexSchema).optional(),
  offset: indexSchema.default(0),
  limit: z.number().int().positive().default(64),
};

/** Filters intersect; pages use source order and always retain the source row index. */
export const unrealPakViewRequestSchema = z.discriminatedUnion("collection", [
  z.strictObject({
    ...page,
    collection: z.literal("entries"),
    paths: z.array(z.string()).optional(),
    fields: z.array(entryRowSchema.keyof()).optional(),
  }),
  z.strictObject({
    ...page,
    collection: z.literal("issues"),
    kinds: z.array(z.enum(UNREAL_PAK_ISSUE_KINDS)).optional(),
    fields: z.array(issueRowSchema.keyof()).optional(),
  }),
]);

export const unrealPakViewItemsSchema = z.union([
  z.array(entryRowSchema.partial().required({ index: true })),
  z.array(issueRowSchema.partial().required({ index: true })),
]);

export const unrealPakViewContextSchema = z.strictObject({
  footer_layout: unrealPakSchema.shape.footer.shape.layout,
  /** Pages from an encrypted index are not-read, not none-found. */
  index_state: z.enum(["decoded", "encrypted"]),
  index_encrypted: unrealPakSchema.shape.footer.shape.index_encrypted,
  counts: countsSchema,
});

type UnrealPakReport = z.infer<typeof unrealPakSchema>;
interface CheckedReport {
  readonly report: UnrealPakReport;
  readonly counts: z.infer<typeof countsSchema>;
}

// Authenticated, frozen parents own these facts. Cache validation/counts for
// their lifetime without a second report copy or a live filesystem cache.
const checkedReports = new WeakMap<object, CheckedReport>();

/** Validate the parent and count its entries once per immutable sealed result. */
const parsePakReport = (
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
  const parsed = parseAnalysisViewResult(unrealPakSchema, parent);
  if (!parsed.ok) return parsed;
  // This schema has no coercions/transforms; the authenticated owner value is
  // equivalent to the validated clone and remains immutable across pages.
  const report = reusable ? (key as UnrealPakReport) : parsed.value;
  const tally = (
    keep: (entry: UnrealPakReport["entries"][number]) => boolean,
  ) => report.entries.filter(keep).length;
  const checked = {
    report,
    counts: {
      entries: report.entries.length,
      encoded_records: tally((entry) => entry.record === "encoded"),
      full_records: tally((entry) => entry.record === "full"),
      compressed: tally((entry) => entry.compression_method !== 0),
      encrypted: tally((entry) => entry.encrypted),
      deleted: tally((entry) => entry.deleted),
      without_path: tally((entry) => entry.path === null),
      issues: report.issues.length,
    },
  };
  if (reusable) checkedReports.set(key, checked);
  return ok(checked);
};

/** Reuse retained pak Evidence without reopening or decoding the file. */
export const projectUnrealPakView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const view = ownedView<
    SummaryAnalysisView | z.output<typeof unrealPakViewRequestSchema>
  >(admitted, "summary", "unreal-pak");
  if (view === undefined)
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message: "Unreal pak Evidence supports summary and entries pages.",
        },
      ]),
    );
  const parsed = parsePakReport(parent);
  if (!parsed.ok) return parsed;
  const { report, counts } = parsed.value;
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
            "Unreal pak artifact identity does not match its parent subject.",
        },
      ]),
    );
  const { entries, issues, ...identity } = report;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_unreal_pak" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: {
      path: identity.artifact.path,
      sha256: identity.artifact.sha256,
    },
    limitations: [...parent.limitations],
    unknowns: [
      "Entries come from the pak index only; file data, compressed contents and encrypted indexes were not read or decrypted.",
      ...(identity.index.state === "encrypted"
        ? [UNREAD_ENCRYPTED_INDEX_UNKNOWN]
        : []),
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
  const rows: readonly Readonly<Record<string, unknown>>[] =
    view.collection === "entries" ? entries : issues;
  const keep: (row: Readonly<Record<string, unknown>>) => boolean = (() => {
    if (view.collection === "entries") {
      const paths = view.paths === undefined ? undefined : new Set(view.paths);
      return (row) =>
        paths === undefined ||
        (typeof row.path === "string" && paths.has(row.path));
    }
    const kinds = view.kinds === undefined ? undefined : new Set(view.kinds);
    return (row) => kinds === undefined || kinds.has(row.kind as never);
  })();
  const fields =
    view.fields === undefined ? undefined : new Set<string>(view.fields);
  const selected =
    view.indices === undefined
      ? rows.keys()
      : [...new Set(view.indices)]
          .sort((a, b) => a - b)
          .filter((index) => index < rows.length);
  const items: Record<string, unknown>[] = [];
  let total = 0;
  for (const index of selected) {
    const row = rows[index]!;
    if (!keep(row)) continue;
    if (total >= view.offset && items.length < view.limit) {
      const item: Record<string, unknown> = { index };
      for (const [key, value] of Object.entries(row))
        if (fields === undefined || fields.has(key)) item[key] = value;
      items.push(item);
    }
    total++;
  }
  return ok({
    kind: "unreal-pak" as const,
    view,
    ...shared,
    items: items as z.infer<typeof unrealPakViewItemsSchema>,
    footer_layout: identity.footer.layout,
    index_state: identity.index.state,
    index_encrypted: identity.footer.index_encrypted,
    counts,
    coverage: pageViewCoverage(view.offset, items.length, total),
  });
};
