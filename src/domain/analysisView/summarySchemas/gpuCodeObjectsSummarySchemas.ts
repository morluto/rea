import { z } from "zod";
import { gpuCodeObjectsObjectSchema } from "../../gpu/gpuCodeObjects.js";
import {
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import {
  gpuCodeObjectsItemsSchema,
  gpuCodeObjectsPtxPageSchema,
  gpuCodeObjectsSummarySchema,
  gpuCodeObjectsViewRequestSchema,
} from "../gpuCodeObjectsView.js";

export const gpuCodeObjectsSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_gpu_code_objects"),
  summary: gpuCodeObjectsSummarySchema,
});

export const gpuCodeObjectsPageViewResultSchema = z.strictObject({
  kind: z.literal("gpu-code-objects"),
  view: gpuCodeObjectsViewRequestSchema,
  items: gpuCodeObjectsItemsSchema,
  ptx: gpuCodeObjectsPtxPageSchema.nullable(),
  source_coverage: gpuCodeObjectsObjectSchema.shape.coverage,
  ...viewResultBaseFields,
  parent_operation: z.literal("inspect_gpu_code_objects"),
});
