import { ParseFailureError } from "../domain/parseFailure.js";
import type {
  DEB_PACKAGE_LIMIT_MAXIMA,
  DebPackage,
} from "../domain/deb/debPackage.js";

/** Distinguish corrupt ar/tar bytes from layouts this reader does not decode. */
export class DebPackageFormatFailure extends ParseFailureError<
  "malformed" | "unsupported" | "truncated"
> {
  constructor(
    kind: "malformed" | "unsupported" | "truncated",
    message: string,
    readonly partial?: DebPackage,
    options?: ErrorOptions,
  ) {
    super(
      kind === "unsupported"
        ? { kind, format: "deb", detail: message, undecodedContent: true }
        : { kind, format: "deb", detail: message },
      options,
    );
    this.name = "DebPackageFormatFailure";
  }
}

/** Resource boundary exceeded while inventorying members or expanding a tar. */
export class DebPackageCapacityFailure extends ParseFailureError<"limit"> {
  constructor(
    readonly resource: keyof typeof DEB_PACKAGE_LIMIT_MAXIMA,
    readonly maximum: number,
    message: string,
    readonly partial?: DebPackage,
  ) {
    super({
      kind: "limit",
      format: "deb",
      detail: message,
      limit: { name: resource, maximum },
    });
    this.name = "DebPackageCapacityFailure";
  }
}
