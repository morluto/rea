import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import type { RetainedResourceScope } from "../application/AnalysisProvider.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { err, type Result } from "../domain/result.js";
import {
  withOwnedRegularFile,
  regularFileCancellation,
  RegularFileCleanupFailure,
} from "../filesystem/OwnedRegularFile.js";
import {
  RegularFileOperationCancelled,
  NonRegularFileReadError,
} from "../filesystem/RegularFile.js";

const MAXIMUM_REGISTRATION_BYTES = 65_536;

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
      configurationError(
        `${format.setting} exceeds the 64 KiB registration size.`,
      );
    let closeLease: AnalysisCleanupLease | undefined;
    try {
      const text = await withOwnedRegularFile<string>(
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
            throw registrationTooLarge();
          const bytes = await readBoundedFileBytes(
            handle,
            MAXIMUM_REGISTRATION_BYTES,
            {
              signal: options.signal,
              cancellationFailure: (reason) =>
                new RegularFileOperationCancelled(reason),
            },
          );
          if (bytes === undefined) throw registrationTooLarge();
          return bytes.toString("utf8");
        },
      );
      return format.parse(JSON.parse(text));
    } catch (cause: unknown) {
      if (cause instanceof ConfigurationError) return err(cause);
      if (cause instanceof NonRegularFileReadError)
        return err(
          configurationError(
            `${format.setting} must select a regular JSON file: ${path}`,
            cause,
          ),
        );
      if (cause instanceof AnalysisCancelledError) throw cause;
      const cancellation = regularFileCancellation(cause);
      if (cancellation !== undefined) {
        if (cause instanceof RegularFileCleanupFailure) {
          const error = new AnalysisCancelledError(format.operation, {
            cause: cancellation.reason,
            cleanup: {
              reason:
                cause.cleanupCause instanceof Error
                  ? cause.cleanupCause.message
                  : String(cause.cleanupCause),
              resources: [path],
            },
          });
          closeLease?.bindCleanupError(error);
          throw error;
        }
        throw new AnalysisCancelledError(format.operation, {
          cause: cancellation.reason,
        });
      }
      if (cause instanceof RegularFileCleanupFailure) {
        const primary =
          cause.outcome.kind === "failed"
            ? cause.outcome.cause
            : cause.cleanupCause;
        const primaryMessage =
          cause.outcome.kind === "failed"
            ? primary instanceof ConfigurationError
              ? primary.message
              : primary instanceof NonRegularFileReadError
                ? `${format.setting} must select a regular JSON file: ${path}`
                : `Cannot read ${format.label} registration ${path}: ${primary instanceof Error ? primary.message : String(primary)}`
            : `Cannot close ${format.label} registration ${path}; provide a readable JSON configuration.`;
        const error = new ConfigurationError(primaryMessage, {
          cause,
          cleanup: {
            reason:
              cause.cleanupCause instanceof Error
                ? cause.cleanupCause.message
                : String(cause.cleanupCause),
            resources: [path],
          },
          settings: [
            {
              setting: format.setting,
              constraint: `Close remains incomplete for ${path}`,
            },
          ],
        });
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
