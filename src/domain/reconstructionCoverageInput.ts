import { z } from "zod";
import {
  reconstructionBoundaryIdSchema,
  reconstructionCoverageDataSchema,
} from "./reconstructionCoverage.js";

/** Named-boundary input for inline reconstruction coverage evaluation. */
export const reconstructionCoverageEvaluationInputSchema = z.strictObject({
  coverage: reconstructionCoverageDataSchema,
  boundary_id: reconstructionBoundaryIdSchema,
});

/**
 * Envelope the coverage command parses before its reader authenticates
 * `coverage`. The reader owns that document, so this field stays unknown.
 */
export const reconstructionCoverageRequestSchema =
  reconstructionCoverageEvaluationInputSchema.extend({
    coverage: z.unknown(),
  });
