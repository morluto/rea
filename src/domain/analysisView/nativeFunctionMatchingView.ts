import { z } from "zod";
import {
  nativeFunctionMatchingSchema,
  nativeFunctionMatchSchema,
  nativeFunctionMatchMemberSchema,
  nativeFunctionByteSourceSchema,
  nativeFunctionByteSourceGuidance,
  nativeMatchStateSchema,
  type NativeFunctionMatching,
} from "../native/functionMatching.js";
import { isImmutableJsonSnapshot } from "../immutableJson.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import { err, ok, type Result } from "../result.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  ownedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import type { JsonValue } from "../jsonValue.js";
import { jsonValueByteLength } from "../jsonValueByteLength.js";
import { AnalysisResourceConstraintError } from "../analysisErrorCore.js";

const matchRow = nativeFunctionMatchSchema.extend({
  left_count: z.number().int().nonnegative(),
  right_count: z.number().int().nonnegative(),
});
const functionRow = nativeFunctionMatchMemberSchema.extend({
  match_id: nativeFunctionMatchSchema.shape.match_id,
  state: nativeMatchStateSchema,
  side: z.enum(["left", "right"]),
});
const page = {
  kind: z.literal("function-matches"),
  states: z.array(nativeMatchStateSchema).optional(),
  match_ids: z.array(z.string()).optional(),
  function_ids: z.array(z.string()).optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(64),
};
export const nativeFunctionMatchingViewRequestSchema = z.discriminatedUnion(
  "collection",
  [
    z.strictObject({
      ...page,
      collection: z.literal("matches"),
      fields: z.array(matchRow.keyof()).optional(),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("functions"),
      sides: z.array(z.enum(["left", "right"])).optional(),
      names: z.array(z.string()).optional(),
      fields: z.array(functionRow.keyof()).optional(),
    }),
    z.strictObject({
      kind: z.literal("function-matches"),
      collection: z.literal("byte-sources"),
      sides: z.array(z.enum(["left", "right"])).optional(),
      evidence_ids: z.array(z.string()).optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().positive().default(64),
    }),
  ],
);
export const nativeFunctionMatchingViewItemsSchema = z.union([
  z.array(nativeFunctionByteSourceSchema),
  z.array(
    matchRow.partial().required({
      match_id: true,
      state: true,
      left_count: true,
      right_count: true,
    }),
  ),
  z.array(
    functionRow.partial().required({
      function_id: true,
      match_id: true,
      state: true,
      side: true,
      inventory_evidence_id: true,
      source_index: true,
      address: true,
      evidence_links: true,
    }),
  ),
]);
interface FunctionRow {
  readonly member: NativeFunctionMatching["matches"][number]["left"][number];
  readonly match_id: string;
  readonly state: NativeFunctionMatching["matches"][number]["state"];
  readonly side: "left" | "right";
}
interface Checked {
  readonly report: NativeFunctionMatching;
  functions?: readonly FunctionRow[];
  recent?: { readonly key: string; readonly rows: readonly number[] };
}
const checked = new WeakMap<object, Checked>();
const readReport = createAnalysisViewResultReader(nativeFunctionMatchingSchema);
// Leave room for the Evidence envelope and duplicated MCP text/structured output.
const BYTE_SOURCE_PAGE_BYTES = 1024 * 1024;
const BYTE_SOURCE_PROJECTION_BYTES =
  BYTE_SOURCE_PAGE_BYTES -
  (jsonValueByteLength({ view_digest: "0".repeat(64) }) - 1);

