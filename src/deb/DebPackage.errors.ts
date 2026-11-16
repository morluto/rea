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
    options?: ErrorOptions,
  ) {
    super(
      {
        kind: "limit",
        format: "deb",
        detail: message,
        limit: { name: resource, maximum },
      },
      options,
    );
    this.name = "DebPackageCapacityFailure";
  }
}

/**
 * Fixed allowances the reader applies to report-amplifying structures. They
 * are not request budgets: no inspect_deb_package option raises them.
 */
export const DEB_PACKAGE_FIXED_ALLOWANCES = {
  ar_member_name_bytes: "The ar member name allowance",
  tar_extension_headers: "The tar extension header allowance",
  relationship_alternatives: "The control relationship alternatives allowance",
} as const;

/** A fixed reader allowance stopped inspection; the input is not shown to be invalid. */
export class DebPackageAllowanceFailure extends ParseFailureError<"limit"> {
  constructor(
    readonly allowance: keyof typeof DEB_PACKAGE_FIXED_ALLOWANCES,
    readonly maximum: number,
    message: string,
    readonly partial?: DebPackage,
    options?: ErrorOptions,
  ) {
    super(
      {
        kind: "limit",
        format: "deb",
        detail: message,
        limit: { name: allowance, maximum },
      },
      options,
    );
    this.name = "DebPackageAllowanceFailure";
  }
}
