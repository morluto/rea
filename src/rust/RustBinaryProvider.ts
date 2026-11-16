import { producerLimitControl } from "../domain/producerResourceLimits.js";
import { RUST_BINARY_PROVIDER_IDENTITY } from "./RustBinaryProviderIdentity.js";
import {
  projectSelectedArtifactFileFailure,
  projectStableArtifactFailure,
  stableArtifactInputFailure,
  projectArtifactCloseFailure,
  readerIntegrityFailure,
  type StableArtifactSnapshot,
  readStableArtifact,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  artifactFileCancellationCause,
  assertArtifactReadActive,
  ArtifactResourceScope,
  ArtifactReaderFailure,
} from "../resources/index.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import type { RustBinaryPort } from "../ports/rust/RustBinaryPort.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import {
  RUST_AUDITABLE_FORMAT_VERSIONS,
  rustBinarySchema,
  rustcPartialCoverage,
  type InspectRustBinaryInput,
  type RustBinary,
} from "../domain/rust/rustBinary.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  readRustBinaryImage,
  type RustBinaryImage,
} from "./RustBinaryImage.js";
import { requireSelectedNativeImage } from "../domain/apple/machoSliceSelection.js";
import { RustAuditableResourceFailure } from "./RustAuditableReader.js";
import { parseFailureAnalysisError } from "../domain/parseFailureAnalysisError.js";

import {
  RUST_PRODUCER_DEFAULTS,
  resolveRustProducerLimits,
  rustProducerLimitsSchema,
  type RustProducerLimits,
} from "../domain/rust/rustResourceLimits.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { errorMessage } from "../kernel/errorMessage.js";

const OPERATION = "inspect_rust_binary";

/** Stable in-process dependency inspection without subprocesses, temporary files, or a Rust toolchain. */
export class RustBinaryProvider implements RustBinaryPort {
  readonly identity = RUST_BINARY_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        RUST_BINARY_PROVIDER_IDENTITY.id,
        OPERATION,
      );
    }
  }

  /** Read one dependency section and any inferred rustc commit from the selected file. */
  async inspect(
    input: InspectRustBinaryInput,
    options?: ExecutionOptions,
  ): Promise<Result<RustBinary, AnalysisError>> {
    let snapshot: StableArtifactSnapshot | undefined;
    const selectedLimits = rustProducerLimitsSchema.safeParse(
      input.producer_limits === undefined ? {} : input.producer_limits,
    );
    if (!selectedLimits.success)
      return err(
        analysisInputErrorFromIssues(
          OPERATION,
          selectedLimits.error.issues.map((issue) => ({
            ...issue,
            path: ["producer_limits", ...issue.path],
          })),
          input,
        ),
      );
    const limits = resolveRustProducerLimits(selectedLimits.data);
    try {
      return await this.#resources.run(async () => {
        snapshot = await readStableArtifact(
          input.path,
          limits.input_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        assertArtifactReadActive(options?.signal);
        const selected = requireSelectedNativeImage(
          OPERATION,
          input.path,
          snapshot.bytes,
          input.architecture,
        );
        const image = inFile(
          readRustBinaryImage(
            selected.bytes,
            input.max_rustc_hashes,
            limits.output_bytes,
          ),
          selected.fileOffset,
        );
        const report: RustBinary = {
          format: image.format,
          architecture: image.architecture,
          bits: image.bits,
          byte_order: image.byte_order,
          auditable_metadata: image.auditable_metadata,
          rustc_commit: image.rustc_commit,
          artifact: {
            path: input.path,
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          },
          ...(selected.selection === null
            ? {}
            : { selected_slice: selected.selection }),
          limitations: [
            ...limitationsFor(image),
            `Selected producer_limits.input_bytes=${String(limits.input_bytes)} and output_bytes=${String(limits.output_bytes)} bytes; compressed/inflated dependency parser limits remain independent.`,
            ...selected.limitations,
          ],
        };
        retainCompilerPathsWithinReport(
          report,
          limits.output_bytes,
          rustcLimitation(image.rustc_commit),
        );
        if (
          Buffer.byteLength(JSON.stringify(report), "utf8") >
          limits.output_bytes
        )
          throw outputLimit(input.path, limits.output_bytes);
        const parsed = rustBinarySchema.safeParse(report);
        if (!parsed.success)
          throw new AnalysisOutputError(
            OPERATION,
            "Rust reader produced an invalid dependency report.",
            { cause: parsed.error },
          );
        assertArtifactReadActive(options?.signal);
        return ok(parsed.data);
      });
    } catch (cause: unknown) {
      return err(failureFor(cause, input.path, limits, snapshot));
    }
  }
}

