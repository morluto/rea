import {
  ArtifactReaderFailure,
  ArtifactResourceScope,
  artifactFilePrimaryFacts,
  projectArtifactCloseFailure,
  projectStableArtifactFailure,
  readStableArtifact,
  translateArtifactFailure,
} from "../resources/index.js";
import type { BrowserExtensionPort } from "../ports/browserExtension/BrowserExtensionPort.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import type { AnalysisControlLimit } from "../domain/analysisSettings.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import {
  cancelledBy,
  fixedCeilingConstraint,
} from "../domain/analysisErrorCore.js";
import {
  BROWSER_EXTENSION_BUDGETS,
  type InspectBrowserExtensionInput,
} from "../domain/browserExtension/browserExtension.js";
import { decodeLimit, type ParseFailureError } from "../domain/parseFailure.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import { err, ok } from "../domain/result.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { isAbortOf } from "../process/SignalAbort.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../providers/offlineArtifactFailure.js";
import { BROWSER_EXTENSION_PROVIDER } from "./BrowserExtensionProviderIdentity.js";
import {
  BROWSER_EXTENSION_FORMAT,
  type BrowserExtensionBudget,
  parseBrowserExtension,
} from "./parseBrowserExtension.js";

const OPERATION = "inspect_browser_extension";

const isBudget = (name: string): name is BrowserExtensionBudget =>
  Object.hasOwn(BROWSER_EXTENSION_BUDGETS, name);

/**
 * Recovery for an exhausted limit: a caller budget names its per-call control
 * while a larger value is selectable; a fixed projection bound says that no
 * caller budget applies.
 */
const budgetRecovery = (
  name: string,
  input: InspectBrowserExtensionInput,
): {
  readonly remediationAction: string;
  readonly limit?: AnalysisControlLimit;
} => {
  if (!isBudget(name))
    return {
      remediationAction:
        "This manifest field exceeds a fixed projection limit. Select a smaller manifest. Caller byte and entry budgets do not apply.",
    };
  const budget = BROWSER_EXTENSION_BUDGETS[name];
  const value = input[name];
  if (value >= budget.maximum)
    return {
      remediationAction: `${name} is at this operation's maximum of ${String(budget.maximum)}; select a smaller artifact.`,
    };
  return {
    remediationAction: `Raise ${name} above ${String(value)}, up to ${String(budget.maximum)}, or select a smaller artifact.`,
    limit: {
      control_kind: "parameter",
      parameter: name,
      effective_value: value,
      unit: budget.unit,
      minimum: budget.minimum,
      maximum: budget.maximum,
      default_value: budget.default_value,
      applies_at: "next_call",
    },
  };
};

const limitRefusal = (
  failure: ParseFailureError<"limit">,
  input: InspectBrowserExtensionInput,
) => {
  const { name } = failure.failure.limit;
  return parseLimitConstraint(
    OPERATION,
    name === "max_manifest_bytes" || name === "max_file_bytes"
      ? "file-size"
      : "capacity",
    failure,
    {
      path: input.path,
      retryable: false,
      reportedLimitContext: {
        max_file_bytes: input.max_file_bytes,
        max_manifest_bytes: input.max_manifest_bytes,
        max_entries: input.max_entries,
      },
      ...budgetRecovery(name, input),
    },
  );
};

const browserExtensionFailure = (
  cause: unknown,
  input: InspectBrowserExtensionInput,
  signal: AbortSignal | undefined,
) => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: BROWSER_EXTENSION_PROVIDER.id,
      operation: OPERATION,
      path: input.path,
      description: "browser extension package",
      recognise: (failure, origin) => {
        if (isAbortOf(failure, signal)) return cancelledBy(OPERATION, signal);
        if (isParseLimit(failure, BROWSER_EXTENSION_FORMAT))
          return limitRefusal(failure, input);
        if (
          origin === "owned-or-classified" &&
          failure instanceof ArtifactReaderFailure
        ) {
          if (
            failure.reason === "limit" &&
            failure.fixedAllowance !== undefined
          )
            return fixedCeilingConstraint(
              OPERATION,
              failure.boundary ?? "memory",
              failure.message,
              failure.fixedAllowance,
              { cause: failure },
            );
          if (failure.reason === "limit" && failure.boundary === "file-size")
            return undefined;
          if (
            failure.reason !== "path" &&
            failure.reason !== "integrity" &&
            failure.reason !== "cancelled"
          )
            return translateArtifactFailure(OPERATION, failure);
        }
        return undefined;
      },
      fileSize: (failure) =>
        limitRefusal(
          decodeLimit(
            BROWSER_EXTENSION_FORMAT,
            failure.message,
            { name: "max_file_bytes", maximum: input.max_file_bytes },
            { cause: failure },
          ),
          input,
        ),
      unclassified: (failure) =>
        new ArtifactOperationError(
          OPERATION,
          "io",
          undefined,
          errorMessage(failure),
          { cause: failure },
        ),
    }),
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    BROWSER_EXTENSION_PROVIDER.id,
    OPERATION,
  );
};

/** Portable parser over one bounded, identity-checked regular file. */
export class BrowserExtensionProvider implements BrowserExtensionPort {
  readonly identity = BROWSER_EXTENSION_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        BROWSER_EXTENSION_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(
    input: InspectBrowserExtensionInput,
    options?: ExecutionOptions,
  ) {
    try {
      return await this.#resources.run(async () => {
        const snapshot = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        return ok(
          await parseBrowserExtension(
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
      return err(browserExtensionFailure(cause, input, options?.signal));
    }
  }
}
