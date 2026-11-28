import { isAbsolute } from "node:path";
import { decodeStrictUtf8 } from "../../domain/strictUtf8.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import { decodeLimit, isHostLimitFailure } from "../../domain/parseFailure.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import { constants } from "node:buffer";
import {
  ArtifactReaderFailure,
  artifactReaderTargetFailure,
  projectStableArtifactFailure,
  readStableArtifact,
  stableArtifactInputRecovery,
  type ArtifactResourceScope,
} from "../../resources/index.js";
import type {
  AnalysisError,
  AnalysisErrorOptions,
} from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import {
  OTLP_TRACE_DEFAULT_ATTRIBUTES,
  OTLP_TRACE_DEFAULT_SPANS,
  OTLP_TRACE_MAX_FILE_BYTES,
  OTLP_TRACE_OPERATION as operation,
  OTLP_TRACE_PROVIDER,
  type OtlpTrace,
  type OtlpTraceArtifact,
} from "../../domain/otlpTrace/otlpTrace.js";
import {
  inspectOtlpTraceInputSchema,
  type InspectOtlpTraceInput as OtlpTraceRequest,
} from "../../domain/otlpTrace/otlpTraceQuery.js";
import { parseOtlpTrace } from "../../domain/otlpTrace/parseOtlpTrace.js";
import { countJsonValues } from "../../domain/jsonValue.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { err, ok, type Result } from "../../domain/result.js";
import { isSelectedRegularFileError } from "../../filesystem/RegularFile.js";
import {
  callerAnalysisParameters,
  parseAnalysisInput,
} from "../AnalysisInput.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { OTLP_MAX_LOSSY_FIELDS, scanOtlpNumbers } from "./scanOtlpNumbers.js";

interface OtlpTraceAllowances {
  readonly max_file_bytes: number;
  readonly max_spans: number;
  readonly max_attributes: number;
}

type InspectOtlpTraceInput = OtlpTraceAllowances &
  Pick<OtlpTraceRequest, "path">;

const inputFailure = (
  message: string,
  cause?: unknown,
  details?: AnalysisErrorOptions,
) =>
  new AnalysisInputError(
    operation,
    {
      ...details,
      cause,
      ...(isSelectedRegularFileError(cause)
        ? {
            conformsToInputContract: true,
            remediationAction:
              "Check that the selected path exists and is a readable regular file on the host running REA.",
          }
        : {}),
      ...(cause instanceof ArtifactReaderFailure
        ? stableArtifactInputRecovery(cause)
        : {}),
    },
    [{ path: ["path"], reason: "invalid_format", message }],
  );

/** Check the source number, not only its already-rounded JavaScript value. */
const isExactIntegerNumber = (value: number, source: unknown): boolean => {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    typeof source !== "string" ||
    source.length > 256
  )
    return false;
  if (/^-?(?:0|[1-9][0-9]*)$/u.test(source)) return source === String(value);
  const match =
    /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u.exec(source);
  if (match === null) return false;
  const digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+/u, "");
  if (digits === "") return value === 0;
  const scale = Number(match[4] ?? "0") - (match[3]?.length ?? 0);
  if (!Number.isSafeInteger(scale)) return false;
  let integer = digits;
  if (scale < 0) {
    const removed = -scale;
    if (removed >= digits.length || !/^0*$/u.test(digits.slice(-removed)))
      return false;
    integer = digits.slice(0, -removed);
  } else {
    if (digits.length + scale > 16) return false;
    integer += "0".repeat(scale);
  }
  if (integer.length > 16) return false;
  const exact = BigInt(integer) * (match[1] === "-" ? -1n : 1n);
  return exact === BigInt(value);
};

// Small JSON tokens can dominate heap use while fitting the file byte limit.
const MAX_OTLP_JSON_VALUES = 1_000_000;

