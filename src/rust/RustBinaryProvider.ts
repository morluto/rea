import { basename } from "node:path";
import { producerLimitControl } from "../domain/producerResourceLimits.js";
import { RUST_BINARY_PROVIDER_IDENTITY } from "./RustBinaryProviderIdentity.js";
import {
  projectStableArtifactFailure,
  closeArtifactResources,
  withStableArtifactHandle,
  artifactFilePrimaryFacts,
  assertArtifactReadActive,
  yieldArtifactRead,
  ArtifactResourceScope,
  ArtifactReaderFailure,
} from "../resources/index.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import type { RustBinaryPort } from "../ports/rust/RustBinaryPort.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../providers/offlineArtifactFailure.js";
import {
  RUST_AUDITABLE_FORMAT_VERSIONS,
  rustBinarySchema,
  rustcPartialCoverage,
  type InspectRustBinaryInput,
  type RustBinary,
} from "../domain/rust/rustBinary.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  readRustBinaryImageFromHandle,
  type RustBinaryImage,
} from "./RustBinaryImage.js";
import { requireSelectedNativeImageFromReader } from "../domain/apple/machoSliceSelection.js";
import {
  RUST_AUDITABLE_FORMAT,
  RUST_AUDITABLE_GRAPH_LIMIT,
} from "./RustAuditableReader.js";
import {
  BinaryResourceFailure,
  binaryResourceCeiling,
} from "../domain/binaryContainer.js";
import { MAX_WASM_SECTIONS, WASM_FORMAT } from "./RustWasmImage.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";

import {
  RUST_PRODUCER_DEFAULTS,
  resolveRustProducerLimits,
  rustProducerLimitsSchema,
  type RustProducerLimits,
} from "../domain/rust/rustResourceLimits.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";

const OPERATION = "inspect_rust_binary";
const HEADER_PREFIX_BYTES = 4096;

