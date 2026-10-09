import {
  AnalysisInputError,
  type AnalysisInputIssue,
} from "../analysisErrorCore.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { uniqueSorted } from "../canonicalOrdering.js";
import type { BinaryLayout } from "../native/binaryLayout.js";
import { err, ok, type Result } from "../result.js";
import type {
  AnalysisViewCoverage,
  AnalysisViewParent,
  AnalysisViewRequest,
  UnsignedAnalysisView,
} from "./analysisView.js";

const OPERATION = "inspect_analysis_view";

type LayoutName = BinaryLayout["sections"][number]["name"];

const inputError = (
  issues: readonly AnalysisInputIssue[],
): AnalysisInputError => new AnalysisInputError(OPERATION, undefined, issues);

const completeCoverage = (
  examined: number,
  total: number,
): AnalysisViewCoverage => ({
  status: "complete-within-view",
  examined,
  total,
  next_offset: null,
  exhausted: true,
});

const pageCoverage = (
  offset: number,
  examined: number,
  total: number,
): AnalysisViewCoverage => {
  const exhausted = offset >= total || offset + examined >= total;
  return {
    status: examined === 0 ? "empty" : "page",
    examined,
    total,
    next_offset: exhausted ? null : offset + examined,
    exhausted,
  };
};

const layoutUnknowns = (layout: BinaryLayout): readonly string[] => {
  const unknowns = [
    "runtime_load_base is unknown",
    "entry_point.execution_status is unknown",
    "relocation_inventory_completeness is unknown",
    "linkage.convenience_maps_completeness is unknown",
    "linkage.runtime_library_paths are unknown",
  ];
  if (layout.mitigations.nx_indicator === null)
    unknowns.push("mitigations.nx_indicator is unknown");
  if (layout.mitigations.relro === null)
    unknowns.push("mitigations.relro is unknown");
  return unknowns;
};

const displayName = (name: LayoutName): string => name.display;

const namedMatches = <Row extends { readonly name: LayoutName }>(
  rows: readonly Row[],
  name: string,
): readonly { readonly index: number; readonly row: Row }[] =>
  rows.flatMap((row, index) =>
    displayName(row.name) === name ? [{ index, row }] : [],
  );

const selectNamed = <Row extends { readonly name: LayoutName }>(
  collection: "sections" | "symbols",
  rows: readonly Row[],
  name: string,
): Result<Row, AnalysisError> => {
  const matches = namedMatches(rows, name);
  if (matches.length === 1) {
    const selected = matches[0];
    if (selected !== undefined) return ok(selected.row);
  }
  if (matches.length === 0)
    return err(
      inputError([
        {
          path: ["view", "selector", "name"],
          reason: "invalid_value",
          message: `No ${collection} named ${JSON.stringify(name)}. Collection has ${String(rows.length)} entries.`,
          expected: [
            ...new Set(rows.map((row) => displayName(row.name))),
          ].slice(0, 32),
        },
      ]),
    );
  return err(
    inputError([
      {
        path: ["view", "selector", "name"],
        reason: "invalid_value",
        message: `Multiple ${collection} named ${JSON.stringify(name)}; select one by index.`,
        expected: matches.map(({ index }) => ({ index })),
      },
    ]),
  );
};

const selectIndexed = <Row>(
  collection: "sections" | "symbols",
  rows: readonly Row[],
  index: number,
): Result<Row, AnalysisError> => {
  const row = rows[index];
  if (row !== undefined) return ok(row);
  return err(
    inputError([
      {
        path: ["view", "selector", "index"],
        reason: "out_of_range",
        message: `${collection} index ${String(index)} is outside 0..${String(Math.max(0, rows.length - 1))} (${String(rows.length)} entries).`,
        minimum: 0,
        maximum: Math.max(0, rows.length - 1),
      },
    ]),
  );
};

const pageRows = <Row>(
  rows: readonly Row[],
  offset: number,
  limit: number,
): readonly Row[] => rows.slice(offset, offset + limit);

const layoutIncompatible = (detail: string): AnalysisError =>
  inputError([
    {
      path: ["view"],
      reason: "invalid_value",
      message: detail,
    },
  ]);

const parentFields = (parent: AnalysisViewParent, layout: BinaryLayout) => ({
  parent_evidence_id: parent.evidenceId,
  parent_operation: "inspect_binary_layout" as const,
  parent_digest: parent.evidenceId.slice(3),
  artifact: {
    path: layout.artifact.path,
    sha256: layout.artifact.sha256,
  },
  limitations: uniqueSorted([...parent.limitations, ...layout.limitations]),
  unknowns: uniqueSorted([...layoutUnknowns(layout)]),
});

const layoutSummary = (layout: BinaryLayout) => ({
  bytes: layout.artifact.bytes,
  format: layout.format,
  architecture: layout.architecture,
  image_type: layout.image_type,
  entry: layout.entry_point,
  counts: {
    sections: layout.sections.length,
    segments: layout.segments.length,
    symbols: layout.symbols.length,
    relocations: layout.relocations.length,
  },
  limitation_count: layout.limitations.length,
});

/** Project one layout view without re-running the decoder. */
export const projectBinaryLayoutView = (
  parent: AnalysisViewParent,
  layout: BinaryLayout,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  const shared = parentFields(parent, layout);
  if (view.kind === "summary")
    return ok({
      kind: "summary",
      view,
      summary: layoutSummary(layout),
      coverage: completeCoverage(
        layout.sections.length +
          layout.segments.length +
          layout.symbols.length +
          layout.relocations.length,
        layout.sections.length +
          layout.segments.length +
          layout.symbols.length +
          layout.relocations.length,
      ),
      ...shared,
    });
  if (view.kind === "facet")
    return ok({
      kind: "facet",
      view,
      facet: view.facet === "mitigations" ? layout.mitigations : layout.linkage,
      coverage: completeCoverage(1, 1),
      ...shared,
    });
  if (view.kind === "item") {
    if (view.collection === "modules")
      return err(
        layoutIncompatible(
          "modules collection applies to analyze_javascript_application Evidence.",
        ),
      );
    const selected =
      view.collection === "sections"
        ? selectLayoutItem(view.collection, layout.sections, view.selector)
        : selectLayoutItem(view.collection, layout.symbols, view.selector);
    if (!selected.ok) return selected;
    return ok({
      kind: "item",
      view,
      item: selected.value,
      coverage: completeCoverage(
        1,
        view.collection === "sections"
          ? layout.sections.length
          : layout.symbols.length,
      ),
      ...shared,
    });
  }
  if (view.collection === "modules")
    return err(
      layoutIncompatible(
        "modules collection applies to analyze_javascript_application Evidence.",
      ),
    );
  const rows =
    view.collection === "sections" ? layout.sections : layout.symbols;
  const items =
    view.collection === "sections"
      ? pageRows(layout.sections, view.offset, view.limit)
      : pageRows(layout.symbols, view.offset, view.limit);
  return ok({
    kind: "page",
    view,
    items: [...items],
    coverage: pageCoverage(view.offset, items.length, rows.length),
    ...shared,
  });
};

const selectLayoutItem = <Row extends { readonly name: LayoutName }>(
  collection: "sections" | "symbols",
  rows: readonly Row[],
  selector: Extract<AnalysisViewRequest, { readonly kind: "item" }>["selector"],
): Result<Row, AnalysisError> => {
  if ("index" in selector)
    return selectIndexed(collection, rows, selector.index);
  if ("name" in selector) return selectNamed(collection, rows, selector.name);
  return err(
    layoutIncompatible(
      "Section and symbol items are selected by index or exact name.",
    ),
  );
};