const decodeExport = (
  bytes: Buffer,
  path: string,
  limits: OtlpTraceAllowances,
): Result<
  { document: unknown; lossyNumber: (holder: object, key: string) => boolean },
  AnalysisError
> => {
  if (bytes.includes(0))
    return err(
      inputFailure(
        "Export bytes contain a NUL byte, so the file is not JSON text.",
      ),
    );
  let text: string;
  try {
    text = decodeStrictUtf8(bytes, "strip-signature");
  } catch (cause: unknown) {
    return err(
      inputFailure(`Export at ${path} is not valid UTF-8 JSON text.`, cause),
    );
  }
  if (text.length > constants.MAX_STRING_LENGTH)
    return err(
      inputFailure(
        `Export at ${path} exceeds the maximum in-memory string length.`,
      ),
    );
  if (countJsonValues(text, MAX_OTLP_JSON_VALUES) > MAX_OTLP_JSON_VALUES)
    return err(
      parseLimitConstraint(
        operation,
        "memory",
        decodeLimit(
          "otlp-trace",
          "The OTLP document contains too many JSON values to allocate and retain safely.",
          { name: "max_json_values", maximum: MAX_OTLP_JSON_VALUES },
        ),
        fixedAllowanceOptions(
          "The OTLP JSON representation allowance",
          "parser",
          {
            limit: MAX_OTLP_JSON_VALUES,
            unit: "values",
          },
        ),
      ),
    );
  try {
    // If there are no escapes and no numeric candidate at a key the reader
    // consumes — whether as a parsed number or as retained raw evidence — the
    // native fast parser cannot lose an integer. Escaped keys must take the
    // loss-aware path even when no literal matches.
    if (
      !text.includes("\\") &&
      !/"(?:parentSpanId|startTimeUnixNano|endTimeUnixNano|intValue|stringValue|boolValue|bytesValue)"\s*:\s*-?[0-9]/u.test(
        text,
      )
    )
      return ok({ document: JSON.parse(text), lossyNumber: () => false });
    const document: unknown = JSON.parse(text);
    return {
      ok: true,
      value: {
        document,
        lossyNumber: scanOtlpNumbers(
          text,
          document,
          isExactIntegerNumber,
          limits,
        ),
      },
    };
  } catch (cause: unknown) {
    if (isParseLimit(cause, "otlp-trace"))
      return err(
        parseLimitConstraint(operation, "memory", cause, {
          ...fixedAllowanceOptions(
            "The OTLP imprecise-numeric-field allowance",
            "parser",
            { limit: OTLP_MAX_LOSSY_FIELDS, unit: "fields" },
          ),
        }),
      );
    return err(
      inputFailure(
        isHostLimitFailure(cause)
          ? "The export exceeds the JSON decoder's nesting capacity."
          : "Export is not valid JSON.",
        cause,
      ),
    );
  }
};

