import { PYTHON_PYC_PROVIDER_IDENTITY } from "./PythonPycProviderIdentity.js";
import {
  projectSelectedArtifactFileFailure,
  projectOwnedArtifactIdentityFailure,
  projectStableArtifactFailure,
  stableArtifactInputFailure,
  projectArtifactCloseFailure,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  ArtifactReaderFailure,
  type StableArtifactSnapshot,
  readStableArtifact,
  ArtifactResourceScope,
} from "../resources/index.js";
import type { PythonPycPort } from "../ports/python/PythonPycPort.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  PYTHON_PYC_LIMIT_MAXIMA,
  type InspectPythonPycInput,
  type PythonPycLimits,
} from "../domain/python/pythonPyc.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok } from "../domain/result.js";
import {
  PYTHON_PYC_FORMAT,
  pythonPycLimitControls,
} from "./PythonPyc.errors.js";
import {
  isParseLimit,
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import { parsePythonPyc } from "./PythonPycParser.js";
import { errorMessage } from "../kernel/errorMessage.js";

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

const failureForPrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectPythonPycInput,
) => {
  const { cause, origin } = facts;
  if (origin === "owned-or-classified" && cause instanceof AnalysisError)
    return cause;
  const identityFailure = projectOwnedArtifactIdentityFailure(
    facts,
    OPERATION,
    input.path,
  );
  if (identityFailure !== undefined) return identityFailure;
  if (isParseLimit(cause, PYTHON_PYC_FORMAT)) {
    const { name } = cause.failure.limit;
    return parseLimitConstraint(
      OPERATION,
      name === "max_depth" ? "capacity" : "memory",
      cause,
      parserLimitRecovery(input, pythonPycLimitControls(name)),
    );
  }
  const formatFailure = parseFailureAnalysisError(OPERATION, input.path, cause);
  if (formatFailure !== undefined) return formatFailure;
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        cause.message,
        { max_file_bytes: input.max_file_bytes },
        {
          cause,
          ...parserLimitRecovery(input, ["max_file_bytes"]),
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return stableArtifactInputFailure(cause, OPERATION);
  }
  const fileFailure = projectSelectedArtifactFileFailure(
    cause,
    OPERATION,
    input.path,
    "pyc",
  );
  if (fileFailure !== undefined) return fileFailure;
  return new ProviderAdapterError(PYTHON_PYC_PROVIDER_IDENTITY.id, OPERATION, {
    cause,
    diagnostics: {
      path: input.path,
      reason: errorMessage(cause),
    },
  });
};

const failureFor = (
  cause: unknown,
  input: InspectPythonPycInput,
  snapshot?: StableArtifactSnapshot,
) => {
  const primary = failureForPrimary(artifactFilePrimaryFacts(cause), input);
  return projectStableArtifactFailure(
    cause,
    primary,
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

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        PYTHON_PYC_PROVIDER_IDENTITY.id,
        OPERATION,
      );
    }
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
