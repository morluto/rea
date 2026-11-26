import { randomUUID } from "node:crypto";
import { parse } from "node:path";

import {
  YARA_COMMAND_REMEDIATION,
  YARA_PROVIDER_IDENTITY,
} from "./YaraProviderIdentity.js";
import {
  parseYaraDiagnostics,
  yaraMatchOutputSink,
  YaraMatchOutputParser,
  type YaraDiagnostics,
  type YaraParsedMatches,
} from "./YaraOutput.js";
import {
  ArtifactResourceScope,
  artifactFilePrimaryFacts,
  assertArtifactReadActive,
  closeArtifactResources,
  projectStableArtifactFailure,
  withStableArtifactHandle,
  type RequestField,
} from "../resources/index.js";
import {
  prepareOwnedCommand,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type {
  OwnedProviderProcessSpawnOptions,
  ProviderProcessSnapshot,
  SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import { providerOutcomeOf } from "../process/ProviderOutcome.js";
import { capturedProviderOutput } from "../process/capturedProviderOutput.js";
import { describeLaunchFailure } from "../process/launchFailure.js";
import {
  classifyProviderOutcome,
  type ProviderOutcomeContext,
} from "../process/classifyProviderOutcome.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import {
  processInspectionCancellationError,
  retainArtifactCommandCleanup,
  retainProcessInspectionCleanup,
} from "../providers/OwnedCommandCleanup.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../providers/offlineArtifactFailure.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import type { AnalysisErrorOptions } from "../domain/analysisErrorBase.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { decodeLimit } from "../domain/parseFailure.js";
import { parseLimitConstraint } from "../domain/parseFailureAnalysisError.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { analysisSettingLimit } from "../domain/analysisSettingDefinitions.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  INSPECT_YARA_MATCHES_OPERATION,
  YARA_FILE_BYTES,
  yaraFileBytesLimit,
  type InspectYaraMatchesInput,
  type YaraMatches,
  type YaraScanSettings,
} from "../domain/yara/yaraMatches.js";
import type {
  YaraMatchesPort,
  YaraScanRequest,
} from "../ports/yara/YaraMatchesPort.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";

const OPERATION = INSPECT_YARA_MATCHES_OPERATION;
const PROVIDER_ID = YARA_PROVIDER_IDENTITY.id;
/** Names the admission whose byte limit refused a selected file. */
const YARA_SCAN_FORMAT = "yara-scan";

/**
 * yara options: print matching strings with their lengths, metadata and
 * tags, and suppress console-module output so stdout carries only matches.
 */
const BASE_ARGUMENTS = ["-s", "-L", "-m", "-g", "-q"] as const;

/** Starts the yara process under owned supervision; tests substitute one. */
export type YaraLauncher = (
  options: OwnedProviderProcessSpawnOptions,
) => Promise<SpawnedOwnedProviderProcess>;

/** The executable to launch, or why the configured command cannot be used. */
export type YaraCommandSelection = () => Result<string, AnalysisError>;

export interface YaraMatchesProviderOptions {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly selectCommand: YaraCommandSelection;
  readonly platform?: NodeJS.Platform;
  readonly launcher?: YaraLauncher;
}

/** The selected file a failed phase was reading. */
interface ReadPhase {
  readonly path: string;
  readonly field: RequestField;
  readonly description: string;
}

/**
 * The namespace every rule file is compiled into. yara 4 reads a rule
 * argument as a file path, relative to its working directory, when that
 * file exists, and otherwise splits it at the first `:` into NAMESPACE:FILE.
 * A bare path that contains `:` and is replaced after it was hashed would
 * therefore compile a different file. With this prefix and the working
 * directory at the filesystem root, the whole argument names no file, so
 * yara takes the explicit namespace and reads the rest of the argument
 * verbatim as the hashed path.
 */
const RULE_NAMESPACE = "rea";

/** The argv yara receives; every path is absolute, so none parses as an option. */
const yaraArguments = (input: InspectYaraMatchesInput): readonly string[] => [
  ...BASE_ARGUMENTS,
  ...(input.fast_scan === true ? ["-f"] : []),
  ...input.rule_paths.map((path) => `${RULE_NAMESPACE}:${path}`),
  input.path,
];

/** The selected rule file yara named in a compile error, if it is one. */
const ruleFileIndex = (
  input: InspectYaraMatchesInput,
  source: string,
): number => {
  const prefix = `${RULE_NAMESPACE}:`;
  const named = source.startsWith(prefix)
    ? source.slice(prefix.length)
    : source;
  return input.rule_paths.indexOf(named);
};

/**
 * yara prints one match per line and names the scanned path on each rule
 * line, so a line break in a selected path makes its output ambiguous.
 */
