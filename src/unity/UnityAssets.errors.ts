/** Distinguish corrupt SerializedFiles from layouts outside parser coverage. */
export class UnityAssetsFormatFailure extends Error {
  constructor(
    readonly kind: "malformed" | "unsupported",
    message: string,
    /** Next probe for a recognized container this tool does not open itself. */
    readonly container?: "unity-web-data" | "unityfs" | "gzip",
  ) {
    super(message);
    this.name = "UnityAssetsFormatFailure";
  }
}
