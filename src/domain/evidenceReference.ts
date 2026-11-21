import { z } from "zod";
import { prefixedDigestSchema } from "./digests.js";
import { absoluteLocalPathStringSchema } from "./localPath.js";
import {
  declareBorrowedEvidenceInput,
  declareEvidenceInput,
  declareEvidenceReferenceAlternative,
} from "./evidenceInputContract.js";

/** Exact reference to Evidence already retained by the current session. */
export const retainedEvidenceReferenceSchema = z.strictObject({
  kind: z.literal("retained-evidence"),
  evidence_id: prefixedDigestSchema("ev"),
});

/** One completed Evidence record read from a local Evidence file or bundle. */
export const evidenceFileReferenceSchema = z.strictObject({
  kind: z.literal("evidence-file"),
  path: absoluteLocalPathStringSchema.describe(
    "Absolute local path of one completed Evidence JSON file, or of an Evidence bundle written by --evidence_output or export_evidence_bundle. REA reads and authenticates it, then uses it like retained Evidence, so large records are not charged as inline input.",
  ),
  evidence_id: prefixedDigestSchema("ev")
    .exactOptional()
    .describe(
      "The record to select when the file is an Evidence bundle, such as a summary's normalized_result.parent_evidence_id. A bundle holding exactly one record needs no selection.",
    ),
});

import { evidenceSchema } from "./evidence.js";

/** Portable observation or exact retained identity; semantic authentication follows admission. */
export const evidenceInputSchema = declareEvidenceInput(
  z.union([evidenceSchema, retainedEvidenceReferenceSchema]),
);
export type EvidenceInput = z.output<typeof evidenceInputSchema>;

/**
 * Advertise `declaration` for a borrowed parser. Zod rebuilds a derived schema,
 * such as one returned by `.describe()`, from its definition through the
 * instance constructor, so the projection belongs to that constructor rather
 * than to one instance.
 */
const advertisedAs = <Schema extends z.ZodType>(
  schema: Schema,
  declaration: z.ZodType,
): Schema => {
  const base = schema._zod.constr as unknown as {
    init: (instance: Schema, definition: Schema["_zod"]["def"]) => void;
  };
  const Borrowed = z.core.$constructor<Schema>(
    `BorrowedEvidence${schema._zod.def.type}`,
    (instance, definition) => {
      base.init(instance, definition);
      instance._zod.processJSONSchema = (context, json, params) =>
        declaration._zod.processJSONSchema!(context, json, params);
    },
  );
  return new Borrowed(schema._zod.def);
};

/** Borrow a selected inline record until its resource and format owner admits it. */
export const borrowEvidenceInput = () =>
  declareBorrowedEvidenceInput(
    advertisedAs(z.unknown().nonoptional(), evidenceInputSchema),
    evidenceInputSchema,
  );

/** Borrow array width too; its service must admit capacity before resolution. */
export const borrowEvidenceArray = () => {
  const declaration = z.array(evidenceInputSchema);
  return declareBorrowedEvidenceInput(
    advertisedAs(z.custom<unknown[]>(Array.isArray), declaration),
    declaration,
  );
};

/** Evidence input, or one record read from a local Evidence file or bundle. */
export const evidenceSourceInputSchema = declareEvidenceReferenceAlternative(
  z.union([...evidenceInputSchema.options, evidenceFileReferenceSchema]),
);
export type EvidenceSourceInput = z.output<typeof evidenceSourceInputSchema>;
