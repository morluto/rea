import { z } from "zod";
import {
  committedProviderSchema,
  type CommittedProviderIdentity,
} from "../analysisProfile.js";
import { digestSchema } from "../digests.js";
import { providerSchema } from "../evidence.js";
import {
  batchDecompileResultSchema,
  batchItemLimitationsSchema,
  batchProcedureIdentitySchema,
  type BatchDecompileItem,
  type BatchDecompileResult,
} from "../native/batchDecompile.js";
import { analysisErrorProjectionSchema } from "../../contracts/errorSchemas.js";
import { err, ok } from "../result.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  ownedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import {
  analysisTextPage,
  analysisTextPageItemSchema,
} from "./analysisViewText.js";
import { selectViewRows } from "./selectViewRows.js";

const OPERATION = "batch_decompile" as const;

const offset = z.int().nonnegative().default(0);

const itemsRequestSchema = z.strictObject({
  kind: z.literal("batch-decompile"),
  collection: z.literal("items"),
  offset,
  limit: z.int().positive().default(64),
  where: z
    .strictObject({
      indices: z
        .array(z.int().nonnegative())
        .optional()
        .describe(
          "Exact zero-based positions in the original batch, which keep duplicate selectors distinct. Omitted selects all; [] selects none.",
        ),
      addresses: z
        .array(z.string())
        .optional()
        .describe(
          "Exact caller-selected symbols or addresses as submitted. Omitted selects all; [] selects none.",
        ),
      procedure_addresses: z
        .array(z.string())
        .optional()
        .describe(
          "Exact observed canonical entries. An item with unknown procedure identity never matches. Omitted selects all; [] selects none.",
        ),
      statuses: z
        .array(z.enum(["ok", "error"]))
        .optional()
        .describe("Item outcomes. Omitted selects all; [] selects none."),
    })
    .default({}),
  include_pseudocode: z
    .boolean()
    .default(false)
    .describe(
      "Opt into each selected successful item's complete pseudocode. Otherwise rows report pseudocode_code_units only.",
    ),
});

const pseudocodeRequestSchema = z.strictObject({
  kind: z.literal("batch-decompile"),
  collection: z.literal("pseudocode"),
  index: z.int().nonnegative().describe("Exact item position from a row."),
  offset: offset.describe("UTF-16 code-unit offset into this item's text."),
  limit: z
    .int()
    .positive()
    .default(16_384)
    .describe(
      "UTF-16 code units in this page. A page size only: coverage reports the complete body and the next offset.",
    ),
});

/** Select rows of a completed batch or page one retained pseudocode body. */
export const batchDecompileViewRequestSchema = z.discriminatedUnion(
  "collection",
  [itemsRequestSchema, pseudocodeRequestSchema],
);

type BatchDecompileViewRequest = z.output<
  typeof batchDecompileViewRequestSchema
>;

const itemIdentity = {
  index: z.int().nonnegative().describe("Position in the original batch."),
  address: z.string().describe("Original caller-selected symbol or address."),
  procedure: batchProcedureIdentitySchema,
};

const batchDecompileRowSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...itemIdentity,
    status: z.literal("ok"),
    pseudocode_code_units: z.int().positive(),
    pseudocode: z.string().min(1).exactOptional(),
  }),
  z.strictObject({
    ...itemIdentity,
    status: z.literal("error"),
    error: analysisErrorProjectionSchema,
    limitations: batchItemLimitationsSchema,
  }),
]);

/**
 * Producer counts and identities repeated with every view, so one selected row
 * stays traceable to its batch and to the provider that decompiled it.
 */
export const batchDecompileViewContextSchema = z.strictObject({
  batch: z.strictObject({
    total: z.int().nonnegative(),
    succeeded: z.int().nonnegative(),
    failed: z.int().nonnegative(),
  }),
  source_provider: providerSchema.nullable(),
  source_analysis_profile_digest: digestSchema.nullable(),
  decompiling_provider: committedProviderSchema
    .nullable()
    .describe(
      "Provider committed by the batch's upstream analysis profile, or null when the parent records none.",
    ),
});

