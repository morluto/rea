import { ArtifactReaderFailure } from "../resources/index.js";
import type { RPM_PACKAGE_LIMIT_MAXIMA } from "../domain/rpm/package.js";

/** Resource boundary exceeded while reading headers, files, or scriptlet text. */
export class RpmPackageCapacityFailure extends ArtifactReaderFailure {
  constructor(
    readonly resource: keyof typeof RPM_PACKAGE_LIMIT_MAXIMA,
    readonly maximum: number,
    message: string,
  ) {
    super("limit", message, {
      boundary: resource === "max_file_bytes" ? "file-size" : "capacity",
    });
    this.name = "RpmPackageCapacityFailure";
  }
}
