import { isNativeObservationOperation } from "../domain/native/nativeObservation.js";
import { isNativeInventoryOperation } from "../domain/native/nativeInventory.js";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { ToolResultDelivery } from "./ToolResultDelivery.js";
import { INSPECT_ANALYSIS_VIEW_OPERATION } from "../domain/analysisView/analysisViewErrors.js";
import { inspectAnalysisViewInputSchema } from "../domain/analysisView/analysisView.js";
import { smallerBatchDecompileSelection } from "../domain/analysisView/batchDecompileView.js";
import type { Evidence } from "../domain/evidence.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";

/** Compose native Evidence continuation with the selected, parsed response budget. */
export const createToolResultDelivery = (
  maximumResponseBytes: number | undefined,
): ToolResultDelivery =>
  new ToolResultDelivery(
    maximumResponseBytes ?? STDIO_DEFAULT_MAX_BUFFER_SIZE,
    retainedEvidenceContinuation,
  );

/**
 * Halve a caller-selected page that did not fit. Null means no smaller page
 * exists; undefined means the selection was not a page, so the owner's first
 * page applies.
 */
const smallerPage = (
  selected: JsonValue | undefined,
): JsonValue | null | undefined => {
  if (
    typeof selected !== "object" ||
    selected === null ||
    Array.isArray(selected) ||
    typeof selected.limit !== "number"
  )
    return undefined;
  return selected.limit > 1
    ? { ...selected, limit: Math.floor(selected.limit / 2) }
    : null;
};

/** A named, schema-validated call reading one view of one source. */
const continuationOf = (
  source: JsonValue,
  view: unknown,
): Readonly<Record<string, JsonValue>> => {
  const input = inspectAnalysisViewInputSchema.safeParse({ source, view });
  if (!input.success) return {};
  return {
    continuation: {
      name: INSPECT_ANALYSIS_VIEW_OPERATION,
      arguments: jsonValueSchema.parse(input.data),
    },
  };
};

/** Offer a next page for analysis whose owner supports paging. */
const retainedEvidenceContinuation = (
  evidence: Evidence,
  selected?: JsonValue,
  viewSource?: JsonValue,
): Readonly<Record<string, JsonValue>> => {
  // A view continues from the caller's own source, which need not be retained.
  if (evidence.operation === INSPECT_ANALYSIS_VIEW_OPERATION) {
    const view = smallerBatchDecompileSelection(evidence.normalized_result);
    return view === undefined || viewSource === undefined
      ? {}
      : continuationOf(viewSource, view);
  }
  const smaller = smallerPage(selected);
  if (smaller === null) return {};
  const view = smaller ?? ownerFirstPage(evidence);
  return view === undefined
    ? {}
    : continuationOf(
        { kind: "retained-evidence", evidence_id: evidence.evidence_id },
        view,
      );
};

/** The first page an owner offers when its complete retained result does not fit. */
const ownerFirstPage = (evidence: Evidence): JsonValue | undefined =>
  evidence.operation === "analyze_function" ||
  evidence.operation === "procedure_pseudo_code"
    ? { kind: "native", facet: "pseudocode", offset: 0 }
    : evidence.operation === "inspect_native_instruction"
      ? {
          kind: "native-instruction-references",
          collection: "incoming_references",
          offset: 0,
          limit: 64,
        }
      : evidence.operation === "trace_application_feature"
        ? { kind: "feature-trace", collection: "paths", offset: 0, limit: 64 }
        : evidence.operation === "batch_decompile"
          ? {
              kind: "batch-decompile",
              collection: "items",
              offset: 0,
              limit: 64,
            }
          : isNativeInventoryOperation(evidence.operation)
            ? { kind: "native-inventory", offset: 0, limit: 64 }
            : isNativeObservationOperation(evidence.operation)
              ? { kind: "native-observation", offset: 0, limit: 64 }
              : undefined;
