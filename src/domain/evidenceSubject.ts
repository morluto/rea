import { z } from "zod";

import {
  BINARY_ARCHITECTURES,
  RAW_ONLY_ARCHITECTURES,
} from "./binaryTargetTypes.js";

import {
  BINARY_TARGET_FORMAT_KINDS,
  BINARY_TARGET_FORMATS,
  targetFormatsOfKind,
} from "./targetFormats.js";

// Keep the historical catalog order. Artifact targets, universal Mach-O and
// Evidence-only values interrupt the resolved-target list at these positions.
const nonArtifactTargetFormats = BINARY_TARGET_FORMATS.filter(
  (format) =>
    format !== "mach-o-universal" &&
    BINARY_TARGET_FORMAT_KINDS[format] !== "artifact",
);
const trailingArchiveIndex = nonArtifactTargetFormats.indexOf("intel-hex");

export const evidenceSubjectFormatSchema = z.enum([
  "hopper",
  ...nonArtifactTargetFormats.slice(0, trailingArchiveIndex),
  ...targetFormatsOfKind("artifact"),
  "directory",
  "file",
  "unknown",
  "mach-o-universal",
  "javascript-bundle",
  "entitlements",
  "pyinstaller",
  "node-sea",
  "dotnet-bundle",
  "bun-standalone",
  "deno-standalone",
  ...nonArtifactTargetFormats.slice(trailingArchiveIndex),
]);

/** Format-owned architecture declarations shared by Evidence and persisted executions. */
const detectedEvidenceSubjectDeclaration = {
  format: evidenceSubjectFormatSchema.exclude(["raw-binary", "gamecube-dol"]),
  architecture: z
    .enum(BINARY_ARCHITECTURES)
    .exclude([...RAW_ONLY_ARCHITECTURES])
    .nullable(),
};

const rawEvidenceSubjectDeclaration = {
  format: z.literal("raw-binary"),
  architecture: z.enum(BINARY_ARCHITECTURES).nullable(),
};

const gamecubeEvidenceSubjectDeclaration = {
  format: z.literal("gamecube-dol"),
  architecture: z.literal("powerpc"),
};

/** Add the complete format-owned declaration to a persistence envelope. */
export const withEvidenceSubjectDeclaration = <
  Shape extends z.ZodRawShape,
  Config extends z.core.$ZodObjectConfig,
>(
  base: z.ZodObject<Shape, Config>,
) =>
  z.discriminatedUnion("format", [
    base.extend(detectedEvidenceSubjectDeclaration),
    base.extend(rawEvidenceSubjectDeclaration),
    base.extend(gamecubeEvidenceSubjectDeclaration),
  ]);
