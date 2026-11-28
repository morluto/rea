import { z } from "zod";

import { androidResultSchemas } from "../android/androidAnalysis.js";
import { androidReferencesViewSchema } from "../android/androidReferencesQuery.js";
import { evidenceSubjectTarget } from "../evidence.js";
import { boundedList } from "../boundedList.js";
import type { JsonValue } from "../jsonValue.js";
import { ok } from "../result.js";
import {
  PLACEHOLDER_COVERAGE,
  selectByteBoundedViewRows,
  type ByteBoundedPageOwner,
} from "./byteBoundedViewRows.js";
import { filterSet, pickFields } from "./selectViewRows.js";
import {
  invalidAnalysisViewSubject,
  invalidAnalysisView,
} from "./analysisViewErrors.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  boundedViewLimitations,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";

export const TRACE_ANDROID_REFERENCES_OPERATION =
  "trace_android_references" as const;

const traceSchema = androidResultSchemas.trace_android_references;
type Trace = z.output<typeof traceSchema>;
type Reference = Trace["references"][number];
type ReferencesView = z.output<typeof androidReferencesViewSchema>;

/** Packages listed in a summary, most referenced first. */
const SUMMARY_PACKAGES = 32;

const count = z.int().nonnegative();

/** The trace target and coverage, with counts in place of the using nodes. */
export const androidReferencesSummarySchema = traceSchema
  .omit({ references: true })
  .extend({
    counts: z.strictObject({
      references: count,
      by_kind: z.record(z.string(), count),
      top_classes: count,
      packages: count,
    }),
    packages: z
      .strictObject({
        items: z.array(
          z.strictObject({ package: z.string(), references: count }),
        ),
        omitted: count,
      })
      .describe(
        `Packages of the using nodes' top_class, most referenced first, at most ${String(SUMMARY_PACKAGES)}; omitted counts the rest`,
      ),
  });

/** One using node with its position in the complete inventory. */
export const androidReferenceRowSchema = traceSchema.shape.references.element
  .partial()
  .extend({ index: count });

/** One distinct top class and how many using nodes it contains. */
export const androidReferenceTopClassRowSchema = z.strictObject({
  top_class: z.string(),
  package: z.string(),
  references: count,
});

/** The trace target every page carries, so a page names what it traced. */
export const androidReferencesTargetSchema = traceSchema.pick({
  target_definition: true,
  reference_scope: true,
  class_name: true,
  method_name: true,
  overload_index: true,
  reported_signature: true,
  dex_descriptor: true,
  total: true,
  direct_invokes_coverage: true,
  coverage: true,
  reference_unit: true,
});

const readTrace = createAnalysisViewResultReader(traceSchema);

/** The package of a class name: the part before its last dot. */
const packageOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(0, dot);
};

const summarize = (
  trace: Trace,
): z.output<typeof androidReferencesSummarySchema> => {
  const { references, ...facts } = trace;
  const byKind: Record<string, number> = {};
  const topClasses = new Set<string>();
  const packages = new Map<string, number>();
  for (const row of references) {
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    topClasses.add(row.top_class);
    const name = packageOf(row.top_class);
    packages.set(name, (packages.get(name) ?? 0) + 1);
  }
  const listed = boundedList(
    [...packages]
      .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, references]) => ({ package: name, references })),
    SUMMARY_PACKAGES,
  );
  return {
    ...facts,
    counts: {
      references: references.length,
      by_kind: byKind,
      top_classes: topClasses.size,
      packages: packages.size,
    },
    packages: { items: [...listed.items], omitted: listed.omitted },
  };
};

/** One top class's using nodes, counted by kind. */
interface TopClassGroup {
  readonly top_class: string;
  readonly package: string;
  readonly kinds: ReadonlyMap<string, number>;
  readonly references: number;
}

/** Top classes sorted by name, grouped once per retained trace. */
const groupedTraces = new WeakMap<Trace, readonly TopClassGroup[]>();
const topClassGroups = (trace: Trace): readonly TopClassGroup[] => {
  const known = groupedTraces.get(trace);
  if (known !== undefined) return known;
  const groups = new Map<string, Map<string, number>>();
  for (const row of trace.references) {
    const kinds = groups.get(row.top_class) ?? new Map<string, number>();
    kinds.set(row.kind, (kinds.get(row.kind) ?? 0) + 1);
    groups.set(row.top_class, kinds);
  }
  const sorted = [...groups]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([top_class, kinds]) => {
      let references = 0;
      for (const n of kinds.values()) references += n;
      return { top_class, package: packageOf(top_class), kinds, references };
    });
  groupedTraces.set(trace, sorted);
  return sorted;
};

