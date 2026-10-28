import type { GodotPckAdmission } from "./GodotPckLocation.js";
import type { PyInstallerAdmission } from "./pyinstaller/PyInstallerAdmission.js";
import type { NodeSeaAdmission } from "./nodeSea/NodeSeaAdmission.js";
import type { AsarHeaderAdmission } from "../config/asarHeaderAdmission.js";
import { AsarArtifactReader } from "./AsarArtifactReader.js";
import type { ArtifactReader } from "./ArtifactReader.js";
import { HexRecordArtifactReader } from "./HexRecordArtifactReader.js";
import { DirectoryArtifactReader } from "./DirectoryArtifactReader.js";
import { GodotPckArtifactReader } from "./GodotPckArtifactReader.js";
import { MachOSliceArtifactReader } from "./MachOSliceArtifactReader.js";
import { NativeDmgArtifactReader } from "./NativeDmgArtifactReader.js";
import { NodeSeaArtifactReader } from "./NodeSeaArtifactReader.js";
import { PyInstallerArtifactReader } from "./PyInstallerArtifactReader.js";
import { ZipArtifactReader } from "./ZipArtifactReader.js";
import type { ArtifactOccurrence } from "../domain/artifactGraph.js";
import {
  isZipPackageFormat,
  type ZipPackageFormat,
} from "../domain/zipPackageFormat.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";

/** Formats with an artifact entry reader; availability policy belongs to the caller. */
export type ArtifactReaderFormat =
  | "directory"
  | "asar"
  | "pyinstaller"
  | "node-sea"
  | "godot-pck"
  | "intel-hex"
  | "srec"
  | "mach-o-universal"
  | "dmg"
  | ZipPackageFormat;

interface ArtifactReaderConstruction {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly unreadableDirectories: "fail" | "omit";
  readonly admission?:
    | StableRegularFileDescriptor
    | NodeSeaAdmission
    | PyInstallerAdmission
    | GodotPckAdmission
    | undefined;
  readonly asarHeaderAdmission?: AsarHeaderAdmission | undefined;
  /** Caller-selected root spelling; only ASAR companion lookup consumes this. */
  readonly selectedPath?: string | undefined;
}

export function createArtifactReader(
  path: string,
  format: ArtifactReaderFormat,
  options: ArtifactReaderConstruction,
): ArtifactReader;
export function createArtifactReader(
  path: string,
  format: ArtifactOccurrence["artifact_format"],
  options: ArtifactReaderConstruction,
): ArtifactReader | undefined;
/** Construct a reader without acquiring or transferring its source ownership. */
export function createArtifactReader(
  path: string,
  format: ArtifactOccurrence["artifact_format"],
  options: ArtifactReaderConstruction,
): ArtifactReader | undefined {
  const admission = options.admission;
  const rootSource =
    admission !== undefined && "kind" in admission
      ? admission.source
      : admission;
  if (isZipPackageFormat(format))
    return new ZipArtifactReader(path, format, undefined, rootSource);
  switch (format) {
    case "directory":
      return new DirectoryArtifactReader(path, options.unreadableDirectories);
    case "asar":
      return new AsarArtifactReader(path, {
        ...(options.asarHeaderAdmission === undefined
          ? {}
          : { headerAdmission: options.asarHeaderAdmission }),
        ...(options.selectedPath === undefined
          ? {}
          : { selectedPath: options.selectedPath }),
      });
    case "pyinstaller":
      return new PyInstallerArtifactReader(
        path,
        admission !== undefined &&
          "kind" in admission &&
          admission.kind === "pyinstaller"
          ? admission
          : rootSource,
      );
    case "node-sea":
      return new NodeSeaArtifactReader(
        path,
        admission !== undefined &&
          "kind" in admission &&
          admission.kind === "node-sea"
          ? admission
          : rootSource,
      );
    case "godot-pck":
      return new GodotPckArtifactReader(
        path,
        admission !== undefined &&
          "kind" in admission &&
          admission.kind === "godot-pck"
          ? admission
          : rootSource,
      );
    case "intel-hex":
    case "srec":
      return new HexRecordArtifactReader(path, format, rootSource);
    case "mach-o-universal":
      return new MachOSliceArtifactReader(
        path,
        options.environment,
        undefined,
        rootSource,
      );
    case "dmg":
      return new NativeDmgArtifactReader(path, options.environment);
    default:
      return undefined;
  }
}
