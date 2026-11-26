import { resolveYaraScanSettings } from "../../config/yaraScanLimits.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import type { AnalysisSettingsReader } from "../../domain/analysisSettings.js";
import type { Evidence } from "../../domain/evidence.js";
import { err, type Result } from "../../domain/result.js";
import {
  INSPECT_YARA_MATCHES_OPERATION,
  inspectYaraMatchesInputSchema,
  YARA_FILE_BYTES,
  yaraMatchesSchema,
  type InspectYaraMatchesInput,
  type YaraMatches,
  type YaraScanSettings,
} from "../../domain/yara/yaraMatches.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { YaraMatchesPort } from "../../ports/yara/YaraMatchesPort.js";
import {
  callerAnalysisParameters,
  parseAnalysisInput,
} from "../AnalysisInput.js";
import { observedFileEvidence } from "../observedFileEvidence.js";
import {
  completeProviderEvidence,
  retainCompletedArtifactEvidence,
} from "../ProviderOperationExecution.js";

const OPERATION = INSPECT_YARA_MATCHES_OPERATION;

/** Shared caller validation, limit resolution and Evidence provenance for CLI/MCP. */
export class YaraMatchesService {
  constructor(
    readonly provider: YaraMatchesPort,
    readonly environment: Readonly<Record<string, string | undefined>>,
    readonly settings?: AnalysisSettingsReader,
  ) {}

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
      inspectYaraMatchesInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const settings = resolveYaraScanSettings(
      input.value,
      this.environment,
      this.settings,
    );
    if (!settings.ok) return settings;
    const parameters = callerAnalysisParameters(rawInput)(input.value);
    const buildEvidence = (report: YaraMatches): Evidence =>
      observedFileEvidence(
        report,
        this.provider.identity,
        OPERATION,
        parameters,
        report.rule_files.map(({ path }) => ({
          kind: "artifact-path" as const,
          path,
        })),
      );
    const inspected = await this.provider.inspect(
      { input: input.value, settings: settings.value },
      options,
    );
    if (!inspected.ok) {
      const partial = yaraMatchesSchema.safeParse(
        inspected.error.partialObservation,
      );
      if (
        partial.success &&
        validReport(partial.data, input.value, settings.value)
      )
        retainCompletedArtifactEvidence(
          inspected.error,
          buildEvidence(partial.data),
        );
      return inspected;
    }
    const report = yaraMatchesSchema.safeParse(inspected.value);
    if (
      !report.success ||
      !validReport(report.data, input.value, settings.value)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "yara provider returned malformed output or changed the selected file identity.",
        ),
      );
    return completeProviderEvidence(
      buildEvidence(report.data),
      options?.signal,
    );
  }
}

const validReport = (
  report: YaraMatches,
  input: InspectYaraMatchesInput,
  settings: YaraScanSettings,
): boolean => {
  const listed = report.matches.reduce(
    (total, match) => total + match.strings.length,
    0,
  );
  const counted = report.matches.reduce(
    (total, match) => total + match.string_match_count,
    0,
  );
  return (
    report.artifact.path === input.path &&
    JSON.stringify(report.rule_files.map(({ path }) => path)) ===
      JSON.stringify(input.rule_paths) &&
    report.fast_scan === (input.fast_scan === true) &&
    JSON.stringify(report.limits) ===
      JSON.stringify({
        ...settings,
        max_file_bytes: input.max_file_bytes ?? YARA_FILE_BYTES.default_value,
      }) &&
    report.coverage.matched_rules === report.matches.length &&
    report.coverage.listed_string_matches === listed &&
    report.coverage.string_matches === counted &&
    listed <= settings.max_matches.value &&
    report.coverage.status === (listed < counted ? "partial" : "complete")
  );
};
