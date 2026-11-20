import { OCI_IMAGE_LAYOUT_PROVIDER_IDENTITY } from "./OciImageLayoutProviderIdentity.js";
import {
  ArtifactReaderFailure,
  ArtifactResourceScope,
  DirectoryArtifactReader,
  DirectoryArtifactRootFailure,
  projectArtifactCloseFailure,
  translateArtifactFailure,
  type ArtifactResourceOwner,
} from "../resources/index.js";
import {
  isParseLimit,
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import {
  AnalysisInputError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import {
  OCI_IMAGE_LAYOUT_FORMAT,
  OCI_IMAGE_LAYOUT_LIMIT_MAXIMA,
  type InspectOciImageLayoutInput,
  type OciImageLayout,
} from "../domain/oci/imageLayout.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { err, ok } from "../domain/result.js";
import { errorMessage } from "../kernel/errorMessage.js";
import {
  OciImageLayoutRefusal,
  parseOciImageLayout,
} from "./OciImageLayoutParser.js";
import type { FileSnapshotPartialObservation } from "../domain/fileSnapshotObservation.js";
import { ParseFailureError } from "../domain/parseFailure.js";

const OPERATION = "inspect_oci_image_layout";

const budgetRecovery = (
  parameter: keyof typeof OCI_IMAGE_LAYOUT_LIMIT_MAXIMA,
  selected: number,
): string =>
  selected >= OCI_IMAGE_LAYOUT_LIMIT_MAXIMA[parameter]
    ? `${parameter} is at this operation's maximum of ${String(OCI_IMAGE_LAYOUT_LIMIT_MAXIMA[parameter])}; select a complete layout within that bound.`
    : `Raise ${parameter} above ${String(selected)}, up to ${String(OCI_IMAGE_LAYOUT_LIMIT_MAXIMA[parameter])}, or select a smaller layout. The budget applies on the next call; repeating the unchanged request does not raise it.`;

const layoutPartial = (
  cause: unknown,
): FileSnapshotPartialObservation | undefined =>
  cause instanceof OciImageLayoutRefusal ? cause.layoutObservation : undefined;

const layoutFailure = (cause: unknown, input: InspectOciImageLayoutInput) => {
  const observation = layoutPartial(cause);
  const options =
    observation === undefined ? {} : { partialObservation: observation };
  if (cause instanceof DirectoryArtifactRootFailure && cause.reason === "path")
    return new AnalysisUnsupportedTargetError(
      OPERATION,
      input.path,
      cause.message,
      {
        cause,
        ...options,
        remediationAction:
          "Select an OCI image-layout directory containing oci-layout, index.json, and blobs/.",
      },
    );
  if (
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "path" &&
    cause.message.includes("symlink")
  )
    return new AnalysisUnsupportedTargetError(
      OPERATION,
      input.path,
      cause.message,
      {
        cause,
        ...options,
        remediationAction:
          "Select the OCI image-layout directory itself; symbolic links are not followed.",
      },
    );
  if (isParseLimit(cause, OCI_IMAGE_LAYOUT_FORMAT)) {
    const parameter = (
      Object.keys(
        OCI_IMAGE_LAYOUT_LIMIT_MAXIMA,
      ) as (keyof typeof OCI_IMAGE_LAYOUT_LIMIT_MAXIMA)[]
    ).find((name) => name === cause.failure.limit.name);
    return parseLimitConstraint(
      OPERATION,
      cause.failure.limit.name === "max_entries" ||
        cause.failure.limit.name === "max_descriptors"
        ? "capacity"
        : "memory",
      cause,
      {
        path: input.path,
        retryable: false,
        ...options,
        ...(parameter === undefined
          ? {}
          : {
              remediationAction: budgetRecovery(
                parameter,
                cause.failure.limit.maximum,
              ),
            }),
      },
    );
  }
  if (cause instanceof ParseFailureError && cause.failure.kind !== "limit") {
    const formatFailure = parseFailureAnalysisError(
      OPERATION,
      input.path,
      cause,
    );
    if (formatFailure instanceof AnalysisInputError)
      return new AnalysisInputError(
        OPERATION,
        { cause, ...options },
        formatFailure.issues,
      );
    if (formatFailure !== undefined) return formatFailure;
  }
  if (cause instanceof ArtifactReaderFailure)
    return translateArtifactFailure(OPERATION, cause);
  return new ArtifactOperationError(
    OPERATION,
    "io",
    undefined,
    errorMessage(cause),
    { cause, ...options },
  );
};

/** Portable parser over one bounded, identity-checked directory. */
export class OciImageLayoutProvider {
  readonly identity = OCI_IMAGE_LAYOUT_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        OCI_IMAGE_LAYOUT_PROVIDER_IDENTITY.id,
        OPERATION,
      );
    }
  }

  async inspect(
    input: InspectOciImageLayoutInput,
    options?: { readonly signal?: AbortSignal },
  ) {
    try {
      return await this.#resources.run(async () => {
        const reader = new DirectoryArtifactReader(input.path);
        const owner: ArtifactResourceOwner = {
          kind: "reader",
          resource: input.path,
          reader,
        };
        let outcome:
          | { readonly kind: "completed"; readonly value: OciImageLayout }
          | { readonly kind: "failed"; readonly cause: unknown };
        try {
          outcome = {
            kind: "completed",
            value: await parseOciImageLayout(reader, input, options?.signal),
          };
        } catch (cause: unknown) {
          outcome = { kind: "failed", cause };
        }
        const closed = await this.#resources.release(owner);
        if (closed.kind === "failed") {
          const cleanup = this.#resources.cleanupFailure(
            { kind: "completed" },
            [closed],
          );
          if (outcome.kind === "completed") throw cleanup;
          // The parse's own failure, with its partial facts, stays primary.
          return err(
            analysisErrorWithCleanupDependencies(
              layoutFailure(outcome.cause, input),
              translateArtifactFailure(OPERATION, cleanup),
              OPERATION,
            ),
          );
        }
        if (outcome.kind === "failed") throw outcome.cause;
        return ok(outcome.value);
      });
    } catch (cause) {
      return err(layoutFailure(cause, input));
    }
  }
}
