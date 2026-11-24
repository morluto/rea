import { ParseFailureError } from "../domain/parseFailure.js";

/**
 * Selected-binary file allowance. The ELF pointer index has its own per-call
 * control, `max_native_index_bytes`.
 */
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
  /** The binary's own container bytes break their format's rules. */
  malformed: ["malformed-container"],
  /**
   * The binary's container parsed, but its registration, pointers, tokens or
   * types do not agree with the metadata. The pair may come from different
   * builds, either file may be damaged, or the registration layout may be
   * outside coverage, so no single file is established as at fault.
   */
  linkConflict: [
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

/** What a native-link budget counts, so its maximum is reported with its unit. */
export type NativeBudgetUnit = "entries" | "bytes" | "frames";

/** The ParseFailure format of a native image linked against IL2CPP metadata. */
export const IL2CPP_BINARY_FORMAT = "il2cpp-binary";

const isUnsupported = (reason: Il2cppBinaryFormatReason) =>
  (IL2CPP_BINARY_FAILURE_REASONS.unsupported as readonly string[]).includes(
    reason,
  );

/** Whether a link failure is a disagreement between the two files, not one file's bytes. */
export const isIl2cppLinkConflict = (reason: Il2cppBinaryFailureReason) =>
  (IL2CPP_BINARY_FAILURE_REASONS.linkConflict as readonly string[]).includes(
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
  /** What the exceeded maximum counts; set only for a capacity reason. */
  readonly unit: NativeBudgetUnit | undefined;
  constructor(reason: Il2cppBinaryFormatReason, message: string);
  constructor(
    reason: Il2cppBinaryCapacityReason,
    message: string,
    maximum: number,
    unit: NativeBudgetUnit,
    limitName?: string,
  );
  constructor(
    readonly reason: Il2cppBinaryFailureReason,
    message: string,
    maximum?: number,
    unit?: NativeBudgetUnit,
    /** The exceeded budget's name; defaults to the reason for a fixed budget. */
    limitName: string = reason,
  ) {
    const detail = `${reason}: ${message}`;
    super(
      maximum !== undefined
        ? {
            kind: "limit",
            format: IL2CPP_BINARY_FORMAT,
            detail,
            limit: { name: limitName, maximum },
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
    this.unit = unit;
    this.name = "Il2cppBinaryFormatFailure";
  }
}
