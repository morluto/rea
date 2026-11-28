import { VSIX_PACKAGE_PROVIDER_IDENTITY } from "./VsixPackageProviderIdentity.js";
import {
  ArtifactReaderFailure,
  ArtifactResourceScope,
  artifactFilePrimaryFacts,
  bindArtifactFileCleanup,
  completedStableArtifactObservation,
  projectArtifactCloseFailure,
  projectOwnedArtifactInputFailure,
  readStableArtifact,
  translateArtifactFailure,
  type StableArtifactSnapshot,
} from "../resources/index.js";
import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "../providers/classifyProviderFailure.js";
import type { AnalysisErrorOptions } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  isParseLimit,
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import { decodeLimit } from "../domain/parseFailure.js";
import { fixedCeilingConstraint } from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import {
  VSIX_PACKAGE_BUDGETS,
  VSIX_PACKAGE_FORMAT,
  vsixPackageBudgetLimit,
  type InspectVsixPackageInput,
  type VsixPackageBudget,
} from "../domain/vsix/vsixPackage.js";
import { err, ok } from "../domain/result.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { parseVsixPackage } from "./VsixPackageParser.js";

const OPERATION = "inspect_vsix_package";

/** The refusal options for an exhausted per-call budget. */
const budgetRecovery = (parameter: VsixPackageBudget, selected: number) => ({
  limit: vsixPackageBudgetLimit(parameter, selected),
  remediationAction:
    selected >= VSIX_PACKAGE_BUDGETS[parameter].maximum
      ? `${parameter} is at this operation's maximum of ${String(VSIX_PACKAGE_BUDGETS[parameter].maximum)}; select a complete artifact within that bound.`
      : `Raise ${parameter} above ${String(selected)}, up to ${String(VSIX_PACKAGE_BUDGETS[parameter].maximum)}, or select a smaller artifact. The budget applies on the next call; repeating the unchanged request does not raise it.`,
});

const vsixFileSizeFailure = (
  cause: ArtifactReaderFailure,
  details: AnalysisErrorOptions,
  input: InspectVsixPackageInput,
) =>
  parseLimitConstraint(
    OPERATION,
    "file-size",
    decodeLimit(
      VSIX_PACKAGE_FORMAT,
      cause.message,
      { name: "max_file_bytes", maximum: input.max_file_bytes },
      { cause },
    ),
    {
      ...details,
      retryable: false,
      ...budgetRecovery("max_file_bytes", input.max_file_bytes),
    },
  );

/** The VSIX parse ceilings, with recovery for each caller-selected budget. */
const vsixParseLimit = (
  cause: Parameters<typeof parseLimitConstraint>[2],
  input: InspectVsixPackageInput,
) => {
  if (cause.failure.limit.name === "xml_nodes")
    return parseLimitConstraint(OPERATION, "memory", cause, {
      path: input.path,
      ...fixedAllowanceOptions(
        `The ${String(cause.failure.limit.maximum)}-node allowance for an extension.vsixmanifest document tree`,
        "parser",
        { limit: cause.failure.limit.maximum, unit: "nodes" },
      ),
    });
  if (cause.failure.limit.name === "json_values")
    return parseLimitConstraint(OPERATION, "memory", cause, {
      path: input.path,
      ...fixedAllowanceOptions(
        `The ${String(cause.failure.limit.maximum)}-value allowance for a parsed extension/package.json`,
        "parser",
        { limit: cause.failure.limit.maximum, unit: "values" },
      ),
    });
  const parameter = (
    Object.keys(VSIX_PACKAGE_BUDGETS) as VsixPackageBudget[]
  ).find((name) => name === cause.failure.limit.name);
  return parseLimitConstraint(
    OPERATION,
    cause.failure.limit.name === "max_entries" ? "capacity" : "memory",
    cause,
    {
      path: input.path,
      retryable: false,
      // Early-stop parse limits (such as ZIP entry enumeration and streaming
      // manifest reads) only know a lower bound, which parseLimitConstraint
      // preserves in details.reported_limits; omit required_value unless the
      // complete total admitting the whole request is known.
      ...(parameter === undefined
        ? {}
        : budgetRecovery(parameter, cause.failure.limit.maximum)),
    },
  );
};

