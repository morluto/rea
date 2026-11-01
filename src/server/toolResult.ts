import { isNativeObservationOperation } from "../domain/native/nativeObservation.js";
import { isNativeInventoryOperation } from "../domain/native/nativeInventory.js";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { ToolResultDelivery } from "./ToolResultDelivery.js";
import { INSPECT_ANALYSIS_VIEW_OPERATION } from "../domain/analysisView/analysisViewErrors.js";
import { inspectAnalysisViewInputSchema } from "../domain/analysisView/analysisView.js";
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

/** Offer a named, schema-validated page for retained analysis whose owner supports paging. */
const retainedEvidenceContinuation = (
  evidence: Evidence,
  selected?: JsonValue,
): Readonly<Record<string, JsonValue>> => {
  const smaller = smallerPage(selected);
  if (smaller === null) return {};
  const view = smaller ?? ownerFirstPage(evidence);
  if (view === undefined) return {};
  const input = inspectAnalysisViewInputSchema.safeParse({
    source: { kind: "retained-evidence", evidence_id: evidence.evidence_id },
    view,
  });
  if (!input.success) return {};
  return {
    continuation: {
      name: INSPECT_ANALYSIS_VIEW_OPERATION,
      arguments: jsonValueSchema.parse(input.data),
    },
  };
};

/** The first page an owner offers when its complete retained result does not fit. */
const ownerFirstPage = (evidence: Evidence): JsonValue | undefined =>
  evidence.operation === "analyze_function"
    ? { kind: "native", facet: "pseudocode", offset: 0 }
    : evidence.operation === "trace_application_feature"
      ? { kind: "feature-trace", collection: "paths", offset: 0, limit: 64 }
      : isNativeInventoryOperation(evidence.operation)
        ? { kind: "native-inventory", offset: 0, limit: 64 }
        : isNativeObservationOperation(evidence.operation)
          ? { kind: "native-observation", offset: 0, limit: 64 }
          : undefined;