type Request = z.output<typeof nativeFunctionMatchingViewRequestSchema>;
type MatchRequest = Exclude<Request, { collection: "byte-sources" }>;
const checkedReport = (
  parent: AnalysisViewParent,
): Result<Checked, AnalysisError> => {
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const cached = checked.get(report);
  if (cached !== undefined) return ok(cached);
  const entry: Checked = { report };
  if (isImmutableJsonSnapshot(report)) checked.set(report, entry);
  return ok(entry);
};
const functionRows = (entry: Checked): readonly FunctionRow[] => {
  if (entry.functions !== undefined) return entry.functions;
  const functions: FunctionRow[] = [];
  for (const match of entry.report.matches)
    for (const side of ["left", "right"] as const)
      for (const member of match[side])
        functions.push({
          member,
          match_id: match.match_id,
          state: match.state,
          side,
        });
  entry.functions = functions;
  return functions;
};
const sharedContext = (
  parent: AnalysisViewParent,
  report: NativeFunctionMatching,
) => ({
  parent_evidence_id: parent.evidenceId,
  parent_operation: "match_native_functions" as const,
  parent_digest: parent.evidenceId.slice(3),
  artifact: null,
  limitations: boundedViewMessages(
    [...parent.limitations, ...report.limitations],
    parent.evidenceId,
    "limitations",
    report.byte_sources_count ? [nativeFunctionByteSourceGuidance] : [],
  ),
  unknowns: [
    "Unpaired observations and page exhaustion do not establish binary-wide function absence or behavioral equivalence.",
  ],
});
const selected = (values: readonly string[] | undefined) =>
  values === undefined ? undefined : new Set(values);
const filterRows = (entry: Checked, view: MatchRequest): readonly number[] => {
  const key = JSON.stringify([
    view.collection,
    view.states,
    view.match_ids,
    view.function_ids,
    view.collection === "functions" ? view.sides : null,
    view.collection === "functions" ? view.names : null,
  ]);
  if (entry.recent?.key === key) return entry.recent.rows;
  const states = selected(view.states),
    ids = selected(view.match_ids),
    functions = selected(view.function_ids),
    sides = selected(view.collection === "functions" ? view.sides : undefined),
    names = selected(view.collection === "functions" ? view.names : undefined);
  const matchesIdentity = (row: { state: string; match_id: string }): boolean =>
    (states === undefined || states.has(row.state)) &&
    (ids === undefined || ids.has(row.match_id));
  const rows: number[] = [];
  if (view.collection === "matches")
    entry.report.matches.forEach((row, index) => {
      if (
        matchesIdentity(row) &&
        (functions === undefined ||
          [...row.left, ...row.right].some((member) =>
            functions.has(member.function_id),
          ))
      )
        rows.push(index);
    });
  else
    functionRows(entry).forEach((row, index) => {
      if (
        matchesIdentity(row) &&
        (functions === undefined || functions.has(row.member.function_id)) &&
        (sides === undefined || sides.has(row.side)) &&
        (names === undefined || names.has(row.member.name))
      )
        rows.push(index);
    });
  // One recent selector and at most one row index per source occurrence.
  const count = entry.report.left.functions + entry.report.right.functions;
  if (key.length <= Math.max(256, count * 8)) entry.recent = { key, rows };
  return rows;
};
const selectedItems = (
  entry: Checked,
  view: MatchRequest,
  rows: readonly number[],
) => {
  const indices = rows.slice(view.offset, view.offset + view.limit);
  const defaults =
    view.collection === "matches"
      ? [
          "match_id",
          "state",
          "basis",
          "reason",
          "left_count",
          "right_count",
          "compare_functions_input",
        ]
      : [
          "function_id",
          "match_id",
          "state",
          "side",
          "inventory_evidence_id",
          "source_index",
          "address",
          "name",
          "body_sha256",
          "structural_candidate_sha256",
          "body_bytes",
          "dossier_evidence_id",
          "evidence_links",
        ];
  const fields = new Set<string>(view.fields ?? defaults);
  const columns = (row: Readonly<Record<string, JsonValue>>) =>
    Object.fromEntries([...fields].map((field) => [field, row[field]!]));
  if (view.collection === "matches")
    return indices.map((index) => {
      const row = entry.report.matches[index]!,
        left_count = row.left.length,
        right_count = row.right.length;
      return {
        ...columns({ ...row, left_count, right_count }),
        match_id: row.match_id,
        state: row.state,
        left_count,
        right_count,
      };
    });
  const functions = functionRows(entry);
  return indices.map((index) => {
    const row = functions[index]!,
      member = row.member;
    return {
      ...columns({
        ...member,
        match_id: row.match_id,
        state: row.state,
        side: row.side,
      }),
      function_id: member.function_id,
      match_id: row.match_id,
      state: row.state,
      side: row.side,
      inventory_evidence_id: member.inventory_evidence_id,
      source_index: member.source_index,
      address: member.address,
      evidence_links: member.evidence_links,
    };
  });
};

