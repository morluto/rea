import {
  projectArtifactIntegrityDetails,
  type ArtifactIntegrityDetails,
} from "./artifactIntegrity.js";
import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "./analysisErrorBase.js";
import type { ArtifactReaderLimitFact } from "./artifactReaderLimits.js";
import type { FixedAllowance } from "./fixedAllowanceRemediation.js";
import type { LimitRef, ParseFailureKind } from "./parseFailure.js";

/** The resource class that refused an artifact operation. */
export type ArtifactLimitBoundary = "file-size" | "capacity" | "memory";

/** Admission named by the producing reader, with its effective byte ceiling and its source. */
export interface ArtifactAdmissionLimit {
  readonly kind: "asar-header" | "asar-listing";
  readonly requiredBytes?: number;
  readonly maximumBytes: number;
  readonly source: "default" | "setting" | "runtime";
}

/**
 * Which consistency check an `integrity` failure tripped, so consumers need
 * not read the message: a member the reader did not produce, member metadata
 * that differs from inventory, a container or unpacked file whose identity
 * changed, a directory or archive member whose file identity or bytes
 * changed since inventory, short read coverage, bytes disagreeing with the
 * declared size, a disk image whose stored checksum does not verify, a read
 * stream over a handle the reader does not own, a format-declared digest or
 * checksum that disagrees with content or cannot be checked, layout sources
 * (structural index, tool listing, region table) that are malformed, disagree
 * or place an entry outside the artifact, entries that do not reassemble into
 * the source, an inventory node or verified state a later read relies on
 * that is missing, output bytes that do not read back as written, or an
 * output tree used after commit or whose cleanup could not be verified,
 * or a verification traversal that did not reproduce every inventoried entry.
 */
export const ARTIFACT_INTEGRITY_CHECKS = [
  "foreign-entry",
  "entry-metadata",
  "container-identity",
  "unpacked-entry-identity",
  "member-identity",
  "image-checksum",
  "read-coverage",
  "declared-size",
  "reader-ownership",
  "declared-digest",
  "layout-consistency",
  "reconstruction",
  "inventory-node",
  "output-readback",
  "output-lifecycle",
  "traversal-coverage",
] as const;
export type ArtifactIntegrityCheck = (typeof ARTIFACT_INTEGRITY_CHECKS)[number];

/** Artifact inventory or extraction failed a typed safety boundary. */
export class ArtifactOperationError extends AnalysisError {
  readonly _tag = "ArtifactOperationError";
  override readonly userMessage: string | undefined;
  readonly remediationAction: string | undefined;
  readonly admission: ArtifactAdmissionLimit | undefined;
  readonly boundary: ArtifactLimitBoundary | undefined;
  readonly readerLimit: ArtifactReaderLimitFact | undefined;
  readonly parserLimit: LimitRef | undefined;
  /** For a `limit` reason, the release-fixed allowance that refused the input. */
  readonly fixedAllowance: FixedAllowance | undefined;
  /** For an `integrity` reason, the check the producing reader named. */
  readonly integrityCheck: ArtifactIntegrityCheck | undefined;

  constructor(
    readonly operation:
      | "inventory_artifact"
      | "inspect_artifact"
      | "inspect_desktop_application"
      | "inspect_pe_resources"
      | "inspect_pe_certificates"
      | "inspect_elf_notes"
      | "inspect_dwarf_units"
      | "inspect_elf_debug_link"
      | "inspect_elf_unwind_ranges"
      | "inspect_devicetree"
      | "inspect_ntfs_journal"
      | "inspect_api_contract"
      | "inspect_warc_archive"
      | "inspect_playwright_trace"
      | "inspect_kernel_module"
      | "inspect_elf_dependencies"
      | "inspect_kernel_build_config"
      | "inspect_erlang_beam"
      | "inspect_nuget_nupkg"
      | "inspect_v8_code_cache"
      | "inspect_maven_gradle_metadata"
      | "extract_artifact"
      | "decode_interface_builder"
      | "inspect_asset_catalog"
      | "inspect_keyed_archive"
      | "trace_dylib_resolution"
      | "export_web_scripts"
      | "trace_web_module_imports"
      | "trace_web_source_location"
      | "analyze_javascript_application",
    readonly reason:
      | ParseFailureKind
      | "cancelled"
      | "format"
      | "integrity"
      | "path"
      | "unavailable"
      | "io",
    readonly artifactDetails?: ArtifactIntegrityDetails,
    /** The specific constraint that failed, such as the colliding path. */
    readonly detail?: string,
    options?: AnalysisErrorOptions & {
      readonly userMessage?: string;
      readonly remediationAction?: string;
      readonly admission?: ArtifactAdmissionLimit;
      readonly boundary?: ArtifactLimitBoundary;
      readonly readerLimit?: ArtifactReaderLimitFact;
      readonly parserLimit?: LimitRef;
      readonly fixedAllowance?: FixedAllowance;
      readonly integrityCheck?: ArtifactIntegrityCheck;
    },
  ) {
    super(
      artifactDetails === undefined
        ? `Artifact ${operation} failed: ${reason}`
        : artifactDetailsMessage(operation, reason, artifactDetails),
      options,
    );
    this.admission = options?.admission;
    this.boundary = options?.boundary;
    this.readerLimit = options?.readerLimit;
    this.parserLimit = options?.parserLimit;
    this.fixedAllowance = options?.fixedAllowance;
    this.integrityCheck = options?.integrityCheck;
    this.remediationAction = options?.remediationAction;
    this.userMessage =
      options?.userMessage ??
      (options?.admission === undefined ? undefined : detail);
  }
}

const artifactDetailsMessage = (
  operation: string,
  reason: string,
  details: ArtifactIntegrityDetails,
): string => {
  const { logical_path, ...facts } = projectArtifactIntegrityDetails(details);
  const description = Object.entries(facts)
    .map(([key, value]) => `${key}=${String(value ?? "unavailable")}`)
    .join(", ");
  return `Artifact ${operation} failed: ${reason} at ${logical_path} (${description})`;
};
