import { PYTHON_PYC_PROVIDER_IDENTITY } from "./PythonPycProviderIdentity.js";
import {
  artifactFilePrimaryFacts,
  closeArtifactResources,
  projectStableArtifactFailure,
  type StableArtifactSnapshot,
  readStableArtifact,
  ArtifactResourceScope,
} from "../resources/index.js";
import type { PythonPycPort } from "../ports/python/PythonPycPort.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  PYTHON_PYC_LIMIT_MAXIMA,
  type InspectPythonPycInput,
  type PythonPycLimits,
} from "../domain/python/pythonPyc.js";
import { err, ok } from "../domain/result.js";
import {
  PYTHON_PYC_FORMAT,
  pythonPycLimitControls,
} from "./PythonPyc.errors.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import { parsePythonPyc } from "./PythonPycParser.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../providers/offlineArtifactFailure.js";

const OPERATION = "inspect_python_pyc";

const parserLimitRecovery = (
  input: InspectPythonPycInput,
  fields: readonly (keyof PythonPycLimits)[],
) => {
  const actions = fields.map((field) => {
    const selected = input[field];
    const maximum = PYTHON_PYC_LIMIT_MAXIMA[field];
    const option = `--${field.replaceAll("_", "-")}`;
    return selected < maximum
      ? `Raise ${field} (${option}) above ${selected}, up to ${maximum}, on the next call.`
      : `${field} (${option}) is at this operation's maximum of ${maximum}; select a complete artifact within that bound.`;
  });
  return {
    retryable: false as const,
    remediationAction: `${actions.join(" ")} Repeating the unchanged request fails the same way; waiting or adding host memory does not raise these parser limits.`,
  };
};

const failureFor = (
  cause: unknown,
  input: InspectPythonPycInput,
  snapshot?: StableArtifactSnapshot,
) => {
  const facts = artifactFilePrimaryFacts(cause);
  return projectStableArtifactFailure(
    cause,
    classifyProviderFailure(
      facts.cause,
      offlineArtifactFailureDialect(facts, {
        operation: OPERATION,
        providerId: PYTHON_PYC_PROVIDER_IDENTITY.id,
        path: input.path,
        description: "pyc",
        recognise: (failure) => {
          if (!isParseLimit(failure, PYTHON_PYC_FORMAT)) return undefined;
          const { name } = failure.failure.limit;
          return parseLimitConstraint(
            OPERATION,
            name === "max_depth" ? "capacity" : "memory",
            failure,
            parserLimitRecovery(input, pythonPycLimitControls(name)),
          );
        },
        fileSize: (failure) =>
          new AnalysisResourceConstraintError(
            OPERATION,
            "file-size",
            failure.message,
            { max_file_bytes: input.max_file_bytes },
            {
              cause: failure,
              ...parserLimitRecovery(input, ["max_file_bytes"]),
            },
          ),
      }),
    ),
    input.path,
    PYTHON_PYC_PROVIDER_IDENTITY.id,
    OPERATION,
    snapshot,
  );
};

/** Portable parser over one bounded, identity-checked regular file. */
export class PythonPycProvider implements PythonPycPort {
  readonly identity = PYTHON_PYC_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      PYTHON_PYC_PROVIDER_IDENTITY,
      OPERATION,
    );
  }

  async inspect(input: InspectPythonPycInput, options?: ExecutionOptions) {
    let snapshot: StableArtifactSnapshot | undefined;
    try {
      snapshot = await this.#resources.run(() =>
        readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        ),
      );
      return ok(
        parsePythonPyc(
          snapshot.bytes,
          {
            path: input.path,
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          },
          input,
        ),
      );
    } catch (cause) {
      return err(failureFor(cause, input, snapshot));
    }
  }
}
