import type { ObjcSwiftMetadata } from "../domain/native/objcSwiftMetadata.js";
import type { PointerFixups } from "../domain/apple/appleMachoFixups.js";
import type {
  DecodeIssue,
  FacetDecodeFacts,
} from "../domain/apple/appleDispatchDecodeFacts.js";

const describeFixups = (fixups: PointerFixups): string => {
  const descriptions: string[] = [];
  if (fixups.unreadRebaseBytes > 0)
    descriptions.push(
      `LC_DYLD_INFO rebase opcodes were not decoded (${fixups.unreadRebaseBytes} bytes)`,
    );
  if (fixups.kind === "chained")
    descriptions.push(
      `chained fixups: ${fixups.formats.join(", ") || "no fixup segments"}`,
    );
  if (fixups.legacyRebaseStreams > 0)
    descriptions.push("LC_DYLD_INFO rebase opcodes");
  if (fixups.legacyBindStreams > 0)
    descriptions.push("LC_DYLD_INFO bind opcodes");
  return descriptions.length === 0
    ? "no fixup load commands"
    : descriptions.join("; ");
};

/** Append the per-facet coverage of one Apple dispatch metadata decode. */
export const pushDispatchCoverage = (input: {
  readonly result: ObjcSwiftMetadata;
  readonly failures: readonly string[];
  readonly categoryIssues: readonly DecodeIssue[];
  readonly examined: number;
  readonly categoriesExamined: number;
  readonly truncated: boolean;
  readonly objcListScanTruncated: boolean;
  readonly objcClassListScanTruncated: boolean;
  readonly fixups: PointerFixups;
  readonly declarations: FacetDecodeFacts;
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
    objcListScanTruncated,
    objcClassListScanTruncated,
    fixups,
    declarations,
    vtables,
    swift,
  } = input;
  const classRecords: string[] = [];
  let decodedClasses = 0;
  for (const record of result.objc_classes) {
    if (record.decode?.status === "decoded") decodedClasses++;
    else
      classRecords.push(
        `class ${record.name}: ${record.decode?.reason ?? record.decode?.status ?? "decode_status_missing"}`,
      );
  }
  for (const record of result.objc_protocol_records) {
    if (record.decode.status !== "decoded")
      classRecords.push(
        `protocol ${record.name}: ${record.decode.reason ?? record.decode.status}`,
      );
  }
  const categoryMethodReasons: string[] = [];
  for (const record of result.objc_dispatch_implementations) {
    if (record.decode.status === "decoded") continue;
    if (record.category === undefined)
      classRecords.push(
        `method ${record.class_name} ${record.method_type} ${record.selector}: ${record.decode.reason ?? record.decode.status}`,
      );
    else
      categoryMethodReasons.push(
        `category method ${record.category} ${record.class_name} ${record.method_type} ${record.selector}: ${record.decode.reason ?? record.decode.status}`,
      );
  }
  for (const record of result.objc_ivars) {
    if (record.decode.status !== "decoded")
      classRecords.push(
        `ivar ${record.class_name}.${record.name}: ${record.decode.reason ?? record.decode.status}`,
      );
  }
  const classReasons = [
    ...failures,
    ...classRecords,
    ...(truncated || objcListScanTruncated ? ["max_records_reached"] : []),
  ];
  result.coverage.push({
    facet: "objc_class_method_ivar_metadata",
    status: classReasons.length > 0 ? "partial" : "complete",
    reason: classReasons.join("; ") || null,
    examined,
    decoded: decodedClasses,
  });
  let decodedRelativePointers = 0;
  for (const item of result.relative_pointers) {
    if (item.decode.status === "decoded") decodedRelativePointers++;
  }
  const hasUnresolvedRelativePointers =
    decodedRelativePointers < result.relative_pointers.length;
  const relativePointerReasons = [
    ...(truncated || objcClassListScanTruncated ? ["max_records_reached"] : []),
    ...(hasUnresolvedRelativePointers
      ? ["relative_pointer_targets_unresolved"]
      : []),
  ];
  result.coverage.push({
    facet: "binary_relative_pointers",
    status: relativePointerReasons.length > 0 ? "partial" : "complete",
    reason: relativePointerReasons.join("; ") || null,
    examined: result.relative_pointers.length,
    decoded: decodedRelativePointers,
  });
  let decodedCategories = 0;
  for (const { decode } of result.objc_categories) {
    if (decode.status === "decoded") decodedCategories++;
  }
  const hasUnresolvedCategories =
    decodedCategories < result.objc_categories.length;
  const categoryFailures = categoryIssues.map(
    ({ code, location, message }) =>
      `${code}${location === undefined ? "" : ` at ${location}`}: ${message}`,
  );
  result.coverage.push({
    facet: "objc_properties_categories",
    status:
      truncated ||
      objcClassListScanTruncated ||
      categoryFailures.length > 0 ||
      hasUnresolvedCategories ||
      categoryMethodReasons.length > 0
        ? "partial"
        : "complete",
    reason:
      [
        ...categoryFailures,
        ...categoryMethodReasons,
        ...(truncated || objcClassListScanTruncated
          ? ["max_records_reached"]
          : []),
      ].join("; ") || null,
    examined: categoriesExamined,
    decoded: decodedCategories,
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
    decoded: fixups.decoded,
  });
  result.coverage.push({
    facet: "swift_generic_resilient_witnesses_overrides_async_coroutines",
    status: "unsupported",
    reason:
      "This reader admits Swift nominal type declarations, simple conformance/static witness records and non-generic, non-resilient class vtables; generic/resilient tables and other Swift metadata families are not decoded",
    examined: 0,
    decoded: 0,
  });
  let hasUnresolvedWitnessSlot = false;
  let hasUnresolvedVtableSlot = false;
  for (const { table_kind, decode } of result.swift_dispatch_slots) {
    if (decode.status === "decoded") continue;
    if (table_kind === "witness_table") hasUnresolvedWitnessSlot = true;
    else if (table_kind === "class_vtable") hasUnresolvedVtableSlot = true;
    if (hasUnresolvedWitnessSlot && hasUnresolvedVtableSlot) break;
  }
  const hasUnresolvedSwiftConformance =
    hasUnresolvedWitnessSlot ||
    result.swift_conformances.some(({ decode }) => decode.status !== "decoded");
  result.coverage.push({
    facet: "swift_conformances_static_witness_slots",
    status:
      swift.exhaustive && !truncated && !hasUnresolvedSwiftConformance
        ? "complete"
        : "partial",
    reason:
      [
        ...swift.issues.map(formatIssue),
        ...(truncated ? ["max_records_reached"] : []),
        ...(hasUnresolvedSwiftConformance ? ["swift_records_unresolved"] : []),
      ].join("; ") || null,
    examined: swift.examined,
    decoded: swift.decoded,
  });
  result.coverage.push({
    facet: "swift_declarations",
    status: declarations.exhaustive && !truncated ? "complete" : "partial",
    reason:
      [
        ...declarations.issues.map(formatIssue),
        ...(truncated ? ["max_records_reached"] : []),
      ].join("; ") || null,
    examined: declarations.examined,
    decoded: declarations.decoded,
  });
  result.coverage.push({
    facet: "swift_class_vtable_descriptors",
    status:
      vtables.exhaustive && !truncated && !hasUnresolvedVtableSlot
        ? "complete"
        : "partial",
    reason:
      [
        ...vtables.issues.map(formatIssue),
        ...(truncated ? ["max_records_reached"] : []),
        ...(hasUnresolvedVtableSlot
          ? ["vtable_implementations_unresolved"]
          : []),
      ].join("; ") || null,
    examined: vtables.examined,
    decoded: vtables.decoded,
  });
};

const formatIssue = ({ code, location, message }: DecodeIssue): string =>
  `${code}${location === undefined ? "" : ` at ${location}`}: ${message}`;
