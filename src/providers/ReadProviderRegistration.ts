import { WindowsChangeTimeConfigurationError } from "../config/windowsChangeTimeSettle.js";
import { errorMessage } from "../kernel/errorMessage.js";
import {
  AnalysisCancelledError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";
import { AnalysisCleanupLease } from "../resources/index.js";
import type { RetainedResourceScope } from "../ports/AnalysisProvider.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { safeParseUtf8Json } from "../domain/safeJson.js";
import {
  withOwnedRegularFile,
  regularFileCancellation,
  RegularFileCancelled,
  RegularFileCleanupFailure,
  type RegularFileOperationOutcome,
} from "../filesystem/OwnedRegularFile.js";
import {
  RegularFileOperationCancelled,
  NonRegularFileReadError,
} from "../filesystem/RegularFile.js";

const MAXIMUM_REGISTRATION_BYTES = 65_536;

/** Recover a content rejection that the descriptor owner retained through close. */
const completedRegistrationRejection = (
  outcome: RegularFileOperationOutcome<unknown>,
): ConfigurationError | undefined => {
  if (outcome.kind !== "completed") return undefined;
  const { value } = outcome;
  return typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === false &&
    "error" in value &&
    value.error instanceof ConfigurationError
    ? value.error
    : undefined;
};

/** Read one bounded registration while owning its descriptor through cancellation and final close. */
export const readProviderRegistration = <Value>(
  path: string,
  options: {
    readonly signal?: AbortSignal;
    readonly resourceScope: RetainedResourceScope;
  },
  format: {
    readonly setting: string;
    readonly label: string;
    readonly operation: string;
    readonly parse: (input: unknown) => Result<Value, ConfigurationError>;
  },
): Promise<Result<Value, ConfigurationError>> =>
  options.resourceScope.run(async () => {
    const configurationError = (
      constraint: string,
      cause?: unknown,
    ): ConfigurationError =>
      new ConfigurationError(constraint, {
        ...(cause === undefined ? {} : { cause }),
        settings: [{ setting: format.setting, constraint }],
      });
    const registrationTooLarge = () =>
      err(
        configurationError(
          `${format.setting} exceeds the 64 KiB registration size.`,
        ),
      );
    let closeLease: AnalysisCleanupLease | undefined;
    try {
      const input = await withOwnedRegularFile<
        Result<unknown, ConfigurationError>
      >(
        path,
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          retainFailedClose: (owner) => {
            closeLease = AnalysisCleanupLease.forCloseOwner(owner, path);
            options.resourceScope.retain(
              {
                close: () => closeLease!.release(),
                get cleanupResources() {
                  return closeLease!.cleanupResources;
                },
              },
              path,
            );
          },
        },
        async ({ handle, initial: metadata }) => {
          if (metadata.size > MAXIMUM_REGISTRATION_BYTES)
            return registrationTooLarge();
          const bytes = await readBoundedFileBytes(
            handle,
            MAXIMUM_REGISTRATION_BYTES,
            {
              signal: options.signal,
              expectedSize: metadata.size,
              cancellationFailure: (reason) =>
                new RegularFileOperationCancelled(reason),
            },
          );
          if (bytes === undefined) return registrationTooLarge();
          const parsed = safeParseUtf8Json(bytes);
          if (!parsed.ok)
            return err(
              configurationError(
                `${format.setting} must contain valid UTF-8 JSON.`,
              ),
            );
          return ok(parsed.value);
        },
      );
      return input.ok ? format.parse(input.value) : input;
    } catch (cause: unknown) {
      if (cause instanceof WindowsChangeTimeConfigurationError)
        return err(cause);
      if (cause instanceof NonRegularFileReadError)
        return err(
          configurationError(
            `${format.setting} must select a regular JSON file: ${path}`,
            cause,
          ),
        );
      if (cause instanceof AnalysisCancelledError) throw cause;
      const rejection =
        cause instanceof RegularFileCleanupFailure ||
        cause instanceof RegularFileCancelled
          ? completedRegistrationRejection(cause.outcome)
          : undefined;
      if (cause instanceof RegularFileCancelled && rejection !== undefined)
        return err(
          rejection.retainSecondaryFailure(
            cancelledBy(format.operation, carriedReason(cause.reason)),
          ),
        );
      const cancellation = regularFileCancellation(cause);
      if (cancellation !== undefined && rejection === undefined) {
        if (cause instanceof RegularFileCleanupFailure) {
          const error = cancelledBy(
            format.operation,
            carriedReason(cancellation.reason),
            {
              cleanup: {
                reason: errorMessage(cause.cleanupCause),
                resources: [path],
              },
            },
          );
          closeLease?.bindCleanupError(error);
          throw error;
        }
        throw cancelledBy(format.operation, carriedReason(cancellation.reason));
      }
      if (cause instanceof RegularFileCleanupFailure) {
        const primary =
          cause.outcome.kind === "failed"
            ? cause.outcome.cause
            : cause.cleanupCause;
        const primaryMessage =
          rejection?.message ??
          (cause.outcome.kind === "failed"
            ? primary instanceof ConfigurationError
              ? primary.message
              : primary instanceof NonRegularFileReadError
                ? `${format.setting} must select a regular JSON file: ${path}`
                : `Cannot read ${format.label} registration ${path}: ${errorMessage(primary)}`
            : `Cannot close ${format.label} registration ${path}; provide a readable JSON configuration.`);
        const error = new ConfigurationError(primaryMessage, {
          cause,
          cleanup: {
            reason: errorMessage(cause.cleanupCause),
            resources: [path],
          },
          settings: [
            {
              setting: format.setting,
              constraint: `Close remains incomplete for ${path}`,
            },
          ],
        });
        if (cancellation !== undefined)
          error.retainSecondaryFailure(
            cancelledBy(format.operation, carriedReason(cancellation.reason)),
          );
        closeLease?.bindCleanupError(error);
        return err(error);
      }
      return err(
        configurationError(
          `Cannot read ${format.label} registration ${path}; provide a readable JSON configuration.`,
          cause,
        ),
      );
    }
  });