const lineBreakRefusal = (
  input: InspectYaraMatchesInput,
): AnalysisInputError | undefined => {
  const fields: { path: (string | number)[]; value: string }[] = [
    { path: ["path"], value: input.path },
    ...input.rule_paths.map((value, index) => ({
      path: ["rule_paths", index],
      value,
    })),
  ];
  const issues = fields
    .filter(({ value }) => /[\r\n]/u.test(value))
    .map(({ path }) => ({
      path,
      reason: "invalid_value" as const,
      message:
        "The path contains a line break, which yara's line-oriented output cannot represent.",
    }));
  return issues.length === 0
    ? undefined
    : new AnalysisInputError(
        OPERATION,
        {
          conformsToInputContract: true,
          remediationAction:
            "Rename or link the file to a path without line breaks, then retry.",
        },
        issues,
      );
};

const RULE_COMPILE_REMEDIATION =
  "Fix the reported rule source, or remove that file from rule_paths, then retry. Rule names must be unique across all selected files, and rules that need external variables or module data cannot be compiled by this tool.";

/** A rule source yara refused to compile is the caller's selection. */
const ruleCompileError = (
  diagnostics: YaraDiagnostics,
  input: InspectYaraMatchesInput,
  details: AnalysisErrorOptions,
): AnalysisInputError => {
  const issues = diagnostics.compileErrors.map((failure) => {
    const index = ruleFileIndex(input, failure.source);
    return {
      path: index === -1 ? ["rule_paths"] : ["rule_paths", index],
      reason: "invalid_value" as const,
      message: `${failure.source}${failure.line === null ? "" : `(${String(failure.line)})`}: ${failure.message}`,
    };
  });
  return new AnalysisInputError(
    OPERATION,
    {
      ...details,
      conformsToInputContract: true,
      userMessage: `yara could not compile the selected rules: ${issues.map((issue) => issue.message).join("; ")}`,
      remediationAction: RULE_COMPILE_REMEDIATION,
      diagnostics: {
        ...details.diagnostics,
        compile_errors: diagnostics.compileErrors.map((failure) => ({
          ...failure,
        })),
      },
    },
    issues,
  );
};

/** What one yara outcome means; owner-observed facts are shared. */
const yaraOutcomeContext = (
  input: InspectYaraMatchesInput,
  settings: YaraScanSettings,
  command: string,
): ProviderOutcomeContext => ({
  providerId: PROVIDER_ID,
  operation: OPERATION,
  capturedOutput: capturedProviderOutput,
  details: { diagnostics: { command } },
  timeout: {
    ms: settings.command_timeout_ms.value,
    limit: analysisSettingLimit(
      "yara.command_timeout_ms",
      settings.command_timeout_ms.value,
      settings.command_timeout_ms.source,
    ),
  },
  outputLimit: {
    reason: `yara output exceeded max_output_bytes (${String(settings.max_output_bytes.value)} bytes on stdout or stderr).`,
    limits: { max_output_bytes: settings.max_output_bytes.value },
    recovery: { retryable: false },
    limit: analysisSettingLimit(
      "yara.max_output_bytes",
      settings.max_output_bytes.value,
      settings.max_output_bytes.source,
    ),
  },
  launchUnavailable: (failure, details) => {
    const reason =
      failure.kind === "missing"
        ? `The yara command ${command} was not found (${describeLaunchFailure(failure)}).`
        : `The yara command ${command} could not be started (${describeLaunchFailure(failure)}).`;
    return new AnalysisCapabilityUnavailableError(
      PROVIDER_ID,
      OPERATION,
      reason,
      {
        ...details,
        userMessage: `${reason} ${YARA_COMMAND_REMEDIATION}`,
        remediationAction: YARA_COMMAND_REMEDIATION,
      },
    );
  },
  dialect: (outcome, details, unclassified) => {
    const diagnostics = parseYaraDiagnostics(
      outcome.output?.snapshot.stderr.text ?? "",
      input.path,
    );
    // yara exits 1 after printing why it refused the rules or the file.
    const reported =
      outcome.kind === "exited" &&
      outcome.exitCode === 1 &&
      outcome.signal === null &&
      !outcome.stopRequested &&
      outcome.output?.truncated === false;
    if (reported && diagnostics.compileErrors.length > 0)
      return ruleCompileError(diagnostics, input, details);
    return unclassified({
      diagnostics: {
        ...(diagnostics.scanErrors.length === 0
          ? {}
          : {
              scan_errors: diagnostics.scanErrors.map(({ reason }) => reason),
            }),
        ...(diagnostics.unrecognized.length === 0
          ? {}
          : { unrecognized_stderr_lines: diagnostics.unrecognized.length }),
      },
    });
  },
});

/**
 * Classify one yara run through the shared command outcome owner and move
 * any unresolved process cleanup to the provider scope, which retries it
 * before the next scan and on close.
 */