/**
 * The VSIX dialect for the shared provider failure classifier: only the
 * package's own parse ceilings, format refusals and fixed reader allowances.
 * Cancellation, identity, path and selected-file failures are the shared
 * owner's.
 */
const vsixFailureDialect = (
  input: InspectVsixPackageInput,
): ProviderFailureDialect => ({
  providerId: VSIX_PACKAGE_PROVIDER_IDENTITY.id,
  operation: OPERATION,
  file: {
    path: input.path,
    description: "VS Code extension package",
    retainCompletedIdentity: true,
    fileSize: (cause, details) => vsixFileSizeFailure(cause, details, input),
  },
  recognise: (raw, details) => {
    const facts = artifactFilePrimaryFacts(raw);
    const { cause, origin } = facts;
    if (isParseLimit(cause, VSIX_PACKAGE_FORMAT))
      return vsixParseLimit(cause, input);
    const formatFailure = parseFailureAnalysisError(
      OPERATION,
      input.path,
      cause,
    );
    if (formatFailure !== undefined) return formatFailure;
    if (
      origin !== "owned-or-classified" ||
      !(cause instanceof ArtifactReaderFailure)
    )
      return undefined;
    if (cause.reason === "limit" && cause.fixedAllowance !== undefined)
      return fixedCeilingConstraint(
        OPERATION,
        cause.boundary ?? "memory",
        cause.message,
        cause.fixedAllowance,
        { ...details, cause },
      );
    // The shared file classifier handles path refusals.
    if (cause.reason === "path") return undefined;
    return projectOwnedArtifactInputFailure(facts, OPERATION, input.path);
  },
  readCleanup: (read, primary) => {
    const cleanup = new ProviderCleanupError(
      VSIX_PACKAGE_PROVIDER_IDENTITY.id,
      read.cleanup.resources,
      { reason: read.cleanup.reason },
      { cause: read, operation: OPERATION },
    );
    const error =
      primary === undefined
        ? cleanup
        : analysisErrorWithCleanupFailure(primary, cleanup, OPERATION);
    bindArtifactFileCleanup(read, error);
    return error;
  },
  unclassified: (raw, details) => {
    const { cause, origin } = artifactFilePrimaryFacts(raw);
    return origin === "owned-or-classified" &&
      cause instanceof ArtifactReaderFailure
      ? translateArtifactFailure(OPERATION, input.path, cause)
      : new ArtifactOperationError(
          OPERATION,
          "io",
          undefined,
          errorMessage(cause),
          { ...details, cause },
        );
  },
});

/**
 * Classify through the shared owner. A parser failure after a completed read
 * carries no read identity of its own, so the held snapshot supplies it.
 */
const vsixFailure = (
  cause: unknown,
  input: InspectVsixPackageInput,
  snapshot?: StableArtifactSnapshot,
) => {
  const failure = classifyProviderFailure(cause, vsixFailureDialect(input));
  const observation = completedStableArtifactObservation(
    cause,
    input.path,
    snapshot,
  );
  if (failure.partialObservation === undefined && observation !== undefined)
    failure.retainPartialObservation(observation);
  return failure;
};

/** Portable parser over one bounded, identity-checked regular file. */
export class VsixPackageProvider {
  readonly identity = VSIX_PACKAGE_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        VSIX_PACKAGE_PROVIDER_IDENTITY.id,
        OPERATION,
      );
    }
  }

  async inspect(
    input: InspectVsixPackageInput,
    options?: { readonly signal?: AbortSignal },
  ) {
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
          await parseVsixPackage(
            snapshot.bytes,
            {
              path: input.path,
              sha256: snapshot.sha256,
              bytes: snapshot.bytes.length,
            },
            input,
            options?.signal,
          ),
        );
      });
    } catch (cause) {
      return err(vsixFailure(cause, input, snapshot));
    }
  }
}
