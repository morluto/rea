import { z } from "zod";
import { modelArtifactViewRequestSchema } from "../../model/modelArtifactQuery.js";
import {
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import {
  modelArtifactSummarySchema,
  modelArtifactViewContextSchema,
  modelArtifactViewItemsSchema,
} from "../modelArtifactView.js";

export const modelArtifactSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_model_artifact"),
  summary: modelArtifactSummarySchema,
});

export const modelArtifactPageViewResultSchema = z.strictObject({
  kind: z.literal("model-artifact"),
  view: modelArtifactViewRequestSchema,
  items: modelArtifactViewItemsSchema,
  ...viewResultBaseFields,
  ...modelArtifactViewContextSchema.shape,
  parent_operation: z.literal("inspect_model_artifact"),
});
