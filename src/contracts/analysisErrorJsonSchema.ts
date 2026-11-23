import { z } from "zod";

import { analysisErrorProjectionSchema } from "../domain/analysisErrorProjectionSchema.js";

/** JSON Schema document used by generated API documentation and clients. */
export const analysisErrorJsonSchema = z.toJSONSchema(
  analysisErrorProjectionSchema,
);
