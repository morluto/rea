import type { BinaryTarget } from "./binaryTargetTypes.js";

/** Target facts required by an individual provider operation. */
export interface TargetApplicability {
  readonly kinds: readonly BinaryTarget["kind"][];
  readonly formats: readonly BinaryTarget["format"][];
  readonly reason: string;
}

/** Evaluate provider-owned requirements against the admitted target. */
export const targetApplicabilityRefusal = (
  applicability: TargetApplicability,
  target: BinaryTarget,
):
  | {
      readonly code: "target_kind_unsupported" | "target_format_unsupported";
      readonly reason: string;
    }
  | undefined =>
  !applicability.kinds.includes(target.kind)
    ? { code: "target_kind_unsupported", reason: applicability.reason }
    : !applicability.formats.includes(target.format)
      ? { code: "target_format_unsupported", reason: applicability.reason }
      : undefined;
