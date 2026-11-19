import { ERLANG_BEAM_PROVIDER_IDENTITY } from "./ErlangBeamProviderIdentity.js";
import {
  projectOwnedArtifactIdentityFailure,
  projectStableArtifactFailure,
  stableArtifactInputFailure,
  projectArtifactCloseFailure,
  ArtifactReaderFailure,
  type StableArtifactSnapshot,
  readStableArtifact,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  artifactSelectedPathErrno,
  ArtifactResourceScope,
} from "../resources/index.js";
import type { BeamPort } from "../ports/erlang/BeamPort.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import {
  AnalysisAccessDeniedError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import {
  MAX_INSPECT_ERLANG_BEAM_ATOMS,
  MAX_INSPECT_ERLANG_BEAM_CHUNKS,
  MAX_INSPECT_ERLANG_BEAM_FILE_BYTES,
  type InspectErlangBeamInput,
} from "../domain/erlang/beam.js";
import { err, ok } from "../domain/result.js";
import type { LimitRef } from "../domain/parseFailure.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import { parseErlangBeam } from "./BeamParser.js";

const OPERATION = "inspect_erlang_beam";

/** Portable parser over one bounded, identity-checked regular file. */
export class BeamProvider implements BeamPort {
  readonly identity = ERLANG_BEAM_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        ERLANG_BEAM_PROVIDER_IDENTITY.id,
        OPERATION,
      );
    }
  }

  async inspect(input: InspectErlangBeamInput, options?: ExecutionOptions) {
    let snapshot: StableArtifactSnapshot | undefined;
    try {
      return await this.#resources.run(async () => {
        snapshot = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        return ok(
          parseErlangBeam(
            snapshot.bytes,
            {
              path: input.path,
              sha256: snapshot.sha256,
              bytes: snapshot.bytes.length,
            },
            input,
          ),
        );
      });
    } catch (cause) {
      return err(beamFailure(cause, input, snapshot));
    }
  }
}

const fileBudgetRemediation = (maximum: number): string =>
  maximum >= MAX_INSPECT_ERLANG_BEAM_FILE_BYTES
    ? `The file exceeds the ${String(MAX_INSPECT_ERLANG_BEAM_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
    : `Raise max_file_bytes above ${String(maximum)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`;

const parserBudgetRemediation = ({ name, maximum }: LimitRef) => {
  switch (name) {
    case "max_atoms":
      return maximum >= MAX_INSPECT_ERLANG_BEAM_ATOMS
        ? `The file exceeds the ${String(MAX_INSPECT_ERLANG_BEAM_ATOMS)}-atom ceiling this operation accepts; select a smaller artifact.`
        : `Raise max_atoms above ${String(maximum)} or select a smaller artifact; the limit is the caller-selected atom budget.`;
    case "max_table_rows":
      return `The file exceeds the ${String(maximum)}-row ceiling this operation accepts; select a smaller artifact.`;
    case "max_chunks":
      return maximum >= MAX_INSPECT_ERLANG_BEAM_CHUNKS
        ? `The file exceeds the ${String(MAX_INSPECT_ERLANG_BEAM_CHUNKS)}-chunk ceiling this operation accepts; select a smaller artifact.`
        : `Raise max_chunks above ${String(maximum)} or select a smaller artifact; the limit is the caller-selected chunk budget.`;
  }
  return undefined;
};

const beamFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectErlangBeamInput,
) => {
  const { cause, origin } = facts;
  const identityFailure = projectOwnedArtifactIdentityFailure(
    facts,
    OPERATION,
    input.path,
  );
  if (identityFailure !== undefined) return identityFailure;
  const reportedLimits = {
    max_file_bytes: input.max_file_bytes,
    max_chunks: input.max_chunks,
    max_atoms: input.max_atoms,
  };
  if (origin === "owned-or-classified" && isParseLimit(cause, "beam")) {
    const { limit } = cause.failure;
    const remediationAction = parserBudgetRemediation(limit);
    return parseLimitConstraint(OPERATION, "capacity", cause, {
      reportedLimitContext: reportedLimits,
      legacyMaximumKey: limit.name,
      ...(remediationAction === undefined ? {} : { remediationAction }),
      retryable: false,
    });
  }
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit") {
      return new AnalysisResourceConstraintError(
        OPERATION,
        cause.boundary ?? "memory",
        cause.message,
        reportedLimits,
        {
          cause,
          ...(cause.boundary === "file-size"
            ? {
                retryable: false,
                remediationAction: fileBudgetRemediation(input.max_file_bytes),
              }
            : {}),
        },
      );
    }
    if (cause.reason === "path" || cause.reason === "format")
      return stableArtifactInputFailure(cause, OPERATION);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, input.path, cause.code, {
        cause,
      });
    const pathErrno = artifactSelectedPathErrno(cause);
    if (pathErrno !== undefined)
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected BEAM file could not be read (${pathErrno}): ${input.path}.`,
        },
      ]);
  }
  return new ArtifactOperationError(
    OPERATION,
    origin === "owned-or-classified" && cause instanceof ArtifactReaderFailure
      ? cause.reason
      : "io",
    undefined,
    cause instanceof Error ? cause.message : "BEAM inspection failed.",
    { cause },
  );
};

const beamFailure = (
  cause: unknown,
  input: InspectErlangBeamInput,
  snapshot?: StableArtifactSnapshot,
) => {
  const primary = beamFailurePrimary(artifactFilePrimaryFacts(cause), input);
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    ERLANG_BEAM_PROVIDER_IDENTITY.id,
    OPERATION,
    snapshot,
  );
};
