import { AsarArtifactReader } from "../AsarArtifactReader.js";
import type { ArtifactReader } from "../ArtifactReader.js";
import { DirectoryArtifactReader } from "../DirectoryArtifactReader.js";
import { MachOSliceArtifactReader } from "../MachOSliceArtifactReader.js";
import { NativeDmgArtifactReader } from "../NativeDmgArtifactReader.js";
import { ZipArtifactReader } from "../ZipArtifactReader.js";
import type {
  ArtifactInventoryCoverage,
  ArtifactOccurrence,
  IntegrityContradiction,
} from "../../domain/artifactGraph.js";
import {
  isZipPackageFormat,
  ZIP_NON_ENTRY_TAIL_LIMITATION,
} from "../../domain/zipPackageFormat.js";
import type { StableRegularFileDescriptor } from "../../filesystem/RegularFile.js";

export const createReader = (
  path: string,
  format: ArtifactOccurrence["artifact_format"],
  environment: Readonly<NodeJS.ProcessEnv>,
  rootSource?: StableRegularFileDescriptor,
): ArtifactReader | undefined => {
  if (isZipPackageFormat(format))
    return new ZipArtifactReader(path, format, undefined, rootSource);
  switch (format) {
    case "directory":
      return new DirectoryArtifactReader(path);
    case "asar":
      return new AsarArtifactReader(path);
    case "mach-o-universal":
      return process.platform === "darwin"
        ? new MachOSliceArtifactReader(path, environment, undefined, rootSource)
        : undefined;
    case "dmg":
      if (process.platform !== "darwin") return undefined;
      return new NativeDmgArtifactReader(path, environment);
    default:
      return undefined;
  }
};

/** Classify source coverage and preserve its user-facing explanation once. */
export const inventoryAssessment = (
  format: ArtifactOccurrence["artifact_format"],
  reader: ArtifactReader | undefined,
  integrityContradictions: readonly IntegrityContradiction[],
  caseCollisionLimitation: string | undefined,
): {
  readonly coverage_status: ArtifactInventoryCoverage;
  readonly limitations: string[];
} => {
  let coverageStatus: ArtifactInventoryCoverage = "complete";
  const limitations: string[] = [];
  if (reader !== undefined) {
    if (isZipPackageFormat(reader.format))
      limitations.push(ZIP_NON_ENTRY_TAIL_LIMITATION);
  } else if (format === "dmg" || format === "pkg") {
    coverageStatus = "partial";
    limitations.push(
      `${format.toUpperCase()} root hash is observed; child inventory requires a native macOS adapter.`,
    );
  } else if (format === "mach-o-universal" && process.platform !== "darwin") {
    coverageStatus = "partial";
    limitations.push(
      "Universal Mach-O slices require the native macOS lipo adapter.",
    );
  } else {
    // The graph's modeled scope is the root itself for recognized leaf formats.
    limitations.push("Artifact has no child container entries.");
  }
  if (caseCollisionLimitation !== undefined) {
    coverageStatus = "partial";
    limitations.push(caseCollisionLimitation);
  }
  if (integrityContradictions.length > 0)
    limitations.push(
      `${String(integrityContradictions.length)} integrity contradiction(s) were recorded; mismatched content is observed-untrusted.`,
    );
  return { coverage_status: coverageStatus, limitations };
};
