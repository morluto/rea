import { ParseFailureError } from "../domain/parseFailure.js";

/** Existing selected-binary allowance also bounds its retained pointer workspace. */
export const IL2CPP_BINARY_BYTES = 1024 * 1024 * 1024;

export const IL2CPP_BINARY_FAILURE_REASONS = {
  unsupported: [
    "unsupported-container",
    "unsupported-pointer-encoding",
    "unsupported-type-kind",
    "generic-methods-unsupported",
  ],
  capacity: [
    "native-index-capacity",
    "type-nesting-capacity",
    "native-type-text-capacity",
  ],
  malformed: [
    "malformed-container",
    "code-gen-modules-not-found",
    "ambiguous-code-gen-module",
    "code-registration-not-found",
    "invalid-method-pointer",
    "invalid-method-token",
    "metadata-registration-not-found",
    "invalid-type",
    "generic-method-registration-not-found",
    "ambiguous-generic-method-registration",
  ],
} as const;

export type Il2cppBinaryFailureReason =
  (typeof IL2CPP_BINARY_FAILURE_REASONS)[keyof typeof IL2CPP_BINARY_FAILURE_REASONS][number];
/** A named workspace budget; the parse stopped without showing the input invalid. */
export type Il2cppBinaryCapacityReason =
  (typeof IL2CPP_BINARY_FAILURE_REASONS.capacity)[number];
type Il2cppBinaryFormatReason = Exclude<
  Il2cppBinaryFailureReason,
  Il2cppBinaryCapacityReason
>;

/** The ParseFailure format of a native image linked against IL2CPP metadata. */
export const IL2CPP_BINARY_FORMAT = "il2cpp-binary";

const isUnsupported = (reason: Il2cppBinaryFormatReason) =>
  (IL2CPP_BINARY_FAILURE_REASONS.unsupported as readonly string[]).includes(
    reason,
  );

/**
 * A native image REA cannot link, either outside coverage or inconsistent
 * with the metadata. The stable `reason` names the IL2CPP rule; a capacity
 * reason is a ParseFailure `limit` carrying the exceeded maximum.
 */
export class Il2cppBinaryFormatFailure extends ParseFailureError<
  "malformed" | "unsupported" | "limit"
> {
  constructor(reason: Il2cppBinaryFormatReason, message: string);
  constructor(
    reason: Il2cppBinaryCapacityReason,
    message: string,
    maximum: number,
  );
  constructor(
    readonly reason: Il2cppBinaryFailureReason,
    message: string,
    maximum?: number,
  ) {
    const detail = `${reason}: ${message}`;
    super(
      maximum !== undefined
        ? {
            kind: "limit",
            format: IL2CPP_BINARY_FORMAT,
            detail,
            limit: { name: reason, maximum },
          }
        : isUnsupported(reason as Il2cppBinaryFormatReason)
          ? {
              kind: "unsupported",
              format: IL2CPP_BINARY_FORMAT,
              detail,
              undecodedContent: false,
            }
          : { kind: "malformed", format: IL2CPP_BINARY_FORMAT, detail },
    );
    this.name = "Il2cppBinaryFormatFailure";
  }
}
