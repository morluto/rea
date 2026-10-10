import { AsarArtifactReader } from "../AsarArtifactReader.js";
import type { ArtifactReader } from "../ArtifactReader.js";
import { DirectoryArtifactReader } from "../DirectoryArtifactReader.js";
import { MachOSliceArtifactReader } from "../MachOSliceArtifactReader.js";
import { NativeDmgArtifactReader } from "../NativeDmgArtifactReader.js";
import { ZipArtifactReader } from "../ZipArtifactReader.js";
import type { ArtifactOccurrence } from "../../domain/artifactGraph.js";
import { ZIP_NON_ENTRY_TAIL_LIMITATION } from "../../domain/zipPackageFormat.js";

export const createReader = async (
  path: string,
  format: ArtifactOccurrence["artifact_format"],
  environment: Readonly<NodeJS.ProcessEnv>,
  signal?: AbortSignal,
): Promise<ArtifactReader | undefined> => {
  switch (format) {
    case "directory":
      return new DirectoryArtifactReader(path);
    case "zip":
    case "ipa":
    case "apk":
    case "msix":
    case "appx":
      return new ZipArtifactReader(path, format);
    case "asar":
      return new AsarArtifactReader(path);
    case "mach-o-universal":
      return process.platform === "darwin"
        ? new MachOSliceArtifactReader(path, environment)
        : undefined;
    case "dmg":
      if (process.platform !== "darwin") return undefined;
      return NativeDmgArtifactReader.create(path, environment, signal);
    default:
      return undefined;
  }
};

export const inventoryLimitations = (
  format: ArtifactOccurrence["artifact_format"],
  reader: ArtifactReader | undefined,
): string[] => {
  if (reader !== undefined)
    return reader.format === "zip" ||
      reader.format === "ipa" ||
      reader.format === "apk" ||
      reader.format === "msix" ||
      reader.format === "appx"
      ? [ZIP_NON_ENTRY_TAIL_LIMITATION]
      : [];
  // dmg and pkg reach here only after classifyRootFormat matched their bytes.
  if (format === "dmg" || format === "pkg")
    return [
      `${format.toUpperCase()} root hash is observed; child inventory requires a native macOS adapter.`,
    ];
  if (format === "mach-o-universal" && process.platform !== "darwin")
    return ["Universal Mach-O slices require the native macOS lipo adapter."];
  return ["Artifact has no child container entries."];
};
