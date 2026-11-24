import {
  artifactFilePrimaryFacts,
  projectArtifactCloseFailure,
  projectStableArtifactFailure,
  type StableArtifactSnapshot,
  readStableArtifact,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { NeExecutablePort } from "../../ports/binaryDiagnostics/NeExecutablePort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { AnalysisControlLimit } from "../../domain/analysisSettings.js";
import {
  MAX_INSPECT_NE_FILE_BYTES,
  MAX_INSPECT_NE_TABLE_ROWS,
  MIN_INSPECT_NE_FILE_BYTES,
  MIN_INSPECT_NE_TABLE_ROWS,
  DEFAULT_INSPECT_NE_FILE_BYTES,
  DEFAULT_INSPECT_NE_TABLE_ROWS,
  type InspectNeExecutableInput,
} from "../../domain/native/neExecutable.js";
import { err, ok } from "../../domain/result.js";
import { NE_EXECUTABLE_PROVIDER } from "../../domain/investigationProviders.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";
import { fixedNativeAllowance } from "../../domain/native/nativeDeadlines.js";
import { decodeLimit } from "../../domain/parseFailure.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import { NE_FORMAT, parseNeExecutable } from "./NeExecutableParser.js";

const OPERATION = "inspect_ne_executable";

/** Portable parser over one bounded, identity-checked regular file. */
export class NeExecutableProvider implements NeExecutablePort {
  readonly identity = NE_EXECUTABLE_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        NE_EXECUTABLE_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(input: InspectNeExecutableInput, options?: ExecutionOptions) {
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
          await parseNeExecutable(
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
      return err(neExecutableFailure(cause, input, snapshot));
    }
  }
}

/**
 * Remediation for a caller-selected budget refusal. At the schema ceiling
 * there is no value left to raise the bound to, so the advice names the
 * ceiling instead of an impossible raise.
 */
const budgetRemediation = (
  boundary: "file-size" | "capacity",
  input: InspectNeExecutableInput,
): string =>
  boundary === "file-size"
    ? input.max_file_bytes >= MAX_INSPECT_NE_FILE_BYTES
      ? `The image exceeds the ${String(MAX_INSPECT_NE_FILE_BYTES)}-byte input ceiling this operation accepts. This release has no runtime override. Select a smaller artifact.`
      : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`
    : input.max_rows >= MAX_INSPECT_NE_TABLE_ROWS
      ? `The image exceeds the ${String(MAX_INSPECT_NE_TABLE_ROWS)}-row table ceiling this operation accepts. This release has no runtime override. Select a smaller artifact.`
      : `Raise max_rows above ${String(input.max_rows)} or select a smaller artifact; the limit is the caller-selected table row budget.`;

const BUDGETS = {
  "file-size": {
    parameter: "max_file_bytes",
    unit: "bytes",
    minimum: MIN_INSPECT_NE_FILE_BYTES,
    maximum: MAX_INSPECT_NE_FILE_BYTES,
    default_value: DEFAULT_INSPECT_NE_FILE_BYTES,
  },
  capacity: {
    parameter: "max_rows",
    unit: "count",
    minimum: MIN_INSPECT_NE_TABLE_ROWS,
    maximum: MAX_INSPECT_NE_TABLE_ROWS,
    default_value: DEFAULT_INSPECT_NE_TABLE_ROWS,
  },
} as const;

/** The per-call control of an exhausted budget, while a larger value is selectable. */
const budgetLimit = (
  boundary: "file-size" | "capacity",
  input: InspectNeExecutableInput,
): { readonly limit?: AnalysisControlLimit } => {
  const { parameter, ...control } = BUDGETS[boundary];
  const value = input[parameter];
  return value < control.maximum
    ? {
        limit: {
          control_kind: "parameter",
          parameter,
          effective_value: value,
          ...control,
          applies_at: "next_call",
        },
      }
    : {};
};

const neExecutableFailure = (
  cause: unknown,
  input: InspectNeExecutableInput,
  snapshot?: StableArtifactSnapshot,
) => {
  const facts = artifactFilePrimaryFacts(cause);
  return projectStableArtifactFailure(
    cause,
    classifyProviderFailure(
      facts.cause,
      offlineArtifactFailureDialect(facts, {
        operation: OPERATION,
        providerId: NE_EXECUTABLE_PROVIDER.id,
        path: input.path,
        description: "NE image",
        fallbackMessage: "NE artifact inspection failed.",
        recognise: (failure) => {
          const reportedLimitContext = {
            max_file_bytes: input.max_file_bytes,
            max_rows: input.max_rows,
          };
          if (isParseLimit(failure, NE_FORMAT))
            return failure.failure.limit.name === "max_rows"
              ? parseLimitConstraint(OPERATION, "capacity", failure, {
                  reportedLimitContext,
                  // The row budget is caller-selected and deterministic for
                  // the same input, so waiting cannot help.
                  retryable: false,
                  remediationAction: budgetRemediation("capacity", input),
                  ...budgetLimit("capacity", input),
                })
              : parseLimitConstraint(OPERATION, "memory", failure, {
                  reportedLimitContext,
                  ...fixedNativeAllowance(
                    "The NE metadata allowance",
                    "parser",
                    failure.failure.limit.maximum,
                    "bytes",
                  ),
                });
          return undefined;
        },
        fileSize: (failure) =>
          parseLimitConstraint(
            OPERATION,
            "file-size",
            decodeLimit(
              NE_FORMAT,
              failure.message,
              { name: "max_file_bytes", maximum: input.max_file_bytes },
              { cause: failure },
            ),
            {
              reportedLimitContext: {
                max_file_bytes: input.max_file_bytes,
                max_rows: input.max_rows,
              },
              retryable: false,
              remediationAction: budgetRemediation("file-size", input),
              ...budgetLimit("file-size", input),
            },
          ),
      }),
    ),
    input.path,
    NE_EXECUTABLE_PROVIDER.id,
    OPERATION,
    snapshot,
  );
};
