import { AsarArtifactReader } from "../AsarArtifactReader.js";
import type {
  ArtifactReader,
  ArtifactReaderTraversal,
} from "../ArtifactReader.js";
import { DirectoryArtifactReader } from "../DirectoryArtifactReader.js";
import { MachOSliceArtifactReader } from "../MachOSliceArtifactReader.js";
import { NativeDmgArtifactReader } from "../NativeDmgArtifactReader.js";
import { UefiArtifactReader } from "../UefiArtifactReader.js";
import { ZipArtifactReader } from "../ZipArtifactReader.js";
import type {
  ArtifactInventoryCoverage,
  ArtifactOccurrence,
} from "../../domain/artifactGraph.js";
import {
  isZipPackageFormat,
  ZIP_NON_ENTRY_LIMITATION,
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
    case "uefi":
      return new UefiArtifactReader(path, rootSource);
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

/** Decide traversal scope and availability once, independently of diagnostic wording. */
export const inventoryCoverage = (
  format: ArtifactOccurrence["artifact_format"],
  reader: ArtifactReader | undefined,
  traversal: ArtifactReaderTraversal,
): {
  readonly coverage: ArtifactInventoryCoverage;
  readonly limitations: string[];
} => {
  if (reader !== undefined)
    return {
      coverage: { scope: "container-entries", status: traversal.status },
      limitations: [
        ...(isZipPackageFormat(reader.format)
          ? [ZIP_NON_ENTRY_LIMITATION]
          : []),
        ...traversal.limitations,
      ],
    };
  // dmg and pkg reach here only after classifyRootFormat matched their bytes.
  if (format === "dmg" || format === "pkg")
    return {
      coverage: { scope: "container-entries", status: "unknown" },
      limitations: [
        `${format.toUpperCase()} root hash is observed; child inventory requires a native macOS adapter.`,
      ],
    };
  if (format === "mach-o-universal")
    return {
      coverage: { scope: "container-entries", status: "unknown" },
      limitations: [
        "Universal Mach-O slices require the native macOS lipo adapter.",
      ],
    };
  if (isZipPackageFormat(format) || format === "directory" || format === "asar")
    return {
      coverage: { scope: "container-entries", status: "unknown" },
      limitations: [`${format} child inventory reader is unavailable.`],
    };
  return {
    coverage: { scope: "root", status: "complete" },
    limitations: ["Artifact has no child container entries."],
  };
};
