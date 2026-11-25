import { z } from "zod";
import { evidenceSourceInputSchema } from "../domain/evidenceReference.js";
import { declareEvidenceReferenceAlternative } from "../domain/evidenceInputContract.js";
import { absoluteLocalPathStringSchema } from "../domain/localPath.js";
import { artifactIntegrityPolicySchema } from "../domain/artifactIntegrityPolicy.js";

/** A file or directory the comparison inventories in place, as inspect_artifact would. */
export const artifactPathSourceSchema = z.strictObject({
  kind: z.literal("path"),
  path: absoluteLocalPathStringSchema.describe(
    "Absolute path of a file or directory to inventory in place. A directory's subject is its content-addressed root digest; nothing is extracted or executed.",
  ),
  integrity_policy: artifactIntegrityPolicySchema,
});

/** One comparison side: inventory Evidence, or a path to inventory now. */
const artifactComparisonSourceSchema = declareEvidenceReferenceAlternative(
  z.union([evidenceSourceInputSchema, artifactPathSourceSchema]),
);

/** Artifact sources retain their explicit local-file selection authority. */
export const artifactComparisonInputSchema = z.strictObject({
  left: artifactComparisonSourceSchema,
  right: artifactComparisonSourceSchema,
});
