import { z } from "zod";
import {
  webSourceLocationResultSchema,
  webSourceMapMatchSchema,
} from "../webSourceLocation.js";
import {
  MAX_SOURCE_MAP_ENCODED_BYTES,
  sourceMapLimitsSchema,
} from "../sourceMapLimits.js";
import { jsonValueByteLength } from "../jsonValueByteLength.js";
import type { JsonValue } from "../jsonValue.js";
import { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import { err, ok } from "../result.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  ownedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import {
  boundedViewMessages,
  pageViewCoverage,
  unavailableViewCoverage,
} from "./analysisViewCoverage.js";
import { analysisTextPage } from "./analysisViewText.js";

const DEFAULT_PAGE_BYTES = 1024 * 1024;
const DEFAULT_MATCH_LIMIT = 64;
const DEFAULT_TEXT_LIMIT = 1024;
const viewByteSchema = sourceMapLimitsSchema.shape.output_bytes.unwrap();
const page = {
  kind: z.literal("source-location"),
  offset: z.int().nonnegative().default(0),
  max_bytes: viewByteSchema
    .default(DEFAULT_PAGE_BYTES)
    .describe(
      `Serialized selected-view byte allowance; default ${String(DEFAULT_PAGE_BYTES)}. Independent of complete Evidence and MCP delivery limits.`,
    ),
};
export const webSourceLocationViewRequestSchema = z.discriminatedUnion(
  "collection",
  [
    z.strictObject({
      ...page,
      collection: z.literal("matches"),
      limit: z.int().positive().default(DEFAULT_MATCH_LIMIT),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("source-text"),
      match_index: z.int().nonnegative(),
      limit: z.int().positive().default(DEFAULT_TEXT_LIMIT),
    }),
  ],
);
const generated = webSourceMapMatchSchema.options[0];
const mapped = webSourceMapMatchSchema.options[1];
const content = z.discriminatedUnion("state", [
  mapped.shape.content.options[0]
    .omit({ text: true })
    .extend({ code_units: z.int().nonnegative() }),
  mapped.shape.content.options[1],
]);
export const webSourceLocationMatchViewSchema = z.discriminatedUnion("state", [
  generated.extend({ match_index: z.int().nonnegative() }),
  mapped
    .omit({ content: true })
    .extend({ match_index: z.int().nonnegative(), content }),
]);
export const webSourceLocationContextSchema = webSourceLocationResultSchema
  .omit({ matches: true, limitations: true, diagnostics: true })
  .extend({
    match_count: z.int().nonnegative(),
    diagnostic_count: z.int().nonnegative(),
  });
export const webSourceLocationSummarySchema =
  webSourceLocationContextSchema.extend({
    matches: z.array(webSourceLocationMatchViewSchema),
  });
export const webSourceLocationCompleteDeliveryShape = {
  detail: z.literal("complete").optional().default("complete"),
  view: z.never().exactOptional(),
};
export const webSourceLocationSummaryDeliveryShape = {
  detail: z.literal("summary"),
  view: webSourceLocationViewRequestSchema.exactOptional(),
};
export const webSourceLocationDeliverySchema = z.discriminatedUnion("detail", [
  z.strictObject(webSourceLocationCompleteDeliveryShape),
  z.strictObject(webSourceLocationSummaryDeliveryShape),
]);
const readReport = createAnalysisViewResultReader(
  webSourceLocationResultSchema,
);
type Match = z.output<typeof webSourceMapMatchSchema>;
const metadata = (
  match: Match,
  match_index: number,
): z.output<typeof webSourceLocationMatchViewSchema> => {
  if (match.state === "generated-only") return { ...match, match_index };
  const { content: sourceContent, ...mappedMatch } = match;
  if (sourceContent.state === "unavailable")
    return { ...mappedMatch, match_index, content: sourceContent };
  const { text, ...identity } = sourceContent;
  return {
    ...mappedMatch,
    match_index,
    content: { ...identity, code_units: text.length },
  };
};
const tooLarge = (maxBytes: number, parentEvidenceId: string) =>
  err(
    new AnalysisResourceConstraintError(
      "inspect_analysis_view",
      "memory",
      "The selected source-location view exceeds its byte allowance.",
      {
        max_bytes: maxBytes,
        evidence_reference: {
          kind: "retained-evidence",
          evidence_id: parentEvidenceId,
        },
      },
      {
        remediationAction:
          maxBytes < MAX_SOURCE_MAP_ENCODED_BYTES
            ? `Select a smaller source-location limit or increase view.max_bytes (maximum ${String(MAX_SOURCE_MAP_ENCODED_BYTES)}) and retry this retained parent. A single metadata row may require a larger allowance; complete Evidence remains available for export.`
            : "view.max_bytes is already at its supported maximum. Select a smaller source-location limit or export complete parent Evidence; a single metadata row that cannot fit requires export.",
      },
    ),
  );
const withinBudget = (value: unknown, maxBytes: number) =>
  jsonValueByteLength(
    { ...(value as Record<string, JsonValue>), view_digest: "0".repeat(64) },
    maxBytes,
  ) <= maxBytes;

