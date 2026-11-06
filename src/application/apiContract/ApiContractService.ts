import { isAbsolute } from "node:path";
import { setImmediate } from "node:timers/promises";
import { getHeapStatistics } from "node:v8";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { jsonValueValidationSteps } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  API_CONTRACT_OPERATION as operation,
  API_CONTRACT_PROVIDER,
} from "../../domain/apiContract/apiContract.js";
import { inspectApiContractInputSchema } from "../../domain/apiContract/apiContractQuery.js";
import { parseApiContractSteps } from "../../domain/apiContract/parseApiContract.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { nativeJsonParseRequiredBytes } from "../JsonInputFile.js";
import { parseUtf8Json } from "../Utf8JsonInput.js";
import { readApiContract } from "./ApiContractRead.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const inputFailure = (message: string, cause?: unknown) =>
  new AnalysisInputError(operation, { cause }, [
    { path: ["path"], reason: "invalid_format", message },
  ]);

/** Cooperative traversals release their provisional state on cancellation. */
const completeSteps = async <Value>(
  steps: Generator<void, Value>,
  signal?: AbortSignal,
): Promise<Result<Value, AnalysisError>> => {
  let completed = false;
  try {
    for (;;) {
      if (signal?.aborted)
        return err(
          new AnalysisCancelledError(operation, { cause: signal.reason }),
        );
      const next = steps.next();
      if (next.done) {
        completed = true;
        // Include cancellation queued during the final synchronous projection.
        await setImmediate();
        return signal?.aborted
          ? err(new AnalysisCancelledError(operation, { cause: signal.reason }))
          : ok(next.value);
      }
      await setImmediate();
    }
  } finally {
    if (!completed) steps.return(undefined as never);
  }
};

const decodeDocument = (
  bytes: Buffer,
  path: string,
): Result<unknown, AnalysisError> => {
  const required = nativeJsonParseRequiredBytes(bytes.length);
  const available = getHeapStatistics().total_available_size;
  if (required > available)
    return err(
      new AnalysisResourceConstraintError(
        operation,
        "memory",
        "Insufficient parser headroom for the admitted JSON representation expansion.",
        {
          input_bytes: bytes.length,
          required_bytes: required,
          available_heap_bytes: available,
        },
        {
          remediationAction:
            "Select a smaller complete document or free parser memory; paging a reply does not reduce JSON parsing work.",
        },
      ),
    );
  try {
    const parsed = parseUtf8Json(bytes, operation, path);
    return parsed.ok
      ? ok(parsed.value)
      : err(inputFailure(parsed.error, parsed.cause));
  } catch (cause: unknown) {
    if (cause instanceof AnalysisError) return err(cause);
    throw cause;
  }
};

/** Shared CLI/MCP import: one verified file read, no references, network or target execution. */
export const inspectApiContractEvidence = async (
  rawInput: unknown,
  resources: ArtifactResourceScope,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const admitted = parseAnalysisInput(
    operation,
    rawInput,
    inspectApiContractInputSchema,
    options.signal,
  );
  if (!admitted.ok) return admitted;
  const input = admitted.value;
  if (!isAbsolute(input.path))
    return err(
      inputFailure("Expected an absolute filesystem path on this host."),
    );
  const source = await readApiContract(input, resources, options.signal);
  if (!source.ok) return source;
  const document = decodeDocument(source.value.bytes, input.path);
  if (!document.ok) return document;
  const validation = await completeSteps(
    jsonValueValidationSteps(document.value),
    options.signal,
  );
  if (!validation.ok) return validation;
  if (validation.value !== undefined)
    return err(inputFailure(validation.value));
  const parsed = await completeSteps(
    parseApiContractSteps(document.value, {
      path: input.path,
      sha256: source.value.sha256,
      bytes: source.value.bytes.length,
    }),
    options.signal,
  );
  if (!parsed.ok) return parsed;
  if (!parsed.value.ok) return parsed.value;
  const result = parsed.value.value;
  return completeProviderEvidence(
    createEvidence(
      { path: input.path, format: "file", sha256: source.value.sha256 },
      API_CONTRACT_PROVIDER,
      {
        operation,
        predicateType: "rea.api-contract-inventory",
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
};
