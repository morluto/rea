import type { JadxToolPort } from "./JadxAnalysis.js";
import {
  ANDROID_KOTLIN_METADATA_DEFAULT_ROWS,
  type AndroidKotlinMetadataFacts,
  type AndroidKotlinMetadataSelection,
} from "../domain/android/androidKotlinMetadata.js";
import { jadxKotlinMetadataSchema } from "./JadxProtocol.js";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";

const OPERATION = "inspect_android_kotlin_metadata";

const sum = (rows: readonly { readonly classes: number }[]) =>
  rows.reduce((total, row) => total + row.classes, 0);

/** Validate the bridge's Kotlin metadata batch at its producing boundary. */
export const readAndroidKotlinMetadata = async (
  tools: JadxToolPort,
  snapshot: string,
  selection: AndroidKotlinMetadataSelection,
): Promise<AndroidKotlinMetadataFacts> => {
  const limit = selection.limit ?? ANDROID_KOTLIN_METADATA_DEFAULT_ROWS;
  const raw = await tools.json("rea_kotlin_metadata", {
    path: snapshot,
    limit,
    ...(selection.class_name === undefined
      ? {}
      : { class_name: selection.class_name }),
    ...(selection.package_prefix === undefined
      ? {}
      : { package_prefix: selection.package_prefix }),
  });
  const parsed = jadxKotlinMetadataSchema.safeParse(raw);
  if (!parsed.success)
    throw new AnalysisOutputError(
      OPERATION,
      "JADX Kotlin metadata inventory was malformed",
      { cause: parsed.error },
    );
  const facts = parsed.data;
  const { coverage } = facts;
  const inconsistent =
    coverage.examined_dex_entries > coverage.dex_entries ||
    coverage.classes_with_metadata > coverage.examined_classes ||
    coverage.undecodable_classes > coverage.classes_with_metadata ||
    // Annotations with malformed elements are counted as undecodable, not as a kind.
    sum(facts.versions) > coverage.classes_with_metadata ||
    sum(facts.versions) <
      coverage.classes_with_metadata - coverage.undecodable_classes ||
    sum(facts.kinds) !== sum(facts.versions) ||
    facts.matching_classes > coverage.classes_with_metadata ||
    // Markers are counted from the same examined classes and ZIP directory.
    facts.markers.class_prefixes.some(
      (marker) => marker.classes > coverage.examined_classes,
    ) ||
    facts.markers.kotlin_module_entries.names.length >
      facts.markers.kotlin_module_entries.count ||
    facts.markers.kotlin_module_entries.truncated !==
      facts.markers.kotlin_module_entries.names.length <
        facts.markers.kotlin_module_entries.count ||
    new Set(facts.markers.class_prefixes.map((marker) => marker.marker))
      .size !== facts.markers.class_prefixes.length ||
    facts.classes.length > Math.min(limit, facts.matching_classes) ||
    // A shortfall below the requested limit must be an explicit retained-allowance gap.
    (facts.classes.length < Math.min(limit, facts.matching_classes) &&
      facts.unknowns.length === 0) ||
    (coverage.status === "complete" &&
      (coverage.examined_dex_entries !== coverage.dex_entries ||
        facts.unknowns.length !== 0)) ||
    facts.classes.some(
      (row) =>
        (selection.class_name !== undefined &&
          row.class_name !== selection.class_name) ||
        (selection.class_name === undefined && row.decode === "decoded") ||
        (row.decode === "decoded") !== (row.declaration !== undefined) ||
        (row.decode === "undecodable") !== (row.decode_failure !== undefined),
    );
  if (inconsistent)
    throw new AnalysisOutputError(
      OPERATION,
      "JADX Kotlin metadata counts or class rows were inconsistent",
    );
  return facts;
};
