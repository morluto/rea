/** The ParseFailure format of a Maven POM or Gradle module metadata file. */
export const MAVEN_GRADLE_METADATA_FORMAT = "maven-gradle-metadata";

/** Fixed report allowances; each names the representation it bounds. */
export type MavenGradleReportAllowance =
  | "repeated_variant_name_chars"
  | "dependency_rows";

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
};

/**
 * Refuse a report that would grow far past the input bytes. Each dependency
 * row (with its unresolved-coordinate records) and each repeated variant name
 * expands a few input bytes into a much larger report.
 */
export class MavenGradleMetadataReportFailure extends Error {
  constructor(
    readonly allowance: MavenGradleReportAllowance,
    readonly limit: number,
    readonly required: number,
  ) {
    super(REPORT_REFUSALS[allowance](required, limit));
    this.name = "MavenGradleMetadataReportFailure";
  }
}
