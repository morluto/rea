import { z } from "zod";
import {
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import { nullableCollectionViewCoverageSchema } from "../analysisViewCoverage.js";
import {
  erlangBeamSummarySchema,
  erlangBeamViewPageSchema,
  erlangBeamViewRequestSchema,
} from "../erlangBeamView.js";

export const erlangBeamSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_erlang_beam"),
  summary: erlangBeamSummarySchema,
});

export const erlangBeamTableViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  coverage: nullableCollectionViewCoverageSchema,
  kind: z.literal("beam"),
  parent_operation: z.literal("inspect_erlang_beam"),
  view: erlangBeamViewRequestSchema,
  beam: erlangBeamSummarySchema,
  page: erlangBeamViewPageSchema,
});
