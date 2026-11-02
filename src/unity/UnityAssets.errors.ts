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

/**
 * Resource policy for one decoded metadata or object string, checked before
 * decoding; real paths and names are short.
 */
export const UNITY_SERIALIZED_FILE_MAX_STRING_BYTES = 65_536;

export const unityStringLimitFailure = (
  field: string,
): UnityAssetsFormatFailure =>
  new UnityAssetsFormatFailure(
    "limit",
    `SerializedFile ${field} is longer than the ${String(UNITY_SERIALIZED_FILE_MAX_STRING_BYTES)}-byte string allowance`,
    undefined,
    {
      name: "The SerializedFile string allowance",
      maximum: UNITY_SERIALIZED_FILE_MAX_STRING_BYTES,
      kind: "bytes",
    },
  );
