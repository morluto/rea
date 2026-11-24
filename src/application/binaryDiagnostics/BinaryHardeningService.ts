import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { BinaryHardeningPort } from "../../ports/binaryDiagnostics/BinaryHardeningPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  BINARY_HARDENING_LIMITATIONS,
  binaryHardeningSchema,
  hardeningPropertiesFor,
  inspectBinaryHardeningInputSchema,
  type BinaryHardening,
  type BinaryHardeningImage,
  type InspectBinaryHardeningInput,
} from "../../domain/native/binaryHardening.js";
import type { Result } from "../../domain/result.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_binary_hardening";

/** Shared caller validation, output parsing, and Evidence provenance. */
export class BinaryHardeningService {
  constructor(readonly provider: BinaryHardeningPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectBinaryHardeningInputSchema,
        outputSchema: binaryHardeningSchema,
        provider: this.provider,
        invalidOutputMessage:
          "Binary hardening provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          validReport(report, parameters),
        buildEvidence: (value, identity, parameters) => {
          // Several slices have no single family; each image keeps its own.
          const architecture =
            value.images.length === 1 ? value.images[0]?.architecture : null;
          const format =
            value.format === "mach-o" &&
            value.images.some((image) => image.slice !== null)
              ? "mach-o-universal"
              : value.format;
          const located = (start: number, end: number) =>
            fileOffsetRange(start, end, value.artifact.bytes);
          const locations = [
            { kind: "artifact-path" as const, path: value.artifact.path },
            ...value.images.flatMap((image) => {
              const slice =
                image.slice === null
                  ? undefined
                  : located(
                      image.slice.file_offset,
                      image.slice.file_offset + image.slice.size,
                    );
              const rows = image.rows.flatMap((entry) => {
                if (entry.location === null) return [];
                const range = located(
                  entry.location.offset,
                  entry.location.offset + entry.location.bytes,
                );
                return range === undefined ? [] : [range];
              });
              return slice === undefined ? rows : [slice, ...rows];
            }),
          ];
          const derived = value.images.some((image) =>
            image.rows.some((entry) => entry.confidence === "derived"),
          );
          return createEvidence(
            {
              path: value.artifact.path,
              format,
              sha256: value.artifact.sha256,
              ...(architecture === null || architecture === undefined
                ? {}
                : { architecture }),
            },
            identity,
            {
              operation: OPERATION,
              parameters,
              result: value,
              confidence: derived ? "derived" : "observed",
              limitations: value.limitations,
              locations,
            },
          );
        },
      },
      rawInput,
      options,
    );
  }
}

/** Drop empty, overflowing, or out-of-file ranges instead of citing them. */
const fileOffsetRange = (
  start: number,
  end: number,
  bytes: number,
):
  | {
      readonly kind: "file-offset-range";
      readonly start: number;
      readonly end: number;
    }
  | undefined => {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > bytes
  )
    return undefined;
  return { kind: "file-offset-range", start, end };
};

const sameLimitations = (limitations: readonly string[]): boolean =>
  limitations.length === BINARY_HARDENING_LIMITATIONS.length &&
  limitations.every(
    (entry, index) => entry === BINARY_HARDENING_LIMITATIONS[index],
  );

const validImage = (
  image: BinaryHardeningImage,
  format: BinaryHardening["format"],
  bytes: number,
  requireSlice: boolean,
): boolean => {
  if (image.format !== format) return false;
  if (
    format !== "mach-o" &&
    (image.slice !== null || image.status !== "parsed")
  )
    return false;
  if (requireSlice && image.slice === null) return false;
  if (image.slice !== null && image.status === "parsed") {
    const end = image.slice.file_offset + image.slice.size;
    if (image.slice.size < 1 || image.slice.file_offset > bytes || end > bytes)
      return false;
  }
  if (image.status !== "parsed")
    return (
      format === "mach-o" &&
      image.slice !== null &&
      image.rows.length === 0 &&
      image.reason !== null &&
      (image.status === "malformed" || image.status === "unknown")
    );
  if (image.reason !== null) return false;
  const expected = hardeningPropertiesFor(format);
  if (
    image.rows.length !== expected.length ||
    image.rows.some((entry, index) => entry.property !== expected[index])
  )
    return false;
  return image.rows.every((entry) => {
    if (entry.property === "hardened_runtime")
      return (
        entry.state === "unknown" && entry.next_probe === "inspect_signature"
      );
    if (entry.next_probe !== null) return false;
    if (entry.location === null) return true;
    return (
      entry.location.offset <= bytes - entry.location.bytes &&
      entry.location.offset + entry.location.bytes <= bytes
    );
  });
};

const validReport = (
  report: BinaryHardening,
  input: InspectBinaryHardeningInput,
): boolean =>
  sameLimitations(report.limitations) &&
  report.images.length >= 1 &&
  report.images.every((image) =>
    validImage(
      image,
      report.format,
      report.artifact.bytes,
      report.images.length > 1,
    ),
  );
