/** The fixed allowance a well-formed SerializedFile exceeded. */
export interface UnityAssetsAllowance {
  readonly name: string;
  readonly maximum: number;
  readonly kind: "count" | "bytes";
}

/**
 * Distinguish corrupt SerializedFiles from layouts outside parser coverage and
 * from well-formed files above a fixed inventory allowance.
 */
export class UnityAssetsFormatFailure extends Error {
  constructor(
    readonly kind: "malformed" | "unsupported" | "limit",
    message: string,
    /** Next probe for a recognized container this tool does not open itself. */
    readonly container?: "unity-web-data" | "unityfs" | "gzip",
    /** The exhausted allowance, for `limit` failures. */
    readonly allowance?: UnityAssetsAllowance,
  ) {
    super(message);
    this.name = "UnityAssetsFormatFailure";
  }
}