/** Locate image-relative section and rustc-path offsets in the selected file. */
const inFile = (image: RustBinaryImage, fileOffset: number): RustBinaryImage =>
  fileOffset === 0
    ? image
    : {
        ...image,
        auditable_metadata:
          image.auditable_metadata === null
            ? null
            : {
                ...image.auditable_metadata,
                file_offset: image.auditable_metadata.file_offset + fileOffset,
              },
        rustc_commit:
          image.rustc_commit === null
            ? null
            : {
                ...image.rustc_commit,
                hashes: image.rustc_commit.hashes.map((entry) => ({
                  ...entry,
                  file_offset: entry.file_offset + fileOffset,
                })),
              },
      };

const outputLimit = (path: string, maxOutputBytes: number) =>
  new AnalysisResourceConstraintError(
    OPERATION,
    "transport",
    `Complete Rust metadata for ${path} exceeds the inline output budget; no partial success is returned.`,
    { maximum_output_bytes: maxOutputBytes },
    {
      retryable: false,
      remediationAction: `Increase producer_limits.output_bytes above ${String(maxOutputBytes)} bytes on the next inspect_rust_binary call; no restart is required. Input, dependency parser and transport limits remain independent. Repeating the unchanged request does not raise admission.`,
      limit: producerLimitControl(
        "output_bytes",
        maxOutputBytes,
        RUST_PRODUCER_DEFAULTS.output_bytes,
      ),
    },
  );

/** Resource-guard guidance delivered with every Rust inspection report. */
const RUST_RESOURCE_GUARD_LIMITATION =
  "Default input and complete-report admission are 256 MiB and 8 MiB; producer_limits.input_bytes/output_bytes select larger or smaller values for the next call without restart. Independent parser guards bound the compressed dependency stream to 1 MiB and inflated JSON to the smaller of 8 MiB and 64 times the consumed compressed-stream length. Report admission applies before package schema cloning, graph objects, or reverse-edge allocation.";

const limitationsFor = (
  image: ReturnType<typeof readRustBinaryImage>,
): string[] => [
  "Embedded dependency metadata is file content. It does not authenticate package names, versions, sources, or the compiler that produced the binary.",
  "Only the .dep-v0 dependency section and read-only compiler path strings are inspected. Functions, types, and runtime behavior are not recovered.",
  RUST_RESOURCE_GUARD_LIMITATION,
  ...(image.section_names_limitation === undefined
    ? []
    : [image.section_names_limitation]),
  ...(image.auditable_metadata === null &&
  image.section_names_limitation === undefined
    ? [
        "No .dep-v0 section was found. Absence of .dep-v0 does not mean the binary has no dependencies.",
      ]
    : []),
  ...(image.auditable_metadata === null &&
  image.section_names_limitation !== undefined
    ? [
        "The presence of .dep-v0 could not be determined because ELF section names are unavailable.",
      ]
    : []),
  ...unknownFormatLimitation(image.auditable_metadata?.format_version),
  ...(image.auditable_metadata?.packages.some((pkg) => pkg.kind === null)
    ? [
        "An omitted package kind is left null. The embedded format treats an omitted kind as runtime, and that default was not stored in the section.",
      ]
    : []),
  ...(image.auditable_metadata !== null &&
  image.auditable_metadata.cyclic_dependency_indices.length > 0
    ? [
        "Dependency indices contain a cycle. The cycle is reported and was not traversed.",
      ]
    : []),
];