/** Exact filters shared by both facets; undefined fields match everything. */
const filtersOf = (view: ReferencesView) => ({
  kinds: filterSet(view.kinds),
  packages: filterSet(view.packages),
  tops: filterSet(view.top_classes),
});

const matcher = (view: ReferencesView) => {
  const { kinds, packages, tops } = filtersOf(view);
  if (kinds === undefined && packages === undefined && tops === undefined)
    return undefined;
  return (row: Reference) =>
    (kinds === undefined || kinds.has(row.kind)) &&
    (packages === undefined || packages.has(packageOf(row.top_class))) &&
    (tops === undefined || tops.has(row.top_class));
};

/** A group's using nodes of the selected kinds. */
const groupCount = (
  group: TopClassGroup,
  kinds: ReadonlySet<string> | undefined,
) => {
  if (kinds === undefined) return group.references;
  let count = 0;
  for (const [kind, n] of group.kinds) if (kinds.has(kind)) count += n;
  return count;
};

/** One page of distinct top classes, counted by the selected kinds. */
const topClassesPage = (
  trace: Trace,
  view: Extract<ReferencesView, { facet: "top-classes" }>,
  owner: ByteBoundedPageOwner,
) => {
  const { kinds, packages, tops } = filtersOf(view);
  const filtered =
    kinds !== undefined || packages !== undefined || tops !== undefined;
  const page = selectByteBoundedViewRows(
    topClassGroups(trace),
    view,
    {
      matches: filtered
        ? (group) =>
            (packages === undefined || packages.has(group.package)) &&
            (tops === undefined || tops.has(group.top_class)) &&
            groupCount(group, kinds) > 0
        : undefined,
      project: (group) => ({
        top_class: group.top_class,
        package: group.package,
        references: groupCount(group, kinds),
      }),
    },
    owner,
  );
  return page.ok
    ? ok({
        facet: "top-classes" as const,
        view,
        items: page.value.rows,
        byte_limited: page.value.byte_limited,
        total: page.value.total,
      })
    : page;
};

/** One page of using nodes with only the selected fields. */
const referencesPage = (
  references: readonly Reference[],
  view: Extract<ReferencesView, { facet: "references" }>,
  owner: ByteBoundedPageOwner,
) => {
  const fields = filterSet(view.fields);
  const page = selectByteBoundedViewRows(
    references,
    view,
    {
      matches: matcher(view),
      project: (row, index): z.output<typeof androidReferenceRowSchema> => ({
        index,
        ...(fields === undefined ? row : pickFields(row, fields)),
      }),
    },
    owner,
  );
  return page.ok
    ? ok({
        facet: "references" as const,
        view,
        items: page.value.rows,
        byte_limited: page.value.byte_limited,
        total: page.value.total,
      })
    : page;
};

/** Project a retained reference trace's summary, using nodes or top classes. */
export const projectAndroidReferencesView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  if (admitted.kind !== "android-references" && admitted.kind !== "summary")
    return invalidAnalysisView(
      "Select an android-references or summary view.",
      "kind",
    );
  assertOwnedView<SummaryAnalysisView | ReferencesView>(
    admitted,
    "summary",
    "android-references",
  );
  const parsed = readTrace(parent);
  if (!parsed.ok) return parsed;
  // The engine digest identifies the JAR, never the APK subject.
  const subject = evidenceSubjectTarget(parent.subject);
  if (subject === undefined)
    return invalidAnalysisViewSubject(
      "Android reference views require the recorded APK subject identity.",
    );
  const trace = parsed.value;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: TRACE_ANDROID_REFERENCES_OPERATION,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: subject.path, sha256: subject.sha256 },
    limitations: boundedViewLimitations(parent),
    unknowns: [
      "Static using nodes do not establish runtime calls, reflection or dynamic dispatch.",
    ],
  };
  if (admitted.kind === "summary")
    return ok({
      ...shared,
      kind: "summary" as const,
      view: admitted,
      summary: summarize(trace),
      coverage: completeWithinViewCoverage(1),
    });
  const view = admitted;
  const { references, engine: _engine, ...target } = trace;
  const context = {
    ...shared,
    kind: "android-references" as const,
    view,
    target,
  };
  const owner = {
    parentEvidenceId: parent.evidenceId,
    envelope: {
      ...context,
      facet: view.facet,
      items: [],
      byte_limited: false,
      coverage: PLACEHOLDER_COVERAGE,
    } as unknown as JsonValue,
    facet: view.facet,
  };
  const page =
    view.facet === "top-classes"
      ? topClassesPage(trace, view, owner)
      : referencesPage(references, view, owner);
  if (!page.ok) return page;
  const { total, ...rows } = page.value;
  return ok({
    ...context,
    ...rows,
    coverage: pageViewCoverage(view.offset, rows.items.length, total),
  });
};
