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
  ) {
    super(message);
    this.name = "UnityAssetsFormatFailure";
  }
}