const readExport = async (
  input: InspectOtlpTraceInput,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<Result<{ bytes: Buffer; sha256: string }, AnalysisError>> => {
  try {
    const source = await resources.run(() =>
      readStableArtifact(
        input.path,
        input.max_file_bytes,
        signal,
        undefined,
        resources,
      ),
    );
    return ok(source);
  } catch (failure: unknown) {
    const primary = classifyProviderFailure(failure, {
      providerId: OTLP_TRACE_PROVIDER.id,
      operation,
      recognise: (cause, details) =>
        isSelectedRegularFileError(cause)
          ? inputFailure(
              `Selected trace could not be read (${cause.code}): ${input.path}`,
              cause,
              details,
            )
          : artifactReaderTargetFailure(operation, input.path, cause),
      file: {
        path: input.path,
        description: "OTLP export",
        fileSize: (cause, details) =>
          parseLimitConstraint(
            operation,
            "file-size",
            decodeLimit(
              "otlp-trace",
              cause.message,
              {
                name: "max_file_bytes",
                maximum: input.max_file_bytes,
              },
              { cause },
            ),
            {
              ...details,
              legacyMaximumKey: "max_file_bytes",
              retryable: false,
              limit: {
                control_kind: "parameter",
                parameter: "max_file_bytes",
                effective_value: input.max_file_bytes,
                unit: "bytes",
                minimum: 1,
                maximum: OTLP_TRACE_MAX_FILE_BYTES,
                default_value: OTLP_TRACE_MAX_FILE_BYTES,
                applies_at: "next_call",
                ...(cause.observedBytes !== undefined &&
                cause.observedBytes <= BigInt(Number.MAX_SAFE_INTEGER)
                  ? { required_value: Number(cause.observedBytes) }
                  : {}),
              },
            },
          ),
      },
      unclassified: (cause, details) =>
        new ArtifactOperationError(
          operation,
          "io",
          undefined,
          "Export read failed.",
          { ...details, cause },
        ),
    });
    return err(
      projectStableArtifactFailure(
        failure,
        primary,
        input.path,
        OTLP_TRACE_PROVIDER.id,
        operation,
      ),
    );
  }
};

/** Shared CLI/MCP import: one verified file read, no collector, network or target execution. */
export interface OtlpTraceInspection {
  readonly evidence: Evidence;
  /** Observations completed before a cancellation, retained as partial evidence. */
  readonly observation: OtlpTrace["artifact"];
}

export const inspectOtlpTraceEvidence = async (
  rawInput: unknown,
  resources: ArtifactResourceScope,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Result<OtlpTraceInspection, AnalysisError>> => {
  const admitted = parseAnalysisInput(
    operation,
    rawInput,
    inspectOtlpTraceInputSchema,
    options.signal,
  );
  if (!admitted.ok) return admitted;
  const selectedParameters = callerAnalysisParameters(rawInput)(admitted.value);
  const input: InspectOtlpTraceInput = {
    path: admitted.value.path,
    max_file_bytes: admitted.value.max_file_bytes ?? OTLP_TRACE_MAX_FILE_BYTES,
    max_spans: admitted.value.max_spans ?? OTLP_TRACE_DEFAULT_SPANS,
    max_attributes:
      admitted.value.max_attributes ?? OTLP_TRACE_DEFAULT_ATTRIBUTES,
  };
  if (!isAbsolute(input.path))
    return err(
      inputFailure("Expected an absolute filesystem path on this host."),
    );
  const source = await readExport(input, resources, options.signal);
  if (!source.ok) return source;
  const { bytes, sha256 } = source.value;
  // The verified read is a completed observation; keep it even when the later
  // decode or inventory fails, so a malformed export still names its file.
  const retain = <T>(result: Result<T, AnalysisError>) => {
    if (!result.ok)
      result.error.retainPartialObservation({
        kind: "file-snapshot-hash",
        path: input.path,
        sha256,
        bytes: bytes.length,
      });
    return result;
  };
  const document = retain(decodeExport(bytes, input.path, input));
  if (!document.ok) return document;
  const artifact: OtlpTraceArtifact = {
    path: input.path,
    sha256,
    bytes: bytes.length,
  };
  const parsed = parseOtlpTrace(document.value.document, artifact, {
    lossyNumber: document.value.lossyNumber,
    maxSpans: input.max_spans,
    maxAttributes: input.max_attributes,
  });
  if (!parsed.ok) return retain(err(inputFailure(parsed.problem)));
  const result = parsed.value;
  const evidence = await completeProviderEvidence(
    createEvidence(
      { path: input.path, format: "file", sha256 },
      OTLP_TRACE_PROVIDER,
      {
        operation,
        predicateType: "rea.otlp-trace-inventory",
        parameters: selectedParameters,
        result,
        confidence: "observed",
        limitations: result.limitations,
        locations: [{ kind: "artifact-path", path: input.path }],
      },
    ),
    options.signal,
  );
  return evidence.ok
    ? ok({ evidence: evidence.value, observation: artifact })
    : evidence;
};
