import type { ObjcSwiftMetadata } from "../domain/native/objcSwiftMetadata.js";
import type { PointerFixups } from "./AppleMachoFixups.js";
import type { DecodeIssue } from "./AppleDispatchDecodeFacts.js";
import type { FacetDecodeFacts } from "./AppleDispatchDecodeFacts.js";

const describeFixups = (fixups: PointerFixups): string => {
  if (fixups.unreadRebaseBytes > 0)
    return `LC_DYLD_INFO rebase opcodes were not decoded (${fixups.unreadRebaseBytes} bytes)`;
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
  readonly categoryIssues: readonly DecodeIssue[];
  readonly examined: number;
  readonly categoriesExamined: number;
  readonly truncated: boolean;
  readonly fixups: PointerFixups;
  readonly vtables: FacetDecodeFacts;
  readonly swift: FacetDecodeFacts;
}): void => {
  const {
    result,
    failures,
    categoryIssues,
    examined,
    categoriesExamined,
    truncated,
    fixups,
    vtables,
    swift,
  } = input;
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
  const categoryFailures = categoryIssues.map(
    ({ code, location, message }) =>
      `${code}${location === undefined ? "" : ` at ${location}`}: ${message}`,
  );
  result.coverage.push({
    facet: "objc_properties_categories",
    status:
      truncated ||
      categoryFailures.length > 0 ||
      result.objc_categories.some(({ decode }) => decode.status !== "decoded")
        ? "partial"
        : "complete",
    reason:
      [...categoryFailures, ...(truncated ? ["max_records_reached"] : [])].join(
        "; ",
      ) || null,
    examined: categoriesExamined,
    decoded: result.objc_categories.filter(
      ({ decode }) => decode.status === "decoded",
    ).length,
  });
  const fixupReason = [
    describeFixups(fixups),
    ...fixups.issues.map(
      ({ code, location, message }) =>
        `${code}${location === undefined ? "" : ` at ${location}`}: ${message}`,
    ),
  ]
    .filter((line) => line.length > 0)
    .join("; ");
  result.coverage.push({
    facet: "pointer_fixups",
    status:
      fixups.issues.length > 0 || fixups.unreadRebaseBytes > 0
        ? "partial"
        : fixups.examined === 0
          ? "unsupported"
          : "complete",
    reason: fixupReason.length > 0 ? fixupReason : null,
    examined: fixups.examined,
    decoded: fixups.issues.length > 0 ? 0 : fixups.examined,
  });
  result.coverage.push({
    facet: "swift_generic_resilient_witnesses_overrides_async_coroutines",
    status: "unsupported",
    reason:
      "This reader admits simple Swift conformance/static witness records and non-generic, non-resilient class vtables; generic/resilient tables and other Swift metadata families are not decoded",
    examined: 0,
    decoded: 0,
  });
  result.coverage.push({
    facet: "swift_conformances_static_witness_slots",
    status:
      swift.exhaustive &&
      !truncated &&
      !result.swift_conformances.some(
        ({ decode }) => decode.status !== "decoded",
      ) &&
      !result.swift_dispatch_slots.some(
        ({ table_kind, decode }) =>
          table_kind === "witness_table" && decode.status !== "decoded",
      )
        ? "complete"
        : "partial",
    reason:
      [
        ...swift.issues.map(formatIssue),
        ...(truncated ? ["max_records_reached"] : []),
        ...(result.swift_conformances.some(
          ({ decode }) => decode.status !== "decoded",
        ) ||
        result.swift_dispatch_slots.some(
          ({ table_kind, decode }) =>
            table_kind === "witness_table" && decode.status !== "decoded",
        )
          ? ["swift_records_unresolved"]
          : []),
      ].join("; ") || null,
    examined: swift.examined,
    decoded: swift.decoded,
  });
  result.coverage.push({
    facet: "swift_class_vtable_descriptors",
    status:
      vtables.exhaustive &&
      !truncated &&
      !result.swift_dispatch_slots.some(
        ({ table_kind, decode }) =>
          table_kind === "class_vtable" && decode.status !== "decoded",
      )
        ? "complete"
        : "partial",
    reason:
      [
        ...vtables.issues.map(formatIssue),
        ...(truncated ? ["max_records_reached"] : []),
        ...(result.swift_dispatch_slots.some(
          ({ table_kind, decode }) =>
            table_kind === "class_vtable" && decode.status !== "decoded",
        )
          ? ["vtable_implementations_unresolved"]
          : []),
      ].join("; ") || null,
    examined: vtables.examined,
    decoded: vtables.decoded,
  });
};

const formatIssue = ({ code, location, message }: DecodeIssue): string =>
  `${code}${location === undefined ? "" : ` at ${location}`}: ${message}`;