type Report = z.output<typeof webSourceLocationResultSchema>;
type LocationView = z.output<typeof webSourceLocationViewRequestSchema>;
const viewContext = (parent: AnalysisViewParent, report: Report) => {
  const { matches, diagnostics, limitations, ...identity } = report;
  const context = {
    ...identity,
    match_count: matches.length,
    diagnostic_count: diagnostics.length,
  };
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "trace_web_source_location" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: identity.source.path, sha256: identity.source.sha256 },
    limitations: boundedViewMessages(
      [
        ...parent.limitations,
        ...limitations,
        "Match pages preserve retained lookup alternatives; exhausting a page does not establish execution or deployment authenticity. Complete map text and diagnostics remain in parent Evidence.",
      ],
      parent.evidenceId,
      "limitations",
    ),
    unknowns: [] as string[],
  };
  return { shared, context };
};
type Context = ReturnType<typeof viewContext>;
const projectSourceText = (
  { shared, context }: Context,
  matches: readonly Match[],
  view: Extract<LocationView, { collection: "source-text" }>,
) => {
  const match = matches[view.match_index];
  if (match === undefined)
    return err(
      analysisViewInputError([
        {
          path: ["view", "match_index"],
          reason: "invalid_value",
          message: "No match exists at this original match index.",
        },
      ]),
    );
  const selected = metadata(match, view.match_index);
  if (match.state === "generated-only" || match.content.state !== "embedded") {
    const result = {
      ...shared,
      kind: "source-location-text" as const,
      view,
      source_location: context,
      match: selected,
      item: null,
      coverage: unavailableViewCoverage(),
    };
    return withinBudget(result, view.max_bytes)
      ? ok(result)
      : tooLarge(view.max_bytes, shared.parent_evidence_id);
  }
  const selectedUnits = Math.min(
    view.limit,
    Math.max(0, match.content.text.length - view.offset),
  );
  // Each retained UTF-16 unit needs at least one JSON byte. Refuse before copying a huge selected range; exact escaping is checked below.
  if (selectedUnits + 2 > view.max_bytes)
    return tooLarge(view.max_bytes, shared.parent_evidence_id);
  // Text is already bounded and retained by the parent admission. Check serialized expansion before Evidence cloning/encoding.
  const text = analysisTextPage(
    match.content.text,
    view.offset,
    view.limit,
    "Source text",
  );
  if (!text.ok) return text;
  const result = {
    ...shared,
    kind: "source-location-text" as const,
    view,
    source_location: context,
    match: selected,
    ...text.value,
  };
  return withinBudget(result, view.max_bytes)
    ? ok(result)
    : tooLarge(view.max_bytes, shared.parent_evidence_id);
};
const projectMatches = (
  { shared, context }: Context,
  matches: readonly Match[],
  view: SummaryAnalysisView | Extract<LocationView, { collection: "matches" }>,
) => {
  const offset = view.kind === "summary" ? 0 : view.offset;
  const limit = view.kind === "summary" ? DEFAULT_MATCH_LIMIT : view.limit;
  const maxBytes =
    view.kind === "summary" ? DEFAULT_PAGE_BYTES : view.max_bytes;
  const items: z.output<typeof webSourceLocationMatchViewSchema>[] = [];
  const common = {
    ...shared,
    coverage: pageViewCoverage(offset, 0, matches.length),
  };
  const build = () =>
    view.kind === "summary"
      ? {
          ...common,
          view,
          kind: "summary" as const,
          summary: { ...context, matches: items },
        }
      : {
          ...common,
          view,
          kind: "source-location" as const,
          source_location: context,
          items,
        };
  const base = build();
  // Reserve maximum numeric coverage widths once; row admission remains linear in returned rows.
  let bytes = jsonValueByteLength(
    {
      ...base,
      view_digest: "0".repeat(64),
      coverage: {
        ...common.coverage,
        examined: Number.MAX_SAFE_INTEGER,
        next_offset: Number.MAX_SAFE_INTEGER,
      },
    } as JsonValue,
    maxBytes,
  );
  if (bytes > maxBytes) return tooLarge(maxBytes, shared.parent_evidence_id);
  for (
    let index = offset;
    index < matches.length && items.length < limit;
    index++
  ) {
    const item = metadata(matches[index]!, index);
    const added =
      jsonValueByteLength(item as JsonValue, maxBytes - bytes) +
      (items.length === 0 ? 0 : 1);
    if (bytes + added > maxBytes) {
      if (items.length === 0)
        return tooLarge(maxBytes, shared.parent_evidence_id);
      break;
    }
    items.push(item);
    bytes += added;
  }
  common.coverage = pageViewCoverage(offset, items.length, matches.length);
  return ok(build());
};
/** Query authenticated source-location facts without reopening any selected artifact. */
export const projectWebSourceLocationView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const view = ownedView<
    SummaryAnalysisView | z.output<typeof webSourceLocationViewRequestSchema>
  >(admitted, "summary", "source-location");
  if (view === undefined)
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Source-location Evidence supports summary and source-location views.",
        },
      ]),
    );
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const context = viewContext(parent, parsed.value);
  return view.kind !== "summary" && view.collection === "source-text"
    ? projectSourceText(context, parsed.value.matches, view)
    : projectMatches(context, parsed.value.matches, view);
};
