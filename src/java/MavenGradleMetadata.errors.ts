import { decodeLimit } from "../domain/parseFailure.js";
/** The ParseFailure format of a Maven POM or Gradle module metadata file. */
export const MAVEN_GRADLE_METADATA_FORMAT = "maven-gradle-metadata";

/** Fixed report allowances; each names the representation it bounds. */
export type MavenGradleReportAllowance =
  | "repeated_variant_name_chars"
  | "dependency_rows"
  | "variants"
  | "exclusions"
  | "unresolved_records"
  | "xml_nodes";

const REPORT_REFUSALS: Readonly<
  Record<
    MavenGradleReportAllowance,
    (required: number, limit: number) => string
  >
> = {
  repeated_variant_name_chars: (required, limit) =>
    `Gradle module metadata would repeat ${String(required)} characters of variant names across its dependency rows, above the ${String(limit)}-character report allowance.`,
  dependency_rows: (required, limit) =>
    `Metadata declares ${String(required)} dependency and constraint rows, above the ${String(limit)}-row report allowance.`,
  variants: (required, limit) =>
    `Gradle module metadata declares ${String(required)} variants, above the ${String(limit)}-variant report allowance.`,
  exclusions: (required, limit) =>
    `Metadata declares ${String(required)} dependency exclusions, above the ${String(limit)}-exclusion report allowance.`,
  unresolved_records: (required, limit) =>
    `Metadata needs at least ${String(required)} unresolved reference and coordinate records, above the ${String(limit)}-record report allowance.`,
  xml_nodes: (required, limit) =>
    `Maven POM holds more than ${String(limit)} XML nodes (at least ${String(required)} counted), above the ${String(limit)}-node allowance for its document tree.`,
};

/**
 * Refuse a report that would grow far past the input bytes. Each dependency
 * row (with its unresolved-coordinate records), variant, exclusion and
 * repeated variant name expands a few input bytes into a much larger report.
 */
export const metadataReportLimit = (
  allowance: MavenGradleReportAllowance,
  maximum: number,
  required: number,
) =>
  decodeLimit(
    MAVEN_GRADLE_METADATA_FORMAT,
    REPORT_REFUSALS[allowance](required, maximum),
    { name: allowance, maximum, required },
  );
