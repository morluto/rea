import type { ObjcSwiftMetadata } from "../domain/objcSwiftMetadata.js";
import type { PointerFixups } from "./AppleMachoFixups.js";

const describeFixups = (fixups: PointerFixups): string => {
  if (fixups.kind === "chained")
    return `chained fixups: ${fixups.formats.join(", ") || "no fixup segments"}`;
  return fixups.kind === "dyld-info"
    ? "LC_DYLD_INFO bind opcodes"
    : "no fixup load commands";
};

/** Append the per-facet coverage of one Apple dispatch metadata decode. */
export const pushDispatchCoverage = (input: {
  readonly result: ObjcSwiftMetadata;
  readonly failures: readonly string[];
  readonly examined: number;
  readonly categoriesExamined: number;
  readonly truncated: boolean;
  readonly fixups: PointerFixups;
}): void => {
  const { result, failures, examined, categoriesExamined, truncated, fixups } =
    input;
  result.coverage.push({
    facet: "objc_class_method_ivar_metadata",
    status: failures.length > 0 || truncated ? "partial" : "complete",
    reason:
      [...failures, ...(truncated ? ["max_records_reached"] : [])].join("; ") ||
      null,
    examined,
    decoded: result.objc_classes.length,
  });
  result.coverage.push({
    facet: "binary_relative_pointers",
    status:
      truncated ||
      result.relative_pointers.some((item) => item.decode.status !== "decoded")
        ? "partial"
        : "complete",
    reason: truncated
      ? "max_records_reached"
      : result.relative_pointers.some(
            (item) => item.decode.status !== "decoded",
          )
        ? "relative_pointer_targets_unresolved"
        : null,
    examined: result.relative_pointers.length,
    decoded: result.relative_pointers.filter(
      (item) => item.decode.status === "decoded",
    ).length,
  });
  const categoryFailures = failures.filter((failure) =>
    /^(?:Properties of|Category at)/u.test(failure),
  );
  result.coverage.push({
    facet: "objc_properties_categories",
    status:
      categoryFailures.length > 0 ||
      result.objc_categories.some(({ decode }) => decode.status !== "decoded")
        ? "partial"
        : "complete",
    reason: categoryFailures.join("; ") || null,
    examined: categoriesExamined,
    decoded: result.objc_categories.filter(
      ({ decode }) => decode.status === "decoded",
    ).length,
  });
  result.coverage.push({
    facet: "pointer_fixups",
    status: fixups.failures.length > 0 ? "partial" : "complete",
    reason: [describeFixups(fixups), ...fixups.failures].join("; "),
    examined: 0,
    decoded: 0,
  });
  result.coverage.push({
    facet: "swift_generic_resilient_witnesses_overrides_async_coroutines",
    status: "unsupported",
    reason:
      "This reader admits simple Swift conformance/static witness records and non-generic, non-resilient class vtables; generic/resilient tables and other Swift metadata families are not decoded",
    examined: 0,
    decoded: 0,
  });
};
