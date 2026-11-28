import { ERLANG_BEAM_PROVIDER_IDENTITY } from "./ErlangBeamProviderIdentity.js";
import {
  projectStableArtifactFailure,
  closeArtifactResources,
  ArtifactReaderFailure,
  withStableArtifactHandle,
  artifactFilePrimaryFacts,
  ArtifactResourceScope,
} from "../resources/index.js";
import type { BeamPort } from "../ports/erlang/BeamPort.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  erlangBeamBudgetLimit,
  type ErlangBeam,
  type InspectErlangBeamInput,
} from "../domain/erlang/beam.js";
import { err, ok } from "../domain/result.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../providers/offlineArtifactFailure.js";
import { parseErlangBeamFromHandle } from "./BeamParser.js";

const OPERATION = "inspect_erlang_beam";

/** Portable parser over one bounded, identity-checked regular file. */
export class BeamProvider implements BeamPort {
  readonly identity = ERLANG_BEAM_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      ERLANG_BEAM_PROVIDER_IDENTITY,
      OPERATION,
    );
  }

  async inspect(input: InspectErlangBeamInput, options?: ExecutionOptions) {
    let completed: ErlangBeam | undefined;
    let observed:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () => {
        const report = await withStableArtifactHandle<ErlangBeam>(
          input.path,
          input.max_file_bytes,
          {
            retainBytes: (size) => Math.min(size, 12),
            signal: options?.signal,
            resourceScope: this.#resources,
            onIdentity: (identity) => {
              observed = identity;
            },
            onVerifiedResult: (value) => {
              completed = value;
            },
          },
          (handle) =>
            parseErlangBeamFromHandle(
              handle,
              { path: input.path, sha256: handle.sha256, bytes: handle.size },
              input,
            ),
        );
        return ok(report);
      });
    } catch (cause) {
      return err(beamFailure(cause, input, observed, completed));
    }
  }
}

/** The per-call count budgets the parser names in its limit. */
const BEAM_COUNT_BUDGETS = [
  "max_chunks",
  "max_atoms",
  "max_table_rows",
] as const;

const beamFailure = (
  cause: unknown,
  input: InspectErlangBeamInput,
  observed: { readonly sha256: string; readonly bytes: number } | undefined,
  completed: ErlangBeam | undefined,
) => {
  const facts = artifactFilePrimaryFacts(cause);
  const reportedLimits = {
    max_file_bytes: input.max_file_bytes,
    max_chunks: input.max_chunks,
    max_atoms: input.max_atoms,
    max_table_rows: input.max_table_rows,
  };
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: ERLANG_BEAM_PROVIDER_IDENTITY.id,
      operation: OPERATION,
      path: input.path,
      description: "BEAM file",
      fallbackMessage: "BEAM inspection failed.",
      recognise: (failure, origin) => {
        if (origin === "owned-or-classified" && isParseLimit(failure, "beam")) {
          const { limit } = failure.failure;
          const parameter = BEAM_COUNT_BUDGETS.find(
            (name) => name === limit.name,
          );
          return parseLimitConstraint(OPERATION, "capacity", failure, {
            reportedLimitContext: reportedLimits,
            legacyMaximumKey: limit.name,
            retryable: false,
            ...(parameter === undefined
              ? {}
              : {
                  limit: {
                    ...erlangBeamBudgetLimit(parameter, limit.maximum),
                    ...(typeof limit.required === "number"
                      ? { required_value: limit.required }
                      : {}),
                  },
                }),
          });
        }
        if (
          origin === "owned-or-classified" &&
          failure instanceof ArtifactReaderFailure &&
          failure.reason === "limit"
        )
          return new AnalysisResourceConstraintError(
            OPERATION,
            failure.boundary ?? "memory",
            failure.message,
            reportedLimits,
            {
              cause: failure,
              ...(failure.boundary === "file-size"
                ? {
                    retryable: false,
                    limit: erlangBeamBudgetLimit(
                      "max_file_bytes",
                      input.max_file_bytes,
                    ),
                  }
                : {}),
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
    input.path,
    ERLANG_BEAM_PROVIDER_IDENTITY.id,
    OPERATION,
    observed,
  );
};
