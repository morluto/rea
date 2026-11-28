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
  /** Section index exactly as the container declares it; it may be negative. */
  index: z.number().int(),
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

/** Whether a `vers` record was read, absent, or present but undecodable. */
export const labviewVersionCoverageSchema = z.enum([
  "observed",
  "absent",
  "unknown",
]);

/** One file member of the embedded program-tree ZIP (`LVzp`). */
export const labviewProgramTreeMemberSchema = z.strictObject({
  /** Path exactly as the ZIP central directory records it. */
  name: z.string(),
  /** Uncompressed bytes the central directory declares. */
  bytes: count,
  /** Stored bytes the central directory declares. */
  stored_bytes: count,
  /** ZIP compression method, preserved as declared. */
  method: z.number().int().nonnegative(),
  /** Whether the entry declares ZIP encryption. */
  encrypted: z.boolean(),
  /**
   * Recorded name bytes as hex when the ZIP declares no encoding and the name
   * is not ASCII, so a CP437 fallback is not presented as exact; null otherwise.
   */
  raw_name_hex: z.string().nullable(),
});

/** The embedded program tree's member inventory; contents are not extracted. */
export const labviewProgramTreeSchema = z.strictObject({
  /** File members in the archive; directory entries are omitted. */
  entry_count: count,
  /** Sum of the members' declared uncompressed sizes. */
  total_bytes: count,
  members: z.array(labviewProgramTreeMemberSchema),
});

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
    /** Where this container starts in the selected file; 0 for a direct RSRC file. */
    file_offset: count,
    format_version: count,
    file_type: z.string().length(4),
    creator: z.string().length(4),
    /** Container-relative offset of the data section; add `file_offset` for the file. */
    data_offset: count,
    /** Bytes declared for the container's data section. */
    data_bytes: count,
    /** Container-relative offset of the info section; add `file_offset` for the file. */
    info_offset: count,
    /** Bytes declared for the container's info section. */
    info_bytes: count,
  }),
  /** LabVIEW version recorded by the container's `vers` block; null when not read. */
  labview_version: z.string().nullable(),
  /** Whether that version was read, absent, or present but undecodable. */
  version_coverage: labviewVersionCoverageSchema,
  /** Whether a block-diagram heap block (BDH*) is present. */
  block_diagram: labviewPresenceSchema,
  /** Whether a front-panel heap block (FPH*) is present. */
  front_panel: labviewPresenceSchema,
  /**
   * The embedded program tree's ZIP members, when one was decoded. Evidence
   * saved before this field existed reads as `null`, not as a parse failure.
   */
  program_tree: labviewProgramTreeSchema.nullable().default(null),
  blocks: z.array(labviewBlockSchema),
  limitations: z.array(z.string()),
});

export type InspectLabviewArtifactInput = z.infer<
  typeof inspectLabviewArtifactInputSchema
>;
export type LabviewArtifact = z.infer<typeof labviewArtifactSchema>;

/** The six-byte magic that opens every LabVIEW RSRC container (pylabview `RSRCHeader`). */
export const LABVIEW_RSRC_MAGIC = "RSRC\r\n";
