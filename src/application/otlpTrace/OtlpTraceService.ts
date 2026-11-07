import { isAbsolute } from "node:path";
import { constants } from "node:buffer";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
} from "../../artifacts/ArtifactFileOperation.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import {
  projectStableArtifactFailure,
  stableArtifactInputRecovery,
} from "../../artifacts/StableArtifactFailure.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import {
  OTLP_TRACE_OPERATION as operation,
  OTLP_TRACE_PROVIDER,
  type OtlpTrace,
  type OtlpTraceArtifact,
} from "../../domain/otlpTrace/otlpTrace.js";
import {
  inspectOtlpTraceInputSchema,
  type InspectOtlpTraceInput,
} from "../../domain/otlpTrace/otlpTraceQuery.js";
import { parseOtlpTrace } from "../../domain/otlpTrace/parseOtlpTrace.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { err, ok, type Result } from "../../domain/result.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const inputFailure = (message: string, cause?: unknown) =>
  new AnalysisInputError(
    operation,
    {
      cause,
      ...(cause instanceof ArtifactReaderFailure
        ? stableArtifactInputRecovery(cause)
        : {}),
    },
    [{ path: ["path"], reason: "invalid_format", message }],
  );

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

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

const decodeExport = (
  bytes: Buffer,
  path: string,
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
    text = UTF8.decode(bytes);
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
  try {
    // If there are no escapes and no numeric candidate at any relevant key,
    // the native fast parser cannot lose an integer the OTLP reader consumes.
    // Escaped keys must take the loss-aware path even when no literal matches.
    if (
      !text.includes("\\") &&
      !/"(?:startTimeUnixNano|endTimeUnixNano|intValue)"\s*:\s*-?[0-9]/u.test(
        text,
      )
    )
      return ok({ document: JSON.parse(text), lossyNumber: () => false });
    const lossy = new WeakMap<object, Set<string>>();
    const numericFields = new Set([
      "startTimeUnixNano",
      "endTimeUnixNano",
      "intValue",
    ]);
    const document: unknown = JSON.parse(
      text,
      function (
        this: object,
        key: string,
        value: unknown,
        ...extra: unknown[]
      ) {
        if (numericFields.has(key) && typeof value === "number") {
          const context = extra[0];
          const source =
            typeof context === "object" &&
            context !== null &&
            "source" in context
              ? context.source
              : undefined;
          if (!isExactIntegerNumber(value, source)) {
            const keys = lossy.get(this) ?? new Set<string>();
            keys.add(key);
            lossy.set(this, keys);
          }
        }
        return value;
      },
    );
    return ok({
      document,
      lossyNumber: (holder, key) => lossy.get(holder)?.has(key) === true,
    });
  } catch (cause: unknown) {
    return err(
      inputFailure(
        cause instanceof RangeError
          ? "The export exceeds the JSON decoder's nesting capacity."
          : "Export is not valid JSON.",
        cause,
      ),
    );
  }
};

/** Keep the reader's typed reasons instead of flattening every failure into "io". */
const readFailure = (
  failure: unknown,
  input: InspectOtlpTraceInput,
): AnalysisError => {
  const { cause, origin } = artifactFilePrimaryFacts(failure);
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(operation, {
        cause: artifactFileCancellationCause(cause),
      });
    if (cause.reason === "integrity")
      return new AnalysisArtifactChangedError(
        operation,
        input.path,
        cause.message,
        { cause },
      );
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        operation,
        cause.boundary ?? "file-size",
        cause.message,
        { max_file_bytes: input.max_file_bytes },
        {
          cause,
          retryable: false,
          remediationAction:
            "Select an export within max_file_bytes; paging does not change this file admission.",
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return inputFailure(cause.message, cause);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(operation, input.path, cause.code, {
        cause,
      });
  }
  return new ArtifactOperationError(
    operation,
    "io",
    undefined,
    "Export read failed.",
    { cause: failure },
  );
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
    const primary = readFailure(failure, input);
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
  const input = admitted.value;
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
  const document = retain(decodeExport(bytes, input.path));
  if (!document.ok) return document;
  const artifact: OtlpTraceArtifact = {
    path: input.path,
    sha256,
    bytes: bytes.length,
  };
  const parsed = parseOtlpTrace(document.value.document, artifact, {
    lossyNumber: document.value.lossyNumber,
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
        parameters: {
          path: input.path,
          format: input.format,
          max_file_bytes: input.max_file_bytes,
        },
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
