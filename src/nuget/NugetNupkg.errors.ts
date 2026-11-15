import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { NUGET_NUPKG_LIMIT_MAXIMA } from "../domain/nuget/nupkg.js";

/** The ParseFailure format of a NuGet .nupkg and its .nuspec. */
export const NUGET_NUPKG_FORMAT = "nuget-nupkg";

/** Resource boundary exceeded while inventorying members or decoding a .nuspec. */
export class NugetNupkgCapacityFailure extends ArtifactReaderFailure {
  constructor(
    readonly resource: keyof typeof NUGET_NUPKG_LIMIT_MAXIMA,
    readonly maximum: number,
    message: string,
  ) {
    super("limit", message, {
      boundary: resource === "max_file_bytes" ? "file-size" : "capacity",
    });
    this.name = "NugetNupkgCapacityFailure";
  }
}
