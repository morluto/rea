import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { elfDependenciesSummarySchema } from "../elfDependenciesView.js";

export const elfDependenciesSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_elf_dependencies"),
  summary: elfDependenciesSummarySchema,
});