/** Query immutable matching facts without copying full alias groups into selected pages. */
export const projectNativeFunctionMatchingView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const view = ownedView<
    | SummaryAnalysisView
    | z.output<typeof nativeFunctionMatchingViewRequestSchema>
  >(admitted, "summary", "function-matches");
  if (view === undefined)
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Native matching supports summary and function-matches pages",
        },
      ]),
    );
  const parsed = checkedReport(parent);
  if (!parsed.ok) return parsed;
  const entry = parsed.value;
  const {
    matches: _matches,
    limitations: _limitations,
    byte_sources: _byteSources,
    ...context
  } = entry.report;
  const shared = sharedContext(parent, entry.report);
  if (view.kind === "summary")
    return ok({
      kind: "summary" as const,
      view,
      ...shared,
      summary: context,
      coverage: completeWithinViewCoverage(1, 1),
    });
  if (view.collection === "byte-sources") {
    if (entry.report.byte_sources === undefined)
      return err(
        analysisViewInputError([
          {
            path: ["view"],
            reason: "invalid_value",
            message:
              "This historical report did not record byte-source qualifications; inspect its linked Evidence.",
          },
        ]),
      );
    const sides = selected(view.sides),
      ids = selected(view.evidence_ids);
    const items: z.output<typeof nativeFunctionByteSourceSchema>[] = [];
    const fixed = {
      kind: "function-matches" as const,
      view,
      ...shared,
      ...context,
    };
    let bytes = jsonValueByteLength(
      {
        ...fixed,
        items: [],
        byte_limited: true,
        coverage: pageViewCoverage(
          Number.MAX_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
        ),
      } as JsonValue,
      BYTE_SOURCE_PROJECTION_BYTES,
    );
    const tooLarge = (source?: { evidence_id: string; next_offset: number }) =>
      err(
        new AnalysisResourceConstraintError(
          "inspect_analysis_view",
          "transport",
          "The selected byte-source view exceeds the projection allowance.",
          {
            parent_evidence_id: parent.evidenceId,
            limit_bytes: BYTE_SOURCE_PAGE_BYTES,
            ...(source === undefined
              ? {}
              : {
                  source_evidence_id: source.evidence_id,
                  next_offset: source.next_offset,
                }),
          },
          {
            retryable: false,
            remediationAction:
              source === undefined
                ? "Narrow the selection or export the complete Evidence bundle."
                : "Retrieve the selected source Evidence by ID or export the complete Evidence bundle; use next_offset to continue after the oversized source.",
          },
        ),
      );
    if (bytes > BYTE_SOURCE_PROJECTION_BYTES) return tooLarge();
    let total = 0,
      byteLimited = false;
    for (const row of entry.report.byte_sources) {
      if (
        (sides !== undefined && !sides.has(row.side)) ||
        (ids !== undefined && !ids.has(row.evidence_id))
      )
        continue;
      if (total >= view.offset && items.length < view.limit && !byteLimited) {
        const item = row;
        const size =
          jsonValueByteLength(
            item,
            Math.max(0, BYTE_SOURCE_PROJECTION_BYTES - bytes),
          ) + 1;
        if (bytes + size > BYTE_SOURCE_PROJECTION_BYTES) {
          if (items.length === 0)
            return tooLarge({
              evidence_id: row.evidence_id,
              next_offset: total + 1,
            });
          byteLimited = true;
        } else {
          items.push(item);
          bytes += size;
        }
      }
      total++;
    }
    return ok({
      ...fixed,
      items,
      byte_limited: byteLimited,
      coverage: pageViewCoverage(view.offset, items.length, total),
    });
  }
  const rows = filterRows(entry, view),
    items = selectedItems(entry, view, rows);
  return ok({
    kind: "function-matches" as const,
    view,
    ...shared,
    ...context,
    items,
    coverage: pageViewCoverage(view.offset, items.length, rows.length),
  });
};