/** Summary context adds the facts an analyst needs to choose what to read. */
export const batchDecompileSummarySchema =
  batchDecompileViewContextSchema.extend({
    procedures: z.strictObject({
      distinct_resolved: z.int().nonnegative(),
      unknown_identity: z.int().nonnegative(),
      label_unavailable: z
        .int()
        .nonnegative()
        .describe(
          "Resolved items whose entry label is null, whether the provider had none or its lookup failed.",
        ),
    }),
    pseudocode: z.strictObject({
      code_units: z.int().nonnegative(),
      largest: z
        .strictObject({
          index: z.int().nonnegative(),
          code_units: z.int().positive(),
        })
        .nullable(),
    }),
    limitation_count: z.int().nonnegative(),
  });

/** Each collection's request bound to its own rows, so a reply cannot mix them. */
export const batchDecompileViewCollections = {
  items: {
    request: itemsRequestSchema,
    rows: z.array(batchDecompileRowSchema),
  },
  pseudocode: {
    request: pseudocodeRequestSchema,
    item: z.strictObject({
      ...itemIdentity,
      ...analysisTextPageItemSchema.shape,
      pseudocode_code_units: z.int().positive(),
    }),
  },
} as const;

const checkedBatch = createAnalysisViewResultReader(batchDecompileResultSchema);

const upstreamProfileSchema = z.object({
  upstream_analysis_profile: z.object({ provider: committedProviderSchema }),
});

/** A composed batch's Evidence provider is the workflow; its profile names the decompiler. */
const decompilingProvider = (
  parent: AnalysisViewParent,
): CommittedProviderIdentity | null => {
  const parsed = upstreamProfileSchema.safeParse(
    parent.analysisProfile?.parameters,
  );
  return parsed.success ? parsed.data.upstream_analysis_profile.provider : null;
};

const batchContext = (
  parent: AnalysisViewParent,
  { total, succeeded, failed }: BatchDecompileResult,
) => ({
  batch: { total, succeeded, failed },
  source_provider: parent.provider ?? null,
  source_analysis_profile_digest: parent.analysisProfile?.digest ?? null,
  decompiling_provider: decompilingProvider(parent),
});

const summarizeBatch = (items: readonly BatchDecompileItem[]) => {
  const resolved = new Set<string>();
  let unknownIdentity = 0;
  let labelUnavailable = 0;
  let codeUnits = 0;
  let largest: { index: number; code_units: number } | null = null;
  for (const [index, item] of items.entries()) {
    if (item.procedure.status === "unknown") unknownIdentity++;
    else {
      resolved.add(item.procedure.address);
      // Null covers an answer without a label and a failed label lookup alike.
      if (item.procedure.name === null) labelUnavailable++;
    }
    if (item.status !== "ok") continue;
    codeUnits += item.pseudocode.length;
    if (largest === null || item.pseudocode.length > largest.code_units)
      largest = { index, code_units: item.pseudocode.length };
  }
  return {
    procedures: {
      distinct_resolved: resolved.size,
      unknown_identity: unknownIdentity,
      label_unavailable: labelUnavailable,
    },
    pseudocode: { code_units: codeUnits, largest },
  };
};

const batchUnknowns = (items: readonly BatchDecompileItem[]): string[] => {
  const unknownIdentity = items.filter(
    ({ procedure }) => procedure.status === "unknown",
  ).length;
  return [
    ...(unknownIdentity === 0
      ? []
      : [
          `${String(unknownIdentity)} items have unknown procedure identity; their address is the caller's selector, not an observed entry.`,
        ]),
    "Evidence limitations aggregate every item's provider observations and are not attributed to one successful item. A batch covers only its selected procedures, and exhausting a page establishes nothing outside it.",
  ];
};

const selected = <Value>(values: readonly Value[] | undefined) =>
  values === undefined ? undefined : new Set(values);

const itemRow = (
  item: BatchDecompileItem,
  index: number,
  includePseudocode: boolean,
): z.output<typeof batchDecompileRowSchema> => {
  const identity = {
    index,
    address: item.address,
    procedure: item.procedure,
  };
  if (item.status === "ok")
    return {
      ...identity,
      status: "ok",
      pseudocode_code_units: item.pseudocode.length,
      ...(includePseudocode ? { pseudocode: item.pseudocode } : {}),
    };
  return {
    ...identity,
    status: "error",
    error: item.error,
    ...(item.limitations === undefined
      ? {}
      : { limitations: item.limitations }),
  };
};

