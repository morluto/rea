import { z } from "zod";
import {
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import {
  pythonPycSummarySchema,
  pythonPycViewItemsSchema,
  pythonPycViewRequestSchema,
} from "../pythonPycView.js";

export const pythonPycSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_python_pyc"),
  summary: pythonPycSummarySchema,
});

export const pythonPycCodeObjectsViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  kind: z.literal("python-pyc"),
  parent_operation: z.literal("inspect_python_pyc"),
  view: pythonPycViewRequestSchema,
  pyc: pythonPycSummarySchema,
  items: pythonPycViewItemsSchema,
});
