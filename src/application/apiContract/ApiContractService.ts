import { getHeapStatistics } from "node:v8";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { jsonValueValidationSteps } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  API_CONTRACT_OPERATION as operation,
  API_CONTRACT_PROVIDER,
  apiContractSchema,
  type ApiContract,
  type ApiContractArtifact,
} from "../../domain/apiContract/apiContract.js";
import {
  inspectApiContractInputSchema,
  type InspectApiContractInput,
} from "../../domain/apiContract/apiContractQuery.js";
import { parseApiContractSteps } from "../../domain/apiContract/parseApiContract.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { nativeJsonParseRequiredBytes } from "../JsonInputFile.js";
import { parseUtf8Json } from "../Utf8JsonInput.js";
import { readApiContract } from "./ApiContractRead.js";
import { completeApiContractSteps } from "./ApiContractTraversal.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const inputFailure = (message: string, cause?: unknown) =>
  new AnalysisInputError(operation, { cause }, [
    { path: ["path"], reason: "invalid_format", message },
  ]);

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

function* documentSteps(document: unknown, artifact: ApiContractArtifact) {
  const issue = yield* jsonValueValidationSteps(document);
  if (issue !== undefined) return err(inputFailure(issue));
  return yield* parseApiContractSteps(document, artifact);
}

type OpenApiInput = Extract<
  InspectApiContractInput,
  { format: "openapi-json" }
>;

const documentEvidence = (input: OpenApiInput, result: ApiContract): Evidence =>
  createEvidence(
    { path: input.path, format: "file", sha256: result.artifact.sha256 },
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
  );

const importDocument = async (
  input: OpenApiInput,
  bytes: Buffer,
  sha256: string,
  signal?: AbortSignal,
): Promise<Result<Evidence, AnalysisError>> => {
  const document = decodeDocument(bytes, input.path);
  if (!document.ok) return document;
  const parsed = await completeApiContractSteps(
    documentSteps(document.value, {
      path: input.path,
      sha256,
      bytes: bytes.length,
    }),
    signal,
  );
  if (!parsed.ok) {
    const partial = apiContractSchema.safeParse(
      parsed.error.partialObservation,
    );
    if (partial.success)
      parsed.error.partialObservation = documentEvidence(input, partial.data);
    return parsed;
  }
  return completeProviderEvidence(
    documentEvidence(input, parsed.value),
    signal,
  );
};

/** Shared CLI/MCP entrypoint; format owners read selected files without network or execution. */
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
  if (input.format === "graphql-sdl") {
    const { importGraphqlContract } =
      await import("./GraphqlContractImport.js");
    return importGraphqlContract(input, resources, options.signal);
  }
  const source = await readApiContract(input, resources, options.signal);
  if (!source.ok) return source;
  const result = await importDocument(
    input,
    source.value.bytes,
    source.value.sha256,
    options.signal,
  );
  if (!result.ok)
    result.error.retainPartialObservation({
      kind: "file-snapshot-hash",
      path: input.path,
      sha256: source.value.sha256,
      bytes: source.value.bytes.length,
    });
  return result;
};
