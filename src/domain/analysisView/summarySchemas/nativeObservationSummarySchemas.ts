import { z } from "zod";
import type { NativeObservationOperation } from "../../native/nativeObservation.js";
import { artifactSchema, summaryViewResultBase } from "../analysisViewBase.js";
import {
  nativeObservationItemsSchemas,
  nativeSourceContextReferenceSchema,
} from "../nativeObservationSchemas.js";
import { nativeViewSourceContext } from "../nativeViewContext.js";

const nativeObservationSummaryFor = <
  Operation extends NativeObservationOperation,
>(
  operation: Operation,
) =>
  z.strictObject({
    ...summaryViewResultBase,
    ...nativeViewSourceContext,
    artifact: artifactSchema.nullable(),
    parent_operation: z.literal(operation),
    source_context: nativeSourceContextReferenceSchema,
    summary: z.strictObject({ observations: z.int().nonnegative() }),
    items: nativeObservationItemsSchemas[operation],
  });

export const nativeObservationSummaryViewResultSchemas = {
  procedure_address: nativeObservationSummaryFor("procedure_address"),
  procedure_callees: nativeObservationSummaryFor("procedure_callees"),
  procedure_callers: nativeObservationSummaryFor("procedure_callers"),
  xrefs: nativeObservationSummaryFor("xrefs"),
  resolve_containing_procedure: nativeObservationSummaryFor(
    "resolve_containing_procedure",
  ),
  get_call_graph: nativeObservationSummaryFor("get_call_graph"),
};
