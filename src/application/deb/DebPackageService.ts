import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { DebPackagePort } from "../../ports/deb/DebPackagePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectDebPackageInputSchema,
  debPackageSchema,
  type InspectDebPackageInput,
} from "../../domain/deb/debPackage.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

const OPERATION = "inspect_deb_package";

/** Admitted values for only the fields the caller supplied; omitted budgets stay omitted. */
const callerSelectedParameters = (
  rawInput: unknown,
  input: InspectDebPackageInput,
): Partial<InspectDebPackageInput> =>
  Object.fromEntries(
    Object.entries(input).filter(
      ([key]) =>
        typeof rawInput === "object" &&
        rawInput !== null &&
        Object.hasOwn(rawInput, key),
    ),
  );

/** Shared caller validation, output parsing and Evidence provenance for CLI and MCP. */
export class DebPackageService {
  constructor(readonly provider: DebPackagePort) {}

  close(): Promise<void> {
    return this.provider.close();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const input = parseAnalysisInput(
      OPERATION,
      rawInput,
      inspectDebPackageInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok) return result;
    const report = debPackageSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      report.data.artifact.bytes > input.value.max_file_bytes ||
      report.data.coverage.ar_members > input.value.max_ar_members ||
      report.data.coverage.control_entries > input.value.max_control_entries ||
      report.data.coverage.data_entries > input.value.max_data_entries
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Debian package provider returned malformed output or changed artifact identity.",
        ),
      );
    const value = report.data;
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          format: "file",
          sha256: value.artifact.sha256,
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: callerSelectedParameters(rawInput, input.value),
          result: value,
          confidence: "observed",
          limitations: value.limitations,
          locations: [
            { kind: "artifact-path", path: value.artifact.path },
            {
              kind: "file-offset-range",
              start: 0,
              end: value.artifact.bytes,
            },
          ],
        },
      ),
      options?.signal,
    );
  }
}
