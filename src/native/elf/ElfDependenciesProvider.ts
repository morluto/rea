import { setImmediate as immediate } from "node:timers/promises";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import { decodeLimit } from "../../domain/parseFailure.js";
import {
  closeArtifactResources,
  projectStableArtifactFailure,
  withStableArtifactHandle,
  artifactFilePrimaryFacts,
  ArtifactResourceScope,
  assertArtifactReadActive,
} from "../../resources/index.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  elfDependencyBudgetLimit,
  type ElfDependencies,
  type InspectElfDependenciesInput,
} from "../../domain/native/elfDependencies.js";
import { err, ok } from "../../domain/result.js";
import { ELF_DEPENDENCIES_PROVIDER } from "../../domain/investigationProviders.js";
import { parseElfDependenciesFromHandle } from "./ElfDependencyParser.js";

const OPERATION = "inspect_elf_dependencies";
const HEADER_PREFIX_BYTES = 4096;

/** Portable parser over one bounded, identity-checked regular file. */
/**
 * Satisfies ElfDependenciesPort structurally; composition
 * checks the fit, so this provider does not import the application layer.
 */
export class ElfDependenciesProvider {
  readonly identity = ELF_DEPENDENCIES_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      ELF_DEPENDENCIES_PROVIDER,
      OPERATION,
    );
  }

  async inspect(
    input: InspectElfDependenciesInput,
    options?: { readonly signal?: AbortSignal },
  ) {
    let completed: ElfDependencies | undefined;
    let observed:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () => {
        const result = await withStableArtifactHandle<ElfDependencies>(
          input.path,
          input.max_file_bytes,
          {
            signal: options?.signal,
            resourceScope: this.#resources,
            retainBytes: (size) => Math.min(size, HEADER_PREFIX_BYTES),
            onIdentity: (identity) => {
              observed = identity;
            },
            onVerifiedResult: (value) => {
              completed = value;
            },
          },
          async (handle) => {
            assertArtifactReadActive(options?.signal);
            const parsed = await parseElfDependenciesFromHandle(
              handle,
              {
                path: input.path,
                sha256: handle.sha256,
                bytes: handle.size,
              },
              input,
              async () => {
                await immediate();
                assertArtifactReadActive(options?.signal);
              },
            );
            assertArtifactReadActive(options?.signal);
            return parsed;
          },
        );
        return ok(result);
      });
    } catch (cause) {
      return err(elfDependenciesFailure(cause, input, observed, completed));
    }
  }
}

/** The count budgets the parser names in its limit. */
const COUNT_BUDGETS = ["max_needed", "max_versions", "max_imports"] as const;

const elfDependenciesFailure = (
  cause: unknown,
  input: InspectElfDependenciesInput,
  observed: { readonly sha256: string; readonly bytes: number } | undefined,
  completed?: ElfDependencies,
) => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: ELF_DEPENDENCIES_PROVIDER.id,
      operation: OPERATION,
      path: input.path,
      description: "ELF image",
      fallbackMessage: "ELF dependency inspection failed.",
      recognise: (failure) => {
        if (isParseLimit(failure, "elf-dependencies")) {
          const limit = failure.failure.limit;
          const parameter = COUNT_BUDGETS.find((name) => name === limit.name);
          if (parameter !== undefined)
            return parseLimitConstraint(OPERATION, "capacity", failure, {
              path: input.path,
              retryable: false,
              limit: elfDependencyBudgetLimit(parameter, limit.maximum),
            });
          const text =
            limit.name === "scanned_text_bytes" ||
            limit.name === "retained_text_bytes";
          const work = limit.name === "gnu_hash_entries";
          return parseLimitConstraint(
            OPERATION,
            text ? "memory" : work ? "cpu" : "capacity",
            failure,
            {
              path: input.path,
              ...fixedAllowanceOptions(
                text
                  ? "The ELF dependency text budget fixed by the admitted image length"
                  : `The ELF dependency ${limit.name} allowance`,
                text ? "parser" : work ? "work" : "count",
                { limit: limit.maximum, unit: text ? "bytes" : "entries" },
              ),
            },
          );
        }
        return undefined;
      },
      fileSize: (failure) =>
        parseLimitConstraint(
          OPERATION,
          "file-size",
          decodeLimit(
            "elf-dependencies",
            failure.message,
            { name: "max_file_bytes", maximum: input.max_file_bytes },
            { cause: failure },
          ),
          {
            path: input.path,
            retryable: false,
            limit: elfDependencyBudgetLimit(
              "max_file_bytes",
              input.max_file_bytes,
            ),
          },
        ),
    }),
  );
  if (completed !== undefined) primary.retainPartialObservation(completed);
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    ELF_DEPENDENCIES_PROVIDER.id,
    OPERATION,
    observed,
  );
};
