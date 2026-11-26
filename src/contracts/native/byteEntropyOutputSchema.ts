import { byteEntropySummaryViewResultSchema } from "../../domain/analysisView/summarySchemas/byteEntropySummarySchema.js";
import { byteEntropySchema } from "../../domain/native/byteEntropy.js";
import { analysisDetailOutputSchemaOf } from "../analysisDetail.js";

/** Complete entropy Evidence or its retained summary, shared by the named contract. */
export const byteEntropyOutputSchema = analysisDetailOutputSchemaOf(
  byteEntropySchema,
  byteEntropySummaryViewResultSchema,
);
