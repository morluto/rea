import { z } from "zod";

import {
  artifactExtractionResultSchema,
  integrityContradictionSchema,
  type ArtifactExtractionResult,
} from "../artifactGraph.js";
import { boundedList } from "../boundedList.js";
import { prefixedDigestSchema } from "../digests.js";
import { evidenceSubjectTarget } from "../evidence.js";
import type { JsonValue } from "../jsonValue.js";
import { jsonValueByteLength } from "../jsonValueByteLength.js";
import { err, ok } from "../result.js";
import {
  PLACEHOLDER_COVERAGE,
  selectByteBoundedViewRows,
  type ByteBoundedPageOwner,
} from "./byteBoundedViewRows.js";
import {
  analysisViewInputError,
  invalidAnalysisViewSubject,
} from "./analysisViewErrors.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import {
  compileInventoryPathGlob,
  inventoryPathGlobSchema,
} from "./inventoryPathGlob.js";

export const EXTRACT_ARTIFACT_OPERATION = "extract_artifact" as const;

type Extracted = ArtifactExtractionResult["artifacts"][number];

/** Rows of a collection that a summary samples before counting the rest. */
const SUMMARY_SAMPLE = 16;
/**
 * Serialized bytes each sampled collection may use. A contradiction can carry
 * signer names of tens of kilobytes; it is counted and paged instead.
 */
const SUMMARY_SAMPLE_BYTES = 4096;

const count = z.int().nonnegative();

