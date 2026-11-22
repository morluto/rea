import { z } from "zod";
import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const count = z.number().int().nonnegative();

/** One explicit local file; the format is detected, never assumed from the name. */
export const inspectLabviewArtifactInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a LabVIEW RSRC file (.vi, .ctl, .llb) or a LabVIEW-built PE",
  ),
});

/** How one block section's stored bytes are coded. */
export const labviewSectionCodingSchema = z.enum([
  "none",
  "zlib",
  "xor",
  "unknown",
]);

export const labviewSectionSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  /** Section name from the container's name list; null when the section is unnamed. */
  name: z.string().nullable(),
  /** Bytes stored in the section, as declared by the section data header. */
  stored_bytes: count,
  /** Decoded byte count when this reader decoded the section; otherwise null. */
  decoded_bytes: count.nullable(),
  coding: labviewSectionCodingSchema,
});

export const labviewBlockSchema = z.strictObject({
  /** Four-character block identifier, preserving its exact bytes as Latin-1. */
  identifier: z.string().length(4),
  sections: z.array(labviewSectionSchema),
});

/** Whether a heap block was observed, or whether unexamined content could hold one. */
export const labviewPresenceSchema = z.enum(["present", "absent", "unknown"]);
export type LabviewArtifactPresence = z.infer<typeof labviewPresenceSchema>;

/** One static RSRC observation: container facts and the block inventory. */
export const labviewArtifactSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string(),
    sha256: digestSchema,
    bytes: count,
  }),
  container: z.strictObject({
    kind: z.enum(["rsrc", "pe-rcdata-rsrc"]),
    /** RSRC containers found in the selected file; the parsed one is the largest. */
    embedded_containers: z.number().int().positive(),
    format_version: count,
    file_type: z.string().length(4),
    creator: z.string().length(4),
    data_offset: count,
    data_bytes: count,
    info_offset: count,
    info_bytes: count,
  }),
  /** LabVIEW version recorded by the container's vers block; null when absent. */
  labview_version: z.string().nullable(),
  /** Whether a block-diagram heap block (BDH*) is present. */
  block_diagram: labviewPresenceSchema,
  /** Whether a front-panel heap block (FPH*) is present. */
  front_panel: labviewPresenceSchema,
  blocks: z.array(labviewBlockSchema),
  limitations: z.array(z.string()),
});

export type InspectLabviewArtifactInput = z.infer<
  typeof inspectLabviewArtifactInputSchema
>;
export type LabviewArtifact = z.infer<typeof labviewArtifactSchema>;
