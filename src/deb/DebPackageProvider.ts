import { DEB_PACKAGE_PROVIDER_IDENTITY } from "./DebPackageProviderIdentity.js";
import { errorMessage } from "../kernel/errorMessage.js";
import {
  ArtifactResourceScope,
  completedStableArtifactObservation,
  projectArtifactCloseFailure,
  readStableArtifact,
  type StableArtifactSnapshot,
} from "../resources/index.js";
import type { DebPackagePort } from "../ports/deb/DebPackagePort.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import {
  DEB_PACKAGE_LIMIT_MAXIMA,
  type InspectDebPackageInput,
} from "../domain/deb/debPackage.js";
import {
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok } from "../domain/result.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { AnalysisErrorOptions } from "../domain/analysisErrorBase.js";
import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "../providers/classifyProviderFailure.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import {
  DEB_PACKAGE_FIXED_ALLOWANCES,
  DebPackageAllowanceFailure,
  DebPackageCapacityFailure,
  DebPackageFormatFailure,
} from "./DebPackage.errors.js";
import { parseDebPackage } from "./DebPackageParser.js";

const OPERATION = "inspect_deb_package";

const parserLimitRecovery = (
  resource: keyof typeof DEB_PACKAGE_LIMIT_MAXIMA,
  selected: number,
) => {
  const maximum = DEB_PACKAGE_LIMIT_MAXIMA[resource];
  const option = `--${resource.replaceAll("_", "-")}`;
  const action =
    selected < maximum
      ? `Raise ${resource} (${option}) above ${String(selected)}, up to ${String(maximum)}, on the next call.`
      : `${resource} (${option}) is at this operation's maximum of ${String(maximum)}; select a complete artifact within that bound.`;
  return {
    retryable: false as const,
    remediationAction: `${action} Repeating the unchanged request fails the same way; waiting or adding host memory does not raise these parser limits.`,
  };
};

const partialDiagnostics = (cause: unknown) => {
  if (
    !(cause instanceof DebPackageFormatFailure) &&
    !(cause instanceof DebPackageCapacityFailure) &&
    !(cause instanceof DebPackageAllowanceFailure)
  )
    return {};
  const partial = cause.partial;
  if (partial === undefined) return {};
  // The partial report is already bounded by the caller's limits, so carry
  // it whole: control facts, scripts, member offsets and file rows read
  // before the refusal stay visible to CLI and MCP callers.
  return { diagnostics: { partial: partial satisfies JsonValue } };
};

/**
 * The refusal for a Debian limit: the file-size budget, or a parser capacity
 * such as member count or expanded tar bytes. The limit's name and maximum
 * come from the failure's LimitRef; the recovery names the request option.
 */
const capacityConstraint = (
  cause: DebPackageCapacityFailure,
  details: Omit<AnalysisErrorOptions, "cause">,
) =>
  parseLimitConstraint(
    OPERATION,
    cause.resource === "max_file_bytes" ? "file-size" : "capacity",
    cause,
    {
      ...details,
      ...parserLimitRecovery(cause.resource, cause.maximum),
      ...partialDiagnostics(cause),
    },
  );

/**
 * The refusal for a fixed reader allowance, such as ar name bytes or
 * relationship alternatives. No request budget raises it, so the recovery
 * names the allowance rather than an option.
 */
const allowanceConstraint = (
  cause: DebPackageAllowanceFailure,
  details: Omit<AnalysisErrorOptions, "cause">,
) =>
  parseLimitConstraint(OPERATION, "capacity", cause, {
    ...details,
    ...fixedAllowanceOptions(
      DEB_PACKAGE_FIXED_ALLOWANCES[cause.allowance],
      "parser",
      { limit: cause.maximum },
    ),
    ...partialDiagnostics(cause),
  });

/**
 * Debian's dialect for the shared provider failure classifier. Parser limit
 * and format refusals, and the recovery text for those limits, are the only
 * cases this provider names.
 */
const failureDialect = (
  input: InspectDebPackageInput,
): ProviderFailureDialect => ({
  providerId: DEB_PACKAGE_PROVIDER_IDENTITY.id,
  operation: OPERATION,
  recognise: (cause, details) => {
    if (cause instanceof DebPackageCapacityFailure)
      return capacityConstraint(cause, details);
    if (cause instanceof DebPackageAllowanceFailure)
      return allowanceConstraint(cause, details);
    return parseFailureAnalysisError(
      OPERATION,
      input.path,
      cause,
      "path",
      partialDiagnostics(cause),
    );
  },
  file: {
    path: input.path,
    description: "deb",
    retainCompletedIdentity: true,
    fileSize: (limit, { cause, ...details }) =>
      capacityConstraint(
        new DebPackageCapacityFailure(
          "max_file_bytes",
          input.max_file_bytes,
          limit.message,
          undefined,
          { cause },
        ),
        details,
      ),
  },
  unclassified: (cause, details) =>
    new ProviderAdapterError(DEB_PACKAGE_PROVIDER_IDENTITY.id, OPERATION, {
      ...details,
      cause,
      diagnostics: {
        path: input.path,
        reason: errorMessage(cause),
      },
    }),
});

/** Portable parser over one bounded, identity-checked regular file. */
export class DebPackageProvider implements DebPackagePort {
  readonly identity = DEB_PACKAGE_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        DEB_PACKAGE_PROVIDER_IDENTITY.id,
        OPERATION,
      );
    }
  }

  async inspect(input: InspectDebPackageInput, options?: ExecutionOptions) {
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
        parseDebPackage(
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
    } catch (cause) {
      const failure = classifyProviderFailure(cause, failureDialect(input));
      // The read already completed; its byte identity stays on the parser refusal.
      if (snapshot !== undefined) {
        const observation = completedStableArtifactObservation(
          cause,
          input.path,
          snapshot,
        );
        if (observation !== undefined)
          failure.retainPartialObservation(observation);
      }
      return err(failure);
    }
  }
}