/** Stable in-process dependency inspection without subprocesses, temporary files, or a Rust toolchain. */
export class RustBinaryProvider implements RustBinaryPort {
  readonly identity = RUST_BINARY_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      RUST_BINARY_PROVIDER_IDENTITY,
      OPERATION,
    );
  }

  /** Read one dependency section and any inferred rustc commit from the selected file. */
  async inspect(
    input: InspectRustBinaryInput,
    options?: ExecutionOptions,
  ): Promise<Result<RustBinary, AnalysisError>> {
    let completed: RustBinary | undefined;
    let snapshot:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
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
        const parsedData = await withStableArtifactHandle<RustBinary>(
          input.path,
          limits.input_bytes,
          {
            signal: options?.signal,
            resourceScope: this.#resources,
            retainBytes: (size) => Math.min(size, HEADER_PREFIX_BYTES),
            onIdentity: (observed) => {
              snapshot = observed;
            },
            onVerifiedResult: (report) => {
              completed = report;
            },
          },
          async (handle) => {
            assertArtifactReadActive(options?.signal);
            const selected = await requireSelectedNativeImageFromReader(
              OPERATION,
              input.path,
              handle,
              input.architecture,
            );
            const image = inFile(
              await readRustBinaryImageFromHandle(
                selected.source,
                input.max_rustc_hashes,
                limits.output_bytes,
                () => yieldArtifactRead(options?.signal),
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
                file_name: basename(input.path),
                sha256: handle.sha256,
                bytes: handle.size,
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
            if (
              !fitCompilerPathsWithinReport(
                report,
                limits.output_bytes,
                rustcLimitation(image.rustc_commit, image.format),
              )
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
            return parsed.data;
          },
        );
        return ok(parsedData);
      });
    } catch (cause: unknown) {
      return err(failureFor(cause, input.path, limits, snapshot, completed));
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

const limitationsFor = (image: RustBinaryImage): string[] => [
  "Embedded dependency metadata is file content. It does not authenticate package names, versions, sources, or the compiler that produced the binary.",
  `Only the .dep-v0 dependency section and compiler path strings in ${compilerPathSource(image.format)} are inspected. Functions, types, and runtime behavior are not recovered.`,
  ...(image.format === "wasm"
    ? [
        `WebAssembly declares no container word size, so bits is null. Memory address types were not inspected. At most ${MAX_WASM_SECTIONS} section payloads are examined.`,
      ]
    : []),
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

/** rustc keeps constant path strings in native read-only data or WebAssembly data segments. */
const compilerPathSource = (format: RustBinary["format"]): string =>
  format === "wasm" ? "the WebAssembly data section" : "read-only data";

const rustcLimitation = (
  commit: RustBinaryImage["rustc_commit"],
  format: RustBinary["format"],
): string[] => {
  const source = compilerPathSource(format);
  if (commit === null)
    return [
      `No /rustc/<40-hex>/ path was found in ${source}, so a rustc commit hash is unknown.`,
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
      `The rustc commit hash is inferred from a /rustc/<40-hex>/ path in ${source}. It does not by itself prove which compiler produced the binary.`,
    ];
  return [
    `More than one /rustc/<40-hex>/ path was found in ${source}, so a single rustc commit is unknown.`,
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
const fitCompilerPathsWithinReport = (
  report: RustBinary,
  maxOutputBytes: number,
  compilerGuidance: readonly string[],
): boolean => {
  const commit = report.rustc_commit;
  const originalLimitations = report.limitations;
  report.limitations = [...originalLimitations, ...compilerGuidance];
  if (Buffer.byteLength(JSON.stringify(report)) <= maxOutputBytes) return true;
  if (commit === null) return false;

  report.limitations = originalLimitations;
  if (Buffer.byteLength(JSON.stringify(report)) <= maxOutputBytes) return true;
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
  return Buffer.byteLength(JSON.stringify(report)) <= maxOutputBytes;
};

const failureFor = (
  cause: unknown,
  path: string,
  limits: RustProducerLimits,
  snapshot: { readonly sha256: string; readonly bytes: number } | undefined,
  completed: RustBinary | undefined,
): AnalysisError => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: RUST_BINARY_PROVIDER_IDENTITY.id,
      operation: OPERATION,
      path,
      description: "artifact",
      recognise: (failure, origin) => {
        if (failure instanceof BinaryResourceFailure)
          return parseLimitConstraint(OPERATION, "memory", failure, {
            path,
            legacyMaximumKey: "maximum_bytes",
            ...fixedAllowanceOptions(
              "This native container parser allowance",
              "parser",
              binaryResourceCeiling(failure),
            ),
          });
        if (isParseLimit(failure, RUST_AUDITABLE_FORMAT)) {
          const { name, maximum } = failure.failure.limit;
          if (name === RUST_AUDITABLE_GRAPH_LIMIT)
            return parseLimitConstraint(OPERATION, "transport", failure, {
              path,
              legacyMaximumKey: "maximum_output_bytes",
              retryable: false,
              remediationAction: `Increase producer_limits.output_bytes above ${String(maximum)} bytes on the next call; no restart is required. Compressed/inflated dependency parser and transport limits remain independent.`,
              limit: producerLimitControl(
                "output_bytes",
                maximum,
                RUST_PRODUCER_DEFAULTS.output_bytes,
              ),
            });
          return parseLimitConstraint(OPERATION, "memory", failure, {
            path,
            legacyMaximumKey: "maximum_bytes",
            ...fixedAllowanceOptions(
              "This Rust dependency parser allowance",
              "parser",
              {
                limit: maximum,
                unit: "bytes",
              },
            ),
          });
        }
        if (isParseLimit(failure, WASM_FORMAT))
          return parseLimitConstraint(OPERATION, "cpu", failure, {
            path,
            ...fixedAllowanceOptions(
              "The WebAssembly section-walk allowance",
              "work",
              { limit: failure.failure.limit.maximum, unit: "sections" },
            ),
          });
        if (
          origin === "owned-or-classified" &&
          failure instanceof ArtifactReaderFailure &&
          failure.reason === "limit"
        )
          return new AnalysisResourceConstraintError(
            OPERATION,
            "file-size",
            failure.message,
            { maximum_input_bytes: limits.input_bytes },
            {
              cause: failure,
              retryable: false,
              remediationAction: `Increase producer_limits.input_bytes above ${String(limits.input_bytes)} bytes on the next inspect_rust_binary call; no restart is required. Select the same complete artifact, without truncating its bytes. Report, dependency parser and host memory limits remain independent.`,
              limit: producerLimitControl(
                "input_bytes",
                limits.input_bytes,
                RUST_PRODUCER_DEFAULTS.input_bytes,
              ),
            },
          );
        return undefined;
      },
    }),
  );
  if (completed !== undefined) primary.retainPartialObservation(completed);
  return projectStableArtifactFailure(
    cause,
    primary,
    path,
    RUST_BINARY_PROVIDER_IDENTITY.id,
    OPERATION,
    snapshot,
  );
};