const yaraCommandFailure = (
  cause: unknown,
  context: ProviderOutcomeContext,
  resources: ArtifactResourceScope,
) => {
  if (cause instanceof AnalysisError) return cause;
  const outcome = providerOutcomeOf(cause);
  // A command that exited 0 failed only because its cleanup is unproven.
  if (
    outcome?.kind === "exited" &&
    outcome.exitCode === 0 &&
    outcome.signal === null
  ) {
    const [cleanup, ...more] = retainArtifactCommandCleanup(
      cause,
      resources,
      OPERATION,
      outcome.output === undefined
        ? undefined
        : { capturedOutput: capturedProviderOutput(outcome.output.snapshot) },
    );
    if (cleanup !== undefined)
      return more.reduce(
        (primary, failure) =>
          analysisErrorWithCleanupDependencies(primary, failure, OPERATION),
        cleanup,
      );
  }
  const primary =
    processInspectionCancellationError(cause, OPERATION) ??
    (outcome === undefined
      ? new ProviderAdapterError(PROVIDER_ID, OPERATION, { cause })
      : classifyProviderOutcome(outcome, context));
  return retainProcessInspectionCleanup(cause, primary, resources, OPERATION);
};

interface CompletedScan {
  readonly parsed: YaraParsedMatches;
  readonly warnings: readonly string[];
}

const limitations = (
  input: InspectYaraMatchesInput,
  parsed: YaraParsedMatches,
  settings: YaraScanSettings,
): string[] => [
  "REA ran the caller-selected yara command; its implementation and version are not observed.",
  "Rule files are hashed before the scan and their file identity is re-checked after it; their bytes are not hashed again. Files they include and module data that yara reads are not bound to this Evidence.",
  "Only matching rules are reported; a rule that is absent did not match this file under these rules.",
  "String data is yara's display text and may be shortened; read file_offset and length from the artifact for the exact bytes.",
  ...(parsed.listedStringMatches < parsed.stringMatches
    ? [
        `${String(parsed.stringMatches - parsed.listedStringMatches)} of ${String(parsed.stringMatches)} string matches are counted but not listed because max_matches is ${String(settings.max_matches.value)}.`,
      ]
    : []),
  ...(input.fast_scan === true
    ? [
        "fast_scan stops at the first match of each string, so string match counts are lower bounds.",
      ]
    : []),
];

/** Runs caller-supplied YARA rules against one stable local file. */
export class YaraMatchesProvider implements YaraMatchesPort {
  readonly identity = YARA_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  constructor(readonly options: YaraMatchesProviderOptions) {}