const page = {
  kind: z.literal("artifact-extraction"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
};

/** Fields of one written file that a page may select. */
export const extractedArtifactFieldSchema =
  artifactExtractionResultSchema.shape.artifacts.element.keyof();

/** One page of a retained extraction's written files or its other lists. */
export const artifactExtractionViewRequestSchema = z.discriminatedUnion(
  "collection",
  [
    z.strictObject({
      ...page,
      collection: z.literal("artifacts"),
      relative_paths: z
        .array(z.string())
        .optional()
        .describe("Exact written paths relative to output_root"),
      path_globs: z
        .array(inventoryPathGlobSchema)
        .optional()
        .describe(
          'Whole-path globs over written relative paths, any of which may match: * and ? stay within one segment and a ** segment spans segments, e.g. ["lib/*/*.so"] or ["assets/**"]; [] matches none.',
        ),
      artifact_ids: z.array(prefixedDigestSchema("art")).optional(),
      fields: z
        .array(extractedArtifactFieldSchema)
        .min(1)
        .optional()
        .describe("Row fields to return beside index; omit for every field"),
    }),
    z.strictObject({
      ...page,
      collection: z.enum(["integrity_contradictions", "residual_paths"]),
    }),
  ],
);
type ExtractionView = z.output<typeof artifactExtractionViewRequestSchema>;

const sampled = <Item extends z.ZodType>(item: Item, description: string) =>
  z
    .strictObject({ items: z.array(item), omitted: count })
    .describe(
      `${description} in order, at most ${String(SUMMARY_SAMPLE)} within ${String(SUMMARY_SAMPLE_BYTES)} serialized bytes; omitted counts the rest, which the collection pages`,
    );

const resultShape = artifactExtractionResultSchema.shape;

/** The extraction's identity, verification and counts in place of its lists. */
export const artifactExtractionSummarySchema = z.strictObject({
  effective_limits: resultShape.effective_limits,
  manifest: resultShape.manifest,
  extraction_manifest: resultShape.extraction_manifest
    .omit({ selected_occurrence_ids: true })
    .extend({ selected_occurrences: count }),
  output_root: resultShape.output_root,
  containment_verified: resultShape.containment_verified,
  cleanup: resultShape.cleanup.omit({ residual_paths: true }).extend({
    residual_paths: sampled(
      resultShape.cleanup.shape.residual_paths.element,
      "Paths cleanup could not remove",
    ),
  }),
  coverage: resultShape.coverage,
  counts: z.strictObject({
    artifacts: count,
    created: count,
    bytes_written: count,
    integrity_contradictions: count,
  }),
  provenance: sampled(
    resultShape.provenance.element,
    "Commands that produced the extraction",
  ),
  integrity_contradictions: sampled(
    integrityContradictionSchema,
    "Retained integrity contradictions",
  ),
});

/** One written file with its position in the complete extraction. */
export const extractedArtifactRowSchema = resultShape.artifacts.element
  .partial()
  .extend({ index: count });

const readExtraction = createAnalysisViewResultReader(
  artifactExtractionResultSchema,
);

/** A leading sample bounded by count and bytes; an oversized row ends it. */
const sample = <Item>(items: readonly Item[]) => {
  const listed = boundedList(items, SUMMARY_SAMPLE);
  const kept: Item[] = [];
  let bytes = 0;
  for (const item of listed.items) {
    bytes += jsonValueByteLength(
      item as unknown as JsonValue,
      SUMMARY_SAMPLE_BYTES - bytes,
    );
    if (bytes > SUMMARY_SAMPLE_BYTES) break;
    kept.push(item);
  }
  return { items: kept, omitted: items.length - kept.length };
};

const summarize = (
  extraction: ArtifactExtractionResult,
): z.output<typeof artifactExtractionSummarySchema> => {
  let created = 0;
  let bytesWritten = 0;
  for (const artifact of extraction.artifacts) {
    if (artifact.created) created += 1;
    bytesWritten += artifact.bytes_written;
  }
  const { selected_occurrence_ids, ...manifest } =
    extraction.extraction_manifest;
  const { residual_paths, ...cleanup } = extraction.cleanup;
  return {
    ...(extraction.effective_limits === undefined
      ? {}
      : { effective_limits: extraction.effective_limits }),
    manifest: extraction.manifest,
    extraction_manifest: {
      ...manifest,
      selected_occurrences: selected_occurrence_ids.length,
    },
    output_root: extraction.output_root,
    containment_verified: extraction.containment_verified,
    cleanup: { ...cleanup, residual_paths: sample(residual_paths) },
    coverage: extraction.coverage,
    counts: {
      artifacts: extraction.artifacts.length,
      created,
      bytes_written: bytesWritten,
      integrity_contradictions: extraction.integrity_contradictions.length,
    },
    provenance: sample(extraction.provenance),
    integrity_contradictions: sample(extraction.integrity_contradictions),
  };
};

const pick = (
  row: Extracted,
  fields: ReadonlySet<keyof Extracted> | undefined,
): Partial<Extracted> => {
  if (fields === undefined) return row;
  const picked: Partial<Record<keyof Extracted, unknown>> = {};
  for (const field of fields) picked[field] = row[field];
  return picked as Partial<Extracted>;
};

/** Exact selectors intersect; an empty selector matches nothing. */
const artifactMatcher = (
  view: Extract<ExtractionView, { collection: "artifacts" }>,
) => {
  const selectors = [view.relative_paths, view.path_globs, view.artifact_ids];
  if (selectors.every((selector) => selector === undefined)) return undefined;
  const paths =
    view.relative_paths === undefined
      ? undefined
      : new Set(view.relative_paths);
  const ids =
    view.artifact_ids === undefined ? undefined : new Set(view.artifact_ids);
  const globs = view.path_globs?.map(compileInventoryPathGlob);
  return (row: Extracted) =>
    (paths === undefined || paths.has(row.relative_path)) &&
    (ids === undefined || ids.has(row.artifact_id)) &&
    (globs === undefined || globs.some((glob) => glob(row.relative_path)));
};

/** One byte-bounded page of the selected collection. */
const collectionPage = (
  extraction: ArtifactExtractionResult,
  view: ExtractionView,
  owner: ByteBoundedPageOwner,
) => {
  if (view.collection === "artifacts") {
    const fields = view.fields === undefined ? undefined : new Set(view.fields);
    return selectByteBoundedViewRows(
      extraction.artifacts,
      view,
      {
        matches: artifactMatcher(view),
        project: (row, index): z.output<typeof extractedArtifactRowSchema> => ({
          index,
          ...pick(row, fields),
        }),
      },
      owner,
    );
  }
  const rows: readonly (
    | string
    | ArtifactExtractionResult["integrity_contradictions"][number]
  )[] =
    view.collection === "residual_paths"
      ? extraction.cleanup.residual_paths
      : extraction.integrity_contradictions;
  return selectByteBoundedViewRows(
    rows,
    view,
    { matches: undefined, project: (row) => row },
    owner,
  );
};

/** Project a retained extraction's summary or one page of its lists. */
export const projectArtifactExtractionView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  if (admitted.kind !== "artifact-extraction" && admitted.kind !== "summary")
    return err(
      analysisViewInputError([
        {
          path: ["view", "kind"],
          reason: "invalid_value",
          message: "Select an artifact-extraction or summary view.",
        },
      ]),
    );
  assertOwnedView<SummaryAnalysisView | ExtractionView>(
    admitted,
    "summary",
    "artifact-extraction",
  );
  const parsed = readExtraction(parent);
  if (!parsed.ok) return parsed;
  const subject = evidenceSubjectTarget(parent.subject);
  if (subject === undefined)
    return invalidAnalysisViewSubject(
      "Artifact extraction views require the recorded artifact subject identity.",
    );
  const extraction = parsed.value;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: EXTRACT_ARTIFACT_OPERATION,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: subject.path, sha256: subject.sha256 },
    limitations: boundedViewMessages(
      [...parent.limitations],
      parent.evidenceId,
      "limitations",
    ),
    unknowns: [
      "Written files reflect the extraction when it ran; later changes under output_root are not observed.",
    ],
  };
  if (admitted.kind === "summary")
    return ok({
      ...shared,
      kind: "summary" as const,
      view: admitted,
      summary: summarize(extraction),
      coverage: completeWithinViewCoverage(1),
    });
  const view = admitted;
  const context = {
    ...shared,
    kind: "artifact-extraction" as const,
    view,
    output_root: extraction.output_root,
  };
  const owner = {
    parentEvidenceId: parent.evidenceId,
    envelope: {
      ...context,
      items: [],
      byte_limited: false,
      coverage: PLACEHOLDER_COVERAGE,
    } as unknown as JsonValue,
    facet: view.collection,
  };
  const page = collectionPage(extraction, view, owner);
  if (!page.ok) return page;
  return ok({
    ...context,
    items: page.value.rows,
    byte_limited: page.value.byte_limited,
    coverage: pageViewCoverage(
      view.offset,
      page.value.rows.length,
      page.value.total,
    ),
  });
};
