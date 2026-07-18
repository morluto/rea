import { AsarArtifactReader } from "../../artifacts/AsarArtifactReader.js";
import {
  ArtifactReaderFailure,
  type ArtifactReader,
} from "../../artifacts/ArtifactReader.js";
import { DirectoryArtifactReader } from "../../artifacts/DirectoryArtifactReader.js";
import { MachOSliceArtifactReader } from "../../artifacts/MachOSliceArtifactReader.js";
import { NativeDmgArtifactReader } from "../../artifacts/NativeDmgArtifactReader.js";
import { ZipArtifactReader } from "../../artifacts/ZipArtifactReader.js";
import type { ArtifactNode } from "../../domain/artifactGraph.js";
import type { ArtifactNativeMountPolicy } from "./types.js";

export const createReader = async (
  path: string,
  format: ArtifactNode["format"],
  nativeMount: ArtifactNativeMountPolicy,
  signal?: AbortSignal,
): Promise<ArtifactReader | undefined> => {
  switch (format) {
    case "directory":
      return new DirectoryArtifactReader(path);
    case "zip":
    case "ipa":
    case "apk":
      return new ZipArtifactReader(path, format);
    case "asar":
      return new AsarArtifactReader(path);
    case "mach-o-universal":
      return process.platform === "darwin"
        ? new MachOSliceArtifactReader(path)
        : undefined;
    case "dmg":
      if (!nativeMount.nativeMountApproved) return undefined;
      if (!nativeMount.nativeMountEnabled)
        throw new ArtifactReaderFailure(
          "unavailable",
          "Native DMG mounting is disabled by operator policy",
        );
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
      `${format.toUpperCase()} root hash is observed; child inventory requires an approved native macOS adapter.`,
    ];
  if (format === "mach-o-universal" && process.platform !== "darwin")
    return ["Universal Mach-O slices require the native macOS lipo adapter."];
  return ["Artifact has no child container entries."];
};
