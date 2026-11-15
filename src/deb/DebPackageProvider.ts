import { DEB_PACKAGE_PROVIDER_IDENTITY } from "./DebPackageProviderIdentity.js";
import {
  projectSelectedArtifactFileFailure,
  projectOwnedArtifactIdentityFailure,
  projectStableArtifactFailure,
  stableArtifactInputFailure,
  projectArtifactCloseFailure,
} from "../artifacts/StableArtifactFailure.js";
import {
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
} from "../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  type StableArtifactSnapshot,
  readStableArtifact,
} from "../artifacts/readStableArtifact.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { DebPackagePort } from "../application/deb/DebPackagePort.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  DEB_PACKAGE_LIMIT_MAXIMA,
  type InspectDebPackageInput,
} from "../domain/deb/debPackage.js";
import { parseFailureAnalysisError } from "../domain/parseFailureAnalysisError.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok } from "../domain/result.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
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
    !(cause instanceof DebPackageCapacityFailure)
  )
    return {};
  const partial = cause.partial;
  if (partial === undefined) return {};
  // The partial report is already bounded by the caller's limits, so carry
  // it whole: control facts, scripts, member offsets and file rows read
  // before the refusal stay visible to CLI and MCP callers.
  return { diagnostics: { partial: partial satisfies JsonValue } };
};

const failureForPrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectDebPackageInput,
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
  if (cause instanceof DebPackageCapacityFailure)
    return new AnalysisResourceConstraintError(
      OPERATION,
      cause.resource === "max_file_bytes" ? "file-size" : "capacity",
      cause.message,
      { [cause.resource]: cause.maximum },
      {
        cause,
        ...parserLimitRecovery(cause.resource, cause.maximum),
        ...partialDiagnostics(cause),
      },
    );
  const formatFailure = parseFailureAnalysisError(
    OPERATION,
    input.path,
    cause,
    "path",
    partialDiagnostics(cause),
  );
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
          ...parserLimitRecovery("max_file_bytes", input.max_file_bytes),
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return stableArtifactInputFailure(cause, OPERATION);
  }
  const fileFailure = projectSelectedArtifactFileFailure(
    cause,
    OPERATION,
    input.path,
    "deb",
  );
  if (fileFailure !== undefined) return fileFailure;
  return new ProviderAdapterError(DEB_PACKAGE_PROVIDER_IDENTITY.id, OPERATION, {
    cause,
    diagnostics: {
      path: input.path,
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

const failureFor = (
  cause: unknown,
  input: InspectDebPackageInput,
  snapshot?: StableArtifactSnapshot,
) => {
  const primary = failureForPrimary(artifactFilePrimaryFacts(cause), input);
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    DEB_PACKAGE_PROVIDER_IDENTITY.id,
    OPERATION,
    snapshot,
  );
};

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
      return err(failureFor(cause, input, snapshot));
    }
  }
}
