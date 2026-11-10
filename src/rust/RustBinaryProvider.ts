import { RUST_BINARY_PROVIDER_IDENTITY } from "./RustBinaryProviderIdentity.js";
import {
  projectStableArtifactFailure,
  stableArtifactInputRecovery,
  projectArtifactCloseFailure,
} from "../artifacts/StableArtifactFailure.js";
import { isSelectedRegularFileError } from "../filesystem/RegularFile.js";
import {
  type StableArtifactSnapshot,
  readStableArtifact,
} from "../artifacts/readStableArtifact.js";
import {
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  artifactFileCancellationCause,
  assertArtifactReadActive,
} from "../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { RustBinaryPort } from "../application/rust/RustBinaryPort.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import {
  RUST_AUDITABLE_FORMAT_VERSIONS,
  rustBinarySchema,
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
import { requireSelectedNativeImage } from "../native/metadata/MachoSliceSelection.js";
import {
  RustAuditableFormatFailure,
  RustAuditableResourceFailure,
} from "./RustAuditableReader.js";

import {
  resolveRustProducerLimits,
  rustProducerLimitsSchema,
  type RustProducerLimits,
} from "../domain/rust/rustResourceLimits.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";

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
        retainCompilerPathsWithinReport(report, limits.output_bytes);
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
      remediationAction: `Increase producer_limits.output_bytes above ${String(maxOutputBytes)} bytes on the next inspect_rust_binary call (CLI --producer-limits JSON); no restart is required. Input, dependency parser and transport limits remain independent. Repeating the unchanged request does not raise admission.`,
    },
  );

/** Resource-guard guidance delivered with every Rust inspection report. */
export const RUST_RESOURCE_GUARD_LIMITATION =
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
  ...rustcLimitation(image.rustc_commit),
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
      "Compiler-path retention exhausted the complete-report byte allowance; retained hashes are a prefix and compiler coverage is partial. Dependency observations are independent. Increase producer_limits.output_bytes on the next call (CLI --producer-limits JSON) to raise report admission; no restart is required. Increasing max_rustc_hashes alone does not raise it.",
    ];
  if (commit.coverage?.status === "partial")
    return [
      `Compiler-path retention reached max_rustc_hashes=${String(commit.coverage.effective_limit)}; the listed hashes are a prefix and compiler coverage is partial. Increase max_rustc_hashes on the next inspect_rust_binary call (CLI --max-rustc-hashes) to retain more paths; no restart is required. Dependency observations are independent. The complete-report byte allowance still applies.`,
    ];
  if (commit.hashes.length === 1)
    return [
      "The rustc commit hash is inferred from a /rustc/<40-hex>/ path in read-only data. It does not by itself prove which compiler produced the binary.",
    ];
  return [
    "Read-only data contains more than one /rustc/<40-hex>/ path, so a single rustc commit is unknown.",
  ];
};

/** Optional inferred paths never displace independently observed dependency facts. */
const retainCompilerPathsWithinReport = (
  report: RustBinary,
  maxOutputBytes: number,
): void => {
  const commit = report.rustc_commit;
  if (
    commit === null ||
    Buffer.byteLength(JSON.stringify(report)) <= maxOutputBytes
  )
    return;
  const limitation =
    "Compiler paths were omitted to preserve dependency facts within the complete-report byte allowance; compiler-path coverage is partial. Increase producer_limits.output_bytes on the next call (CLI --producer-limits JSON); no restart is required. Increasing max_rustc_hashes alone does not raise this allowance.";
  const baseline = {
    ...report,
    rustc_commit: null,
    limitations: [...report.limitations, limitation],
  };
  const empty = {
    ...commit,
    hashes: [],
    coverage: {
      status: "partial" as const,
      reason: "report_bytes" as const,
      effective_limit: maxOutputBytes,
    },
  };
  const available =
    maxOutputBytes -
    Buffer.byteLength(JSON.stringify({ ...baseline, rustc_commit: empty }));
  let retainedBytes = 0;
  let count = 0;
  for (const hash of commit.hashes) {
    const bytes =
      Buffer.byteLength(JSON.stringify(hash)) + (count === 0 ? 0 : 1);
    if (bytes > available - retainedBytes) break;
    retainedBytes += bytes;
    count++;
  }
  report.rustc_commit =
    count === 0 ? null : { ...empty, hashes: commit.hashes.slice(0, count) };
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
              remediationAction: `Increase producer_limits.output_bytes above ${String(limits.output_bytes)} bytes on the next call (CLI --producer-limits JSON); no restart is required. Compressed/inflated dependency parser and transport limits remain independent.`,
            }
          : fixedAllowanceOptions(
              "This Rust dependency parser allowance",
              "parser",
            )),
      },
    );
  if (cause instanceof RustAuditableFormatFailure)
    return cause.kind === "unsupported"
      ? new AnalysisUnsupportedTargetError(OPERATION, path, cause.message, {
          cause,
        })
      : new AnalysisInputError(OPERATION, { cause }, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: `Selected artifact ${path}: ${cause.message}`,
          },
        ]);
  return artifactFailure(facts, path, limits);
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
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
        cause,
      });
    if (isSelectedRegularFileError(cause))
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected artifact could not be read (${String(cause.code)}): ${path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(RUST_BINARY_PROVIDER_IDENTITY.id, OPERATION, {
    cause,
    diagnostics: {
      path,
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

const artifactReaderFailure = (
  cause: ArtifactReaderFailure,
  path: string,
  limits: RustProducerLimits,
): AnalysisError => {
  if (cause.reason === "integrity")
    return new AnalysisArtifactChangedError(OPERATION, path, cause.message, {
      cause,
    });
  if (cause.reason === "cancelled")
    return new AnalysisCancelledError(OPERATION, {
      cause: artifactFileCancellationCause(cause),
    });
  if (cause.reason === "limit")
    return new AnalysisResourceConstraintError(
      OPERATION,
      "file-size",
      cause.message,
      { maximum_input_bytes: limits.input_bytes },
      {
        cause,
        retryable: false,
        remediationAction: `Increase producer_limits.input_bytes above ${String(limits.input_bytes)} bytes on the next inspect_rust_binary call (CLI --producer-limits JSON); no restart is required. Select the same complete artifact, without truncating its bytes. Report, dependency parser and host memory limits remain independent.`,
      },
    );
  if (cause.reason === "path")
    return new AnalysisInputError(
      OPERATION,
      { cause, ...stableArtifactInputRecovery(cause) },
      [{ path: ["path"], reason: "invalid_format", message: cause.message }],
    );
  return new ProviderAdapterError(RUST_BINARY_PROVIDER_IDENTITY.id, OPERATION, {
    cause,
    diagnostics: { path, reason: cause.message },
  });
};
