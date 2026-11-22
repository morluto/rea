import { OCI_IMAGE_LAYOUT_PROVIDER_IDENTITY } from "./OciImageLayoutProviderIdentity.js";
import {
  ArtifactReaderFailure,
  ArtifactResourceScope,
  bindArtifactFileCleanup,
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
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { createOciImageLayoutEvidence } from "../domain/oci/imageLayoutEvidence.js";
import { err, ok } from "../domain/result.js";
import { errorMessage } from "../kernel/errorMessage.js";
import {
  OciImageLayoutRefusal,
  parseOciImageLayout,
} from "./OciImageLayoutParser.js";
import type { FileSnapshotPartialObservation } from "../domain/fileSnapshotObservation.js";
import { ParseFailureError } from "../domain/parseFailure.js";
import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "../providers/classifyProviderFailure.js";

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

/** The host errno that says the selected path names no reachable directory. */
const selectionErrorCode = (cause: unknown): string | undefined => {
  const code: unknown =
    cause instanceof Error ? Reflect.get(cause, "code") : undefined;
  return code === "ENOENT" || code === "ENOTDIR" ? code : undefined;
};

/** OCI layout decisions supplied to the shared provider failure owner. */
const layoutFailureDialect = (
  input: InspectOciImageLayoutInput,
): ProviderFailureDialect => ({
  providerId: OCI_IMAGE_LAYOUT_PROVIDER_IDENTITY.id,
  operation: OPERATION,
  recognise: (cause, details) => {
    const observation = layoutPartial(cause);
    const options = {
      ...details,
      ...(observation === undefined ? {} : { partialObservation: observation }),
    };
    if (
      cause instanceof DirectoryArtifactRootFailure &&
      cause.reason === "path"
    )
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
    // A missing selection, or one under a regular-file ancestor, is a bad
    // `path` rather than an I/O failure; other root I/O stays an I/O failure.
    if (
      cause instanceof DirectoryArtifactRootFailure &&
      cause.reason === "io"
    ) {
      const code = selectionErrorCode(cause.cause);
      if (code !== undefined)
        return new AnalysisInputError(OPERATION, { cause, ...options }, [
          {
            path: ["path"],
            reason: "invalid_value",
            message: `No directory can be read at the selected path (${code}): ${input.path}.`,
          },
        ]);
    }
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
    // A cancelled read goes to the shared cancellation path.
    if (cause instanceof ArtifactReaderFailure && cause.reason !== "cancelled")
      return translateArtifactFailure(OPERATION, cause);
    return undefined;
  },
  // A file read whose handle close failed reports its own parse outcome as
  // primary, with the unresolved close bound to that read's exact lease.
  readCleanup: (read, primary) => {
    if (primary === undefined) {
      const failure = translateArtifactFailure(OPERATION, read);
      bindArtifactFileCleanup(read, failure);
      return failure;
    }
    const cleanup = new ProviderCleanupError(
      OCI_IMAGE_LAYOUT_PROVIDER_IDENTITY.id,
      read.cleanup.resources,
      { reason: read.cleanup.reason },
      { operation: OPERATION, cause: read },
    );
    bindArtifactFileCleanup(read, cleanup);
    return analysisErrorWithCleanupDependencies(primary, cleanup, OPERATION);
  },
  unclassified: (cause, details) => {
    const observation = layoutPartial(cause);
    return new ArtifactOperationError(
      OPERATION,
      "io",
      undefined,
      errorMessage(cause),
      {
        cause,
        ...details,
        ...(observation === undefined
          ? {}
          : { partialObservation: observation }),
      },
    );
  },
});

const layoutFailure = (cause: unknown, input: InspectOciImageLayoutInput) =>
  classifyProviderFailure(cause, layoutFailureDialect(input));

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
          // A completed inventory survives as the cleanup failure's partial.
          if (outcome.kind === "completed")
            throw this.#resources.cleanupFailure(
              outcome,
              [closed],
              createOciImageLayoutEvidence(
                OCI_IMAGE_LAYOUT_PROVIDER_IDENTITY,
                input,
                outcome.value,
              ),
            );
          const cleanup = this.#resources.cleanupFailure(
            { kind: "completed" },
            [closed],
          );
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
