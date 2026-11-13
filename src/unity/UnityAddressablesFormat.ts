/** Stable machine-readable reason for each rejected catalog. */
export const UNITY_ADDRESSABLES_FAILURE_REASONS = {
  unsupported: ["unrecognized-format", "unsupported-version"],
  malformed: [
    "invalid-json",
    "missing-field",
    "invalid-base64",
    "truncated-record",
    "offset-out-of-bounds",
    "index-out-of-range",
    "invalid-object-tag",
    "invalid-string",
    "string-chain-cycle",
    "string-chain-overlap",
    "location-set-overlap",
    "string-overlap",
  ],
  capacity: [],
} as const;
export type UnityAddressablesFailureKind =
  keyof typeof UNITY_ADDRESSABLES_FAILURE_REASONS;
export type UnityAddressablesFailureReason =
  (typeof UNITY_ADDRESSABLES_FAILURE_REASONS)[UnityAddressablesFailureKind][number];

const kindOf = (
  reason: UnityAddressablesFailureReason,
): UnityAddressablesFailureKind =>
  (
    Object.keys(
      UNITY_ADDRESSABLES_FAILURE_REASONS,
    ) as UnityAddressablesFailureKind[]
  ).find((kind) =>
    (UNITY_ADDRESSABLES_FAILURE_REASONS[kind] as readonly string[]).includes(
      reason,
    ),
  )!;

/** Distinguish catalogs outside decoder coverage from damaged ones and from reader allowances. */
export class UnityAddressablesFormatFailure extends Error {
  readonly kind: UnityAddressablesFailureKind;
  constructor(
    readonly reason: UnityAddressablesFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${reason}: ${message}`, options);
    this.name = "UnityAddressablesFormatFailure";
    this.kind = kindOf(reason);
  }
}
