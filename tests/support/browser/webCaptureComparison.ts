import type { WebPageInspection } from "../../../src/domain/browserObservationSchemas.js";
import { compareWebCaptures } from "../../../src/domain/webCaptureDiff.js";
import {
  compareWebCapturesInputSchema,
  type WebCaptureDiff,
} from "../../../src/domain/webCaptureDiffSchemas.js";

export const compareInspections = (
  before: WebPageInspection,
  after: WebPageInspection,
) =>
  compareWebCaptures(
    compareWebCapturesInputSchema.parse({
      before: { inspection: before },
      after: { inspection: after },
    }),
  );

export const compareInspectionDimension =
  <Dimension extends keyof WebCaptureDiff["dimensions"]>(
    dimension: Dimension,
  ) =>
  (before: WebPageInspection, after: WebPageInspection) =>
    compareInspections(before, after).dimensions[dimension];
