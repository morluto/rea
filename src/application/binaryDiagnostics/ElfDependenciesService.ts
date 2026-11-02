import { isAbsolute } from "node:path";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { ElfDependenciesPort } from "./ElfDependenciesPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  elfDependenciesSchema,
  inspectElfDependenciesInputSchema,
  type ElfDependencies,
  type InspectElfDependenciesInput,
} from "../../domain/native/elfDependencies.js";
import { BINARY_ARCHITECTURES } from "../../domain/binaryTargetTypes.js";
import { elfArchitecture } from "../../domain/elfFixedHeader.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

const OPERATION = "inspect_elf_dependencies";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class ElfDependenciesService {
  constructor(readonly provider: ElfDependenciesPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const input = parseAnalysisInput(
      OPERATION,
      rawInput,
      inspectElfDependenciesInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    if (!isAbsolute(input.value.path))
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok) return result;
    const report = elfDependenciesSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      !validReport(report.data, input.value)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "ELF dependency provider returned malformed output or changed artifact identity.",
        ),
      );
    const value = report.data;
    const mapped = elfArchitecture(value.machine);
    const architecture = BINARY_ARCHITECTURES.find(
      (supported) => supported === mapped,
    );
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          format: "elf",
          sha256: value.artifact.sha256,
          ...(architecture === undefined ? {} : { architecture }),
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: input.value,
          result: value,
          confidence: "observed",
          limitations: value.limitations,
          locations: [
            { kind: "artifact-path", path: value.artifact.path },
            ...rangesOf(value).map((range) => ({
              kind: "file-offset-range" as const,
              start: range.offset,
              end: range.offset + range.bytes,
            })),
          ],
        },
      ),
      options?.signal,
    );
  }
}

const rangesOf = (
  report: ElfDependencies,
): { offset: number; bytes: number }[] => {
  const found: { offset: number; bytes: number }[] = [];
  const add = (
    range: { offset: number; bytes: number } | null | undefined,
  ): void => {
    if (range !== null && range !== undefined) found.push(range);
  };
  add(report.interpreter.location);
  add(report.dynamic.location);
  add(report.version_requirements.location);
  add(report.version_definitions.location);
  return found;
};

const validReport = (
  report: ElfDependencies,
  input: InspectElfDependenciesInput,
): boolean => {
  if (
    report.artifact.bytes > input.max_file_bytes ||
    report.needed.length > input.max_needed ||
    report.imports.length > input.max_imports ||
    report.coverage.examined_versions > input.max_versions
  )
    return false;
  const fileBytes = report.artifact.bytes;
  return rangesOf(report).every(
    (range) =>
      range.bytes <= fileBytes && range.offset <= fileBytes - range.bytes,
  );
};
