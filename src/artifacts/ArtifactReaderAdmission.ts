import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import type { GodotPckAdmission } from "./GodotPckLocation.js";
import type { NodeSeaAdmission } from "./nodeSea/NodeSeaAdmission.js";
import type { PyInstallerAdmission } from "./pyinstaller/PyInstallerAdmission.js";
import type { BunStandaloneAdmission } from "./bun/BunStandaloneAdmission.js";
import type { DenoStandaloneAdmission } from "./deno/DenoStandaloneAdmission.js";
import type { DotnetBundleAdmission } from "./dotnet/DotnetBundleAdmission.js";
import type { EspFlashAdmission } from "./EspFlashImageArtifactReader.js";

/** Parsed format facts carried with the exact source that established them. */
export type ArtifactFormatAdmission =
  | GodotPckAdmission
  | NodeSeaAdmission
  | PyInstallerAdmission
  | DotnetBundleAdmission
  | BunStandaloneAdmission
  | DenoStandaloneAdmission
  | EspFlashAdmission;

export type ArtifactReaderAdmission =
  | StableRegularFileDescriptor
  | ArtifactFormatAdmission;
