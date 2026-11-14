import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { RPM_PACKAGE_LIMIT_MAXIMA } from "../domain/rpm/package.js";

/** Distinguish corrupt recognized RPM bytes from layouts outside this reader. */
export class RpmPackageFormatFailure extends Error {
  constructor(
    readonly kind: "malformed" | "unsupported",
    message: string,
    readonly observed?: Readonly<Record<string, JsonValue>>,
  ) {
    super(message);
    this.name = "RpmPackageFormatFailure";
  }
}

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
