import { AsarArtifactReader } from "../AsarArtifactReader.js";
import type { ArtifactReader } from "../ArtifactReader.js";
import { DirectoryArtifactReader } from "../DirectoryArtifactReader.js";
import { MachOSliceArtifactReader } from "../MachOSliceArtifactReader.js";
import { NativeDmgArtifactReader } from "../NativeDmgArtifactReader.js";
import { ZipArtifactReader } from "../ZipArtifactReader.js";
import type { ArtifactNode } from "../../domain/artifactGraph.js";

export const createReader = async (
  path: string,
  format: ArtifactNode["format"],
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
        ? new MachOSliceArtifactReader(path)
        : undefined;
    case "dmg":
      if (process.platform !== "darwin") return undefined;
      return NativeDmgArtifactReader.create(path, signal);
    default:
      return undefined;
  }
};

export const inventoryLimitations = (
  format: ArtifactNode["format"],
  reader: ArtifactReader | undefined,
): string[] => {
  if (reader !== undefined) return [];
  if (format === "dmg" || format === "pkg")
    return [
      `${format.toUpperCase()} root hash is observed; child inventory requires a native macOS adapter.`,
    ];
  if (format === "mach-o-universal" && process.platform !== "darwin")
    return ["Universal Mach-O slices require the native macOS lipo adapter."];
  return ["Artifact has no child container entries."];
};