  /** Retry retained command and descriptor cleanup. */
  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      YARA_PROVIDER_IDENTITY,
      OPERATION,
    );
  }

  async inspect(
    { input, settings }: YaraScanRequest,
    options?: ExecutionOptions,
  ): Promise<Result<YaraMatches, AnalysisError>> {
    const signal = options?.signal;
    const maxFileBytes = input.max_file_bytes ?? YARA_FILE_BYTES.default_value;
    const refusal = lineBreakRefusal(input);
    if (refusal !== undefined) return err(refusal);
    const command = this.options.selectCommand();
    if (!command.ok) return err(command.error);
    let phase: ReadPhase | undefined;
    let identity:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () => {
        const ruleFiles: YaraMatches["rule_files"][number][] = [];
        const rulePhase = (index: number, path: string): ReadPhase => ({
          path,
          field: ["rule_paths", index],
          description: "rule file",
        });
        // yara reopens each rule file by path. Every rule descriptor stays
        // open across the scan and is re-verified the same way as the
        // scanned file before it closes, so a rule file replaced or edited
        // in place between hashing and compiling fails as artifact_changed.
        const holdRuleFiles = async (index: number): Promise<YaraMatches> => {
          const path = input.rule_paths[index];
          if (path === undefined) return scanFile();
          phase = rulePhase(index, path);
          return withStableArtifactHandle(
            path,
            maxFileBytes,
            { retainBytes: () => 0, signal, resourceScope: this.#resources },
            async (handle): Promise<YaraMatches> => {
              ruleFiles.push({
                path,
                sha256: handle.sha256,
                bytes: handle.size,
              });
              const value = await holdRuleFiles(index + 1);
              // The re-verification that follows names this rule file.
              phase = rulePhase(index, path);
              return value;
            },
          );
        };
        const scanFile = async (): Promise<YaraMatches> => {
          phase = { path: input.path, field: "path", description: "file" };
          // The descriptor stays open across the scan and the file is
          // re-verified before it closes, so matches belong to this digest.
          return withStableArtifactHandle(
            input.path,
            maxFileBytes,
            {
              retainBytes: () => 0,
              signal,
              resourceScope: this.#resources,
              onIdentity: (verified) => {
                identity = verified;
              },
            },
            async (handle): Promise<YaraMatches> => {
              const { parsed, warnings } = await this.#scan(
                command.value,
                input,
                settings,
                signal,
              );
              assertArtifactReadActive(signal);
              return {
                artifact: {
                  path: input.path,
                  sha256: handle.sha256,
                  bytes: handle.size,
                },
                rule_files: ruleFiles,
                fast_scan: input.fast_scan === true,
                matches: [...parsed.matches],
                coverage: {
                  status:
                    parsed.listedStringMatches < parsed.stringMatches
                      ? "partial"
                      : "complete",
                  matched_rules: parsed.matches.length,
                  string_matches: parsed.stringMatches,
                  listed_string_matches: parsed.listedStringMatches,
                },
                limits: { ...settings, max_file_bytes: maxFileBytes },
                warnings: [...warnings],
                limitations: limitations(input, parsed, settings),
              };
            },
          );
        };
        const report = await holdRuleFiles(0);
        return ok(report);
      });
    } catch (cause: unknown) {
      return err(this.#failure(cause, input, phase, maxFileBytes, identity));
    }
  }

  async #scan(
    command: string,
    input: InspectYaraMatchesInput,
    settings: YaraScanSettings,
    signal: AbortSignal | undefined,
  ): Promise<CompletedScan> {
    const parser = new YaraMatchOutputParser(
      input.path,
      settings.max_matches.value,
    );
    const context = yaraOutcomeContext(input, settings, command);
    const maxOutputBytes = settings.max_output_bytes.value;
    let snapshot: ProviderProcessSnapshot;
    try {
      // Ownership preparation has its own deadline; it does not spend yara's.
      await prepareOwnedCommand(signal);
      snapshot = await runOwnedCommand(
        {
          command,
          arguments: yaraArguments(input),
          // See RULE_NAMESPACE: no relative path resolves to a rule file.
          cwd: parse(input.path).root,
          runId: `rea-yara-${randomUUID()}`,
          hostEnvironment: {
            ...snapshotEnvironment(
              this.options.environment,
              this.options.platform ?? HOST_PLATFORM.platform,
            ),
            LC_ALL: "C",
            LANG: "C",
          },
        },
        {
          timeoutMs: settings.command_timeout_ms.value,
          diagnosticBytes: maxOutputBytes,
          stdout: yaraMatchOutputSink(parser),
          maxStdoutBytes: maxOutputBytes,
        },
        {
          ...(signal === undefined ? {} : { signal }),
          ...(this.options.launcher === undefined
            ? {}
            : { launcher: this.options.launcher }),
        },
      );
    } catch (cause: unknown) {
      throw yaraCommandFailure(cause, context, this.#resources);
    }
    const parsed = parser.finish();
    if (!parsed.ok)
      throw new AnalysisOutputError(
        OPERATION,
        `yara stdout line ${String(parsed.error.line)} is not a documented match line: ${parsed.error.reason}.`,
        { capturedOutput: capturedProviderOutput(snapshot) },
      );
    const diagnostics = parseYaraDiagnostics(snapshot.stderr.text, input.path);
    return {
      parsed: parsed.value,
      warnings: [...diagnostics.warnings, ...diagnostics.unrecognized],
    };
  }

  #failure(
    cause: unknown,
    input: InspectYaraMatchesInput,
    phase: ReadPhase | undefined,
    maxFileBytes: number,
    identity: { readonly sha256: string; readonly bytes: number } | undefined,
  ) {
    const read = phase ?? {
      path: input.path,
      field: "path",
      description: "file",
    };
    const facts = artifactFilePrimaryFacts(cause);
    const primary = classifyProviderFailure(
      facts.cause,
      offlineArtifactFailureDialect(facts, {
        providerId: PROVIDER_ID,
        operation: OPERATION,
        path: read.path,
        description: read.description,
        field: read.field,
        fileSize: (failure) =>
          parseLimitConstraint(
            OPERATION,
            "file-size",
            decodeLimit(
              YARA_SCAN_FORMAT,
              failure.message,
              { name: "max_file_bytes", maximum: maxFileBytes },
              { cause: failure },
            ),
            {
              path: read.path,
              retryable: false,
              limit: yaraFileBytesLimit(maxFileBytes),
            },
          ),
      }),
    );
    // `primary` already names the failing `read.path`; once the scanned file's
    // identity is recorded, attribute the retained snapshot observation to
    // `input.path` even if a rule file's final check or close fails afterward.
    return projectStableArtifactFailure(
      cause,
      primary,
      identity === undefined ? read.path : input.path,
      PROVIDER_ID,
      OPERATION,
      identity,
    );
  }
}