const unknownFormatLimitation = (
  format: number | null | undefined,
): string[] => {
  if (format === null || format === undefined) return [];
  let preceding = 0;
  for (const known of RUST_AUDITABLE_FORMAT_VERSIONS) {
    if (known === format) return [];
    if (known < format) preceding = known;
  }
  return [
    `cargo-auditable format revision ${format} is unknown. Its schema directs readers to interpret it using the highest known preceding revision (${preceding}); this specific revision has not been independently verified.`,
  ];
};

const rustcLimitation = (
  commit: ReturnType<typeof readRustBinaryImage>["rustc_commit"],
): string[] => {
  if (commit === null)
    return [
      "No /rustc/<40-hex>/ path was found in read-only data, so a rustc commit hash is unknown.",
    ];
  if (commit.coverage?.reason === "report_bytes")
    return [
      "Compiler-path retention exhausted the complete-report byte allowance; retained hashes are a prefix and compiler coverage is partial. Dependency observations are independent. Raise the control in rustc_commit.coverage.limit on the next call to raise report admission; no restart is required. Increasing max_rustc_hashes alone does not raise it.",
    ];
  if (commit.coverage?.status === "partial")
    return [
      `Compiler-path retention reached max_rustc_hashes=${String(commit.coverage.effective_limit)}; the listed hashes are a prefix and compiler coverage is partial. Raise the control in rustc_commit.coverage.limit on the next call to retain more paths; no restart is required. Dependency observations are independent. The complete-report byte allowance still applies.`,
    ];
  if (commit.hashes.length === 1)
    return [
      "The rustc commit hash is inferred from a /rustc/<40-hex>/ path in read-only data. It does not by itself prove which compiler produced the binary.",
    ];
  return [
    "Read-only data contains more than one /rustc/<40-hex>/ path, so a single rustc commit is unknown.",
  ];
};

/**
 * Optional inferred paths never displace independently observed dependency
 * facts. The compiler guidance describes the retained result: the reader's
 * guidance when it fits; the reader's record and control without that
 * guidance (which restates rustc_commit.coverage) when only the guidance
 * does not fit; otherwise the trimming guidance, which names its control
 * directly because no compiler record may survive. Byte trimming is reported
 * only when it removes a path.
 */
const retainCompilerPathsWithinReport = (
  report: RustBinary,
  maxOutputBytes: number,
  compilerGuidance: readonly string[],
): void => {
  const commit = report.rustc_commit;
  const withGuidance = [...report.limitations, ...compilerGuidance];
  if (
    commit === null ||
    Buffer.byteLength(
      JSON.stringify({ ...report, limitations: withGuidance }),
    ) <= maxOutputBytes
  ) {
    report.limitations = withGuidance;
    return;
  }
  if (Buffer.byteLength(JSON.stringify(report)) <= maxOutputBytes) return;
  const limitation =
    "Compiler paths were omitted to preserve dependency facts within the complete-report byte allowance; compiler-path coverage is partial. Increase producer_limits.output_bytes on the next call; no restart is required. Increasing max_rustc_hashes alone does not raise this allowance.";
  const baseline = {
    ...report,
    rustc_commit: null,
    limitations: [...report.limitations, limitation],
  };
  const empty = {
    ...commit,
    hashes: [],
    coverage: rustcPartialCoverage("report_bytes", maxOutputBytes),
  };
  const available =
    maxOutputBytes -
    Buffer.byteLength(JSON.stringify({ ...baseline, rustc_commit: empty }));
  let retainedBytes = 0;
  let count = 0;
  // The complete record does not fit, so trimming removes at least one path
  // and the byte coverage it records stays true.
  for (const hash of commit.hashes.slice(0, -1)) {
    const bytes =
      Buffer.byteLength(JSON.stringify(hash)) + (count === 0 ? 0 : 1);
    if (bytes > available - retainedBytes) break;
    retainedBytes += bytes;
    count++;
  }
  if (count === 0) {
    // The control stays recorded although no compiler record survives.
    report.rustc_commit = null;
    if (empty.coverage.limit !== undefined)
      report.rustc_commit_omission = {
        reason: "report_bytes",
        limit: empty.coverage.limit,
      };
  } else
    report.rustc_commit = { ...empty, hashes: commit.hashes.slice(0, count) };
  report.limitations = baseline.limitations;
};

