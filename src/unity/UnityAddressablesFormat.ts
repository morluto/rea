import { ParseFailureError } from "../domain/parseFailure.js";
import { UNITY_ADDRESSABLES_FORMAT } from "../domain/unity/unityAddressables.js";

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

/** Distinguish catalogs outside decoder coverage from damaged ones, keeping the stable reason. */
export class UnityAddressablesFormatFailure extends ParseFailureError<
  "malformed" | "unsupported"
> {
  constructor(
    readonly reason: UnityAddressablesFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    const detail = `${reason}: ${message}`;
    super(
      kindOf(reason) === "unsupported"
        ? {
            kind: "unsupported",
            format: UNITY_ADDRESSABLES_FORMAT,
            detail,
            undecodedContent: false,
          }
        : { kind: "malformed", format: UNITY_ADDRESSABLES_FORMAT, detail },
      options,
    );
    this.name = "UnityAddressablesFormatFailure";
  }
}
