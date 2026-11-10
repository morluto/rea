import { getHeapStatistics } from "node:v8";
import { version } from "graphql";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import {
  primaryAnalysisError,
  type AnalysisError,
} from "../../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence } from "../../domain/evidence.js";
import { fileSnapshotPartialObservationSchema } from "../../domain/fileSnapshotObservation.js";
import {
  API_CONTRACT_OPERATION as operation,
  API_CONTRACT_PROVIDER,
  type ApiContractArtifact,
} from "../../domain/apiContract/apiContract.js";
import type { InspectApiContractInput } from "../../domain/apiContract/apiContractQuery.js";
import {
  graphqlContractSchema,
  type GraphqlContract,
} from "../../domain/apiContract/graphqlContract.js";
import { GraphqlInventory } from "../../domain/apiContract/GraphqlInventory.js";
import { parseGraphqlContractSteps } from "../../domain/apiContract/parseGraphqlContract.js";
import { err, ok, type Result } from "../../domain/result.js";
import { nativeJsonParseRequiredBytes } from "../JsonInputFile.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { completeApiContractSteps } from "./ApiContractTraversal.js";
import { readApiContract } from "./ApiContractRead.js";

type GraphqlInput = Extract<InspectApiContractInput, { format: "graphql-sdl" }>;
const evidence = (input: GraphqlInput, report: GraphqlContract) =>
  createEvidence(
    { path: input.path, format: "file", sha256: report.artifact.sha256 },
    API_CONTRACT_PROVIDER,
    {
      operation,
      predicateType: "rea.api-contract-inventory",
      parameters: {
        path: input.path,
        format: input.format,
        max_file_bytes: input.max_file_bytes,
        ...(input.operations_path === undefined
          ? {}
          : { operations_path: input.operations_path }),
      },
      result: report,
      confidence: "observed",
      limitations: report.limitations,
      locations: [
        { kind: "artifact-path", path: input.path },
        ...(input.operations_path === undefined
          ? []
          : [{ kind: "artifact-path" as const, path: input.operations_path }]),
      ],
    },
  );
const inputFailure = (parameter: string, message: string, cause?: unknown) =>
  new AnalysisInputError(operation, { cause }, [
    { path: [parameter], reason: "invalid_format", message },
  ]);

const decode = (
  bytes: Buffer,
  parameter: string,
): Result<string, AnalysisError> => {
  // Reuse the existing conservative document-expansion admission before text/AST allocation.
  const required = nativeJsonParseRequiredBytes(bytes.length);
  const available = getHeapStatistics().total_available_size;
  if (required > available)
    return err(
      new AnalysisResourceConstraintError(
        operation,
        "memory",
        "Insufficient parser headroom for GraphQL text and AST expansion.",
        {
          input_bytes: bytes.length,
          required_bytes: required,
          available_heap_bytes: available,
        },
        {
          remediationAction:
            "Select a smaller complete document or free parser memory; reply paging does not reduce parsing work.",
        },
      ),
    );
  try {
    return ok(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause;
    return err(
      inputFailure(
        parameter,
        "The selected GraphQL document is not valid UTF-8.",
        cause,
      ),
    );
  }
};

/** Partial facts and independently verified identities survive parsing and descriptor cleanup. */
const retainFailure = (
  failure: AnalysisError,
  input: GraphqlInput,
  artifact: ApiContractArtifact,
  operationArtifact: ApiContractArtifact | null,
) => {
  const prior =
    failure.partialObservation ??
    primaryAnalysisError(failure).partialObservation;
  const parsed = graphqlContractSchema.safeParse(prior);
  const snapshot = fileSnapshotPartialObservationSchema.safeParse(prior);
  const secondary =
    snapshot.success &&
    snapshot.data.kind === "file-snapshot-hash" &&
    snapshot.data.sha256 !== null &&
    snapshot.data.path !== null &&
    snapshot.data.path === input.operations_path
      ? {
          path: snapshot.data.path,
          sha256: snapshot.data.sha256,
          bytes: snapshot.data.bytes,
        }
      : operationArtifact;
  const report = parsed.success
    ? parsed.data
    : new GraphqlInventory(
        artifact,
        secondary,
        version,
        input.operations_path !== undefined,
      ).finish(true);
  const projected = evidence(input, report);
  let current: AnalysisError | undefined = failure;
  while (current !== undefined) {
    if (
      current.partialObservation === prior ||
      current.partialObservation === undefined
    )
      current.partialObservation = projected;
    current = current.cleanupPrimary;
  }
  return err(failure);
};

/** Loaded only for SDL; both adapters use this verified local-file interpretation. */
export const importGraphqlContract = async (
  input: GraphqlInput,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
) => {
  const loaded = await readApiContract(input, resources, signal);
  if (!loaded.ok) return loaded;
  const artifact = {
    path: input.path,
    sha256: loaded.value.sha256,
    bytes: loaded.value.bytes.length,
  };
  const schemaText = decode(loaded.value.bytes, "path");
  if (!schemaText.ok)
    return retainFailure(schemaText.error, input, artifact, null);
  let operations: { artifact: ApiContractArtifact; text: string } | undefined;
  if (input.operations_path !== undefined) {
    const second = await readApiContract(
      {
        path: input.operations_path,
        max_file_bytes: input.max_file_bytes,
        parameter: "operations_path",
      },
      resources,
      signal,
    );
    if (!second.ok) return retainFailure(second.error, input, artifact, null);
    const secondArtifact = {
      path: input.operations_path,
      sha256: second.value.sha256,
      bytes: second.value.bytes.length,
    };
    const text = decode(second.value.bytes, "operations_path");
    if (!text.ok)
      return retainFailure(text.error, input, artifact, secondArtifact);
    operations = { artifact: secondArtifact, text: text.value };
  }
  const parsed = await completeApiContractSteps(
    parseGraphqlContractSteps({ artifact, text: schemaText.value }, operations),
    signal,
  );
  if (!parsed.ok)
    return retainFailure(
      parsed.error,
      input,
      artifact,
      operations?.artifact ?? null,
    );
  return completeProviderEvidence(evidence(input, parsed.value), signal);
};
