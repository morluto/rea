import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import type { JsonValue } from "../jsonValue.js";

/** Provider identity for HWP document inspection. */
export const HWP_PROVIDER_IDENTITY = {
  id: "hwp",
  name: "REA HWP document inspector",
  version: null,
} as const;

const nonnegative = z.number().int().nonnegative();

const artifactSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: nonnegative,
});

/** Inspect one HWP (.hwp) or HWPX (.hwpx) document. */
export const inspectHwpDocumentInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute path to a Hancom Office HWP (.hwp) or HWPX (.hwpx) document",
  ),
});

const binDataEntrySchema = z.strictObject({
  name: z.string(),
  bytes: nonnegative,
});

const charRunSchema = z.object({
  start_pos: nonnegative,
  char_shape_id: nonnegative,
});

const paragraphSchema = z
  .object({
    text: z.string(),
    char_runs: z.array(charRunSchema),
    para_shape_id: nonnegative,
    style_id: nonnegative,
    controls: z.array(z.unknown()),
    char_count: nonnegative,
  })
  .passthrough();

const pageDefSchema = z
  .object({
    width: nonnegative,
    height: nonnegative,
    landscape: z.boolean(),
  })
  .passthrough();

const secDefSchema = z
  .object({
    page_def: pageDefSchema,
    columns: nonnegative,
  })
  .passthrough();

const sectionSchema = z.object({
  sec_def: secDefSchema,
  paragraphs: z.array(paragraphSchema),
});

const docInfoSchema = z
  .object({
    char_shapes: z.array(z.unknown()),
    para_shapes: z.array(z.unknown()),
    styles: z.array(z.unknown()),
    fonts: z.array(z.unknown()),
  })
  .passthrough();

/** Parsed HWP/HWPX document structure returned by the json_dump binary. */
export const hwpDocumentSchema = z.object({
  artifact: artifactSchema,
  format: z.enum(["hwp5", "hwpx"]),
  version: z.string(),
  compressed: z.boolean(),
  encrypted: z.boolean(),
  sections: z.array(sectionSchema),
  doc_info: docInfoSchema,
  bin_data: z.array(binDataEntrySchema),
  limitations: z.array(z.string()),
});

export type InspectHwpDocumentInput = z.infer<
  typeof inspectHwpDocumentInputSchema
>;
export type HwpDocument = z.infer<typeof hwpDocumentSchema>;

/** Preserve caller selections for Evidence serialization. */
export const hwpInspectionParameters = (
  input: InspectHwpDocumentInput,
): Readonly<Record<string, JsonValue>> => ({
  path: input.path,
});