const pseudocodeRefusal = (message: string) =>
  err(
    analysisViewInputError([
      { path: ["view", "index"], reason: "invalid_value", message },
    ]),
  );

/** Select retained batch facts without repeating decompilation or changing its record. */
export const projectBatchDecompileView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const view = ownedView<SummaryAnalysisView | BatchDecompileViewRequest>(
    admitted,
    "summary",
    "batch-decompile",
  );
  if (view === undefined)
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "batch_decompile Evidence supports summary and batch-decompile views of items or pseudocode.",
        },
      ]),
    );
  const parsed = checkedBatch(parent);
  if (!parsed.ok) return parsed;
  const batch = parsed.value;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: OPERATION,
    parent_digest: parent.evidenceId.slice(3),
    artifact: parent.artifact ?? null,
    limitations: boundedViewMessages(
      parent.limitations,
      parent.evidenceId,
      "limitations",
    ),
    unknowns: boundedViewMessages(
      [],
      parent.evidenceId,
      "unknowns",
      batchUnknowns(batch.items),
    ),
  };
  const context = batchContext(parent, batch);
  if (view.kind === "summary")
    return ok({
      kind: "summary" as const,
      view,
      ...shared,
      summary: {
        ...context,
        ...summarizeBatch(batch.items),
        limitation_count: new Set(parent.limitations).size,
      },
      coverage: completeWithinViewCoverage(1, 1),
    });
  if (view.collection === "items") {
    const indices = selected(view.where.indices);
    const addresses = selected(view.where.addresses);
    const entries = selected(view.where.procedure_addresses);
    const statuses = selected<string>(view.where.statuses);
    const { rows, total } = selectViewRows(
      batch.items,
      view,
      (item, index) =>
        (indices === undefined || indices.has(index)) &&
        (addresses === undefined || addresses.has(item.address)) &&
        (statuses === undefined || statuses.has(item.status)) &&
        (entries === undefined ||
          (item.procedure.status === "resolved" &&
            entries.has(item.procedure.address))),
      (item, index) => itemRow(item, index, view.include_pseudocode),
    );
    return ok({
      kind: "batch-decompile" as const,
      view,
      ...shared,
      ...context,
      items: rows,
      coverage: pageViewCoverage(view.offset, rows.length, total),
    });
  }
  const item = batch.items[view.index];
  if (item === undefined)
    return pseudocodeRefusal(
      `Item ${String(view.index)} is outside this batch of ${String(batch.items.length)}.`,
    );
  if (item.status !== "ok")
    return pseudocodeRefusal(
      `Item ${String(view.index)} has status error and no pseudocode; read its error and limitations through the items collection.`,
    );
  const page = analysisTextPage(item.pseudocode, view.offset, view.limit);
  if (!page.ok) return page;
  return ok({
    kind: "batch-decompile" as const,
    view,
    ...shared,
    ...context,
    item: {
      index: view.index,
      address: item.address,
      procedure: item.procedure,
      pseudocode_code_units: item.pseudocode.length,
      ...page.value.item,
    },
    coverage: page.value.coverage,
  });
};

const deliveredPageSchema = z.looseObject({
  view: batchDecompileViewRequestSchema,
  items: z
    .array(z.looseObject({ index: z.int(), status: z.string() }))
    .optional(),
});

/**
 * The next selection when a delivered page did not fit: fewer rows, then one
 * body's text pages, which need no export. Other views are refused by kind
 * first, because delivery asks about every view it returns.
 */
export const smallerBatchDecompileSelection = (
  delivered: unknown,
): z.input<typeof batchDecompileViewRequestSchema> | undefined => {
  if (
    typeof delivered !== "object" ||
    delivered === null ||
    !("kind" in delivered) ||
    delivered.kind !== "batch-decompile"
  )
    return undefined;
  const page = deliveredPageSchema.safeParse(delivered);
  if (!page.success) return undefined;
  const { view, items = [] } = page.data;
  if (view.collection === "pseudocode")
    return view.limit > 1
      ? { ...view, limit: Math.floor(view.limit / 2) }
      : undefined;
  if (items.length > 1) return { ...view, limit: Math.floor(items.length / 2) };
  const [row] = items;
  return row?.status === "ok" && view.include_pseudocode
    ? { kind: view.kind, collection: "pseudocode", index: row.index }
    : undefined;
};
