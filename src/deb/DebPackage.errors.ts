import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type {
  DEB_PACKAGE_LIMIT_MAXIMA,
  DebPackage,
} from "../domain/deb/debPackage.js";

/** Distinguish corrupt ar/tar bytes from layouts this reader does not decode. */
export class DebPackageFormatFailure extends Error {
  constructor(
    readonly kind: "malformed" | "unsupported" | "truncated",
    message: string,
    readonly partial?: DebPackage,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DebPackageFormatFailure";
  }
}

/** Resource boundary exceeded while inventorying members or expanding a tar. */
export class DebPackageCapacityFailure extends ArtifactReaderFailure {
  constructor(
    readonly resource: keyof typeof DEB_PACKAGE_LIMIT_MAXIMA,
    readonly maximum: number,
    message: string,
    readonly partial?: DebPackage,
  ) {
    super("limit", message, {
      boundary: resource === "max_file_bytes" ? "file-size" : "capacity",
    });
    this.name = "DebPackageCapacityFailure";
  }
}