const failureForPrimary = (
  facts: ArtifactFilePrimaryFacts,
  path: string,
  limits: RustProducerLimits,
): AnalysisError => {
  const { cause, origin } = facts;
  if (origin === "owned-or-classified" && cause instanceof AnalysisError)
    return cause;
  if (cause instanceof RustAuditableResourceFailure)
    return new AnalysisResourceConstraintError(
      OPERATION,
      cause.constraint.resource,
      `Selected artifact ${path}: ${cause.message}`,
      cause.constraint.reported_limits,
      {
        cause,
        ...(cause.constraint.resource === "transport"
          ? {
              retryable: false,
              remediationAction: `Increase producer_limits.output_bytes above ${String(limits.output_bytes)} bytes on the next call; no restart is required. Compressed/inflated dependency parser and transport limits remain independent.`,
              limit: producerLimitControl(
                "output_bytes",
                limits.output_bytes,
                RUST_PRODUCER_DEFAULTS.output_bytes,
              ),
            }
          : fixedAllowanceOptions(
              "This Rust dependency parser allowance",
              "parser",
            )),
      },
    );
  return (
    parseFailureAnalysisError(OPERATION, path, cause) ??
    artifactFailure(facts, path, limits)
  );
};

const failureFor = (
  cause: unknown,
  path: string,
  limits: RustProducerLimits,
  snapshot?: StableArtifactSnapshot,
): AnalysisError => {
  const primary = failureForPrimary(
    artifactFilePrimaryFacts(cause),
    path,
    limits,
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    path,
    RUST_BINARY_PROVIDER_IDENTITY.id,
    OPERATION,
    snapshot,
  );
};

const artifactFailure = (
  facts: ArtifactFilePrimaryFacts,
  path: string,
  limits: RustProducerLimits,
): AnalysisError => {
  const { cause, origin } = facts;
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  )
    return artifactReaderFailure(cause, path, limits);
  const fileFailure = projectSelectedArtifactFileFailure(
    cause,
    OPERATION,
    path,
    "artifact",
  );
  if (fileFailure !== undefined) return fileFailure;
  return new ProviderAdapterError(RUST_BINARY_PROVIDER_IDENTITY.id, OPERATION, {
    cause,
    diagnostics: {
      path,
      reason: errorMessage(cause),
    },
  });
};

const artifactReaderFailure = (
  cause: ArtifactReaderFailure,
  path: string,
  limits: RustProducerLimits,
): AnalysisError => {
  if (cause.reason === "integrity")
    return readerIntegrityFailure(OPERATION, path, cause);
  if (cause.reason === "cancelled")
    return cancelledBy(
      OPERATION,
      carriedReason(artifactFileCancellationCause(cause)),
    );
  if (cause.reason === "limit")
    return new AnalysisResourceConstraintError(
      OPERATION,
      "file-size",
      cause.message,
      { maximum_input_bytes: limits.input_bytes },
      {
        cause,
        retryable: false,
        remediationAction: `Increase producer_limits.input_bytes above ${String(limits.input_bytes)} bytes on the next inspect_rust_binary call; no restart is required. Select the same complete artifact, without truncating its bytes. Report, dependency parser and host memory limits remain independent.`,
        limit: producerLimitControl(
          "input_bytes",
          limits.input_bytes,
          RUST_PRODUCER_DEFAULTS.input_bytes,
        ),
      },
    );
  if (cause.reason === "path")
    return stableArtifactInputFailure(cause, OPERATION);
  return new ProviderAdapterError(RUST_BINARY_PROVIDER_IDENTITY.id, OPERATION, {
    cause,
    diagnostics: { path, reason: cause.message },
  });
};
