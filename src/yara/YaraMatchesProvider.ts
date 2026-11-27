import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join, posix, win32 } from "node:path";

import { isQualifiedCallerPath } from "../filesystem/callerPath.js";

import {
  YARA_COMMAND_REMEDIATION,
  YARA_PROVIDER_IDENTITY,
} from "./YaraProviderIdentity.js";
import {
  parseYaraDiagnostics,
  yaraMatchOutputSink,
  YaraMatchOutputParser,
  type YaraCompileErrorKind,
  type YaraDiagnostics,
  type YaraParsedMatches,
} from "./YaraOutput.js";
import {
  createYaraIncludeRewriter,
  type YaraIncludeRewriter,
} from "./YaraRuleIncludeRewrite.js";
import {
  AnalysisCleanupLease,
  ArtifactReaderFailure,
  ArtifactResourceScope,
  artifactFilePrimaryFacts,
  assertArtifactReadActive,
  assertStableArtifactState,
  closeArtifactResources,
  completedStableArtifactObservation,
  completedStableArtifactStream,
  projectStableArtifactFailure,
  streamStableArtifact,
  withArtifactFileHandle,
  type RequestField,
} from "../resources/index.js";
import {
  OwnedCommandFailure,
  prepareOwnedCommand,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { privateWorkspaceFailure } from "../process/privateWorkspaceFailure.js";
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
import {
  AnalysisError,
  primaryAnalysisError,
} from "../domain/analysisErrorBase.js";
import type { AnalysisErrorOptions } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { decodeLimit } from "../domain/parseFailure.js";
import { parseLimitConstraint } from "../domain/parseFailureAnalysisError.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { analysisSettingLimit } from "../domain/analysisSettingDefinitions.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  RuntimeControlUnavailableError,
  runtimeControlCapabilityError,
} from "../domain/runtimeControlUnavailableError.js";
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
  readonly createRuntime?: () => Promise<
    Pick<PrivateRuntimeRoot, "path" | "close">
  >;
  readonly openSnapshotFile?: (path: string) => Promise<FileHandle>;
}

/** The selected file a failed phase was reading. */
interface ReadPhase {
  readonly path: string;
  readonly field: RequestField;
  readonly description: string;
}

/** One selected file's completed digest and byte count before later failures. */
interface CompletedFileIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Completed admitted file identities accumulated during one scan call. */
interface CompletedAdmittedFiles {
  readonly rules: Map<number, CompletedFileIdentity>;
  target: CompletedFileIdentity | undefined;
}

/** One selected file staged into the private snapshot with its hashed identity. */
interface StagedSnapshotFile {
  readonly callerPath: string;
  readonly snapshotPath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly state: BigIntStats;
}

/** Owned snapshot inputs passed to yara and mapped back to caller paths. */
interface StagedScanInputs {
  readonly target: StagedSnapshotFile;
  readonly rules: readonly StagedSnapshotFile[];
  readonly fastScan: boolean;
}

/**
 * The namespace every rule file is compiled into. yara 4 reads a rule
 * argument as a file path, relative to its working directory, when that
 * file exists, and otherwise splits it at the first `:` into NAMESPACE:FILE.
 * With this prefix and the working directory at the filesystem root, the whole
 * argument names no file, so yara takes the explicit namespace and reads the
 * rest of the argument verbatim as the snapshot path even if TMPDIR contains `:`.
 */
const RULE_NAMESPACE = "rea";

/** The argv yara receives; every snapshot path is absolute, so none parses as an option. */
const yaraArguments = (staged: StagedScanInputs): readonly string[] => [
  ...BASE_ARGUMENTS,
  ...(staged.fastScan ? ["-f"] : []),
  ...staged.rules.map((rule) => `${RULE_NAMESPACE}:${rule.snapshotPath}`),
  staged.target.snapshotPath,
];

/**
 * yara 4.x `cli/yara.c` ends through `exit_with_code(EXIT_FAILURE)` for compile
 * errors, `--fail-on-warnings` and scan errors, and C's EXIT_FAILURE is 1.
 */
const YARA_EXIT_FAILURE = 1;

/** The rule file paths yara was given, as it names them in diagnostics. */
const ruleSnapshotPaths = (staged: StagedScanInputs): readonly string[] =>
  staged.rules.map((rule) => rule.snapshotPath);

/** The selected rule file yara named in a compile error, if it is one. */
const ruleFileIndex = (staged: StagedScanInputs, source: string): number => {
  const prefix = `${RULE_NAMESPACE}:`;
  const named = source.startsWith(prefix)
    ? source.slice(prefix.length)
    : source;
  return staged.rules.findIndex((rule) => rule.snapshotPath === named);
};

/** Replace internal snapshot paths with the caller's selected paths in yara text. */
const restoreCallerPaths = (text: string, staged: StagedScanInputs): string => {
  let restored = text;
  for (const rule of staged.rules) {
    restored = restored
      .replaceAll(`${RULE_NAMESPACE}:${rule.snapshotPath}`, rule.callerPath)
      .replaceAll(rule.snapshotPath, rule.callerPath);
  }
  return restored.replaceAll(
    staged.target.snapshotPath,
    staged.target.callerPath,
  );
};

/**
 * Pre-flight path checks that cannot be expressed in the portable schema:
 * - yara prints one match per line and names the scanned path on each rule
 *   line, so a line break in a selected path makes its output ambiguous.
 * - On Windows, the child runs from the scanned path's root (for example
 *   `D:\`). A drive-relative rooted path such as `\rules\packers.yar` would
 *   resolve against REA's current drive when hashing and against the child's
 *   drive when yara opens it, so Windows paths must be drive-qualified or UNC.
 */
const pathInputRefusal = (
  input: InspectYaraMatchesInput,
  platform: NodeJS.Platform,
): AnalysisInputError | undefined => {
  const fields: { path: (string | number)[]; value: string }[] = [
    { path: ["path"], value: input.path },
    ...input.rule_paths.map((value, index) => ({
      path: ["rule_paths", index],
      value,
    })),
  ];
  const issues: {
    path: (string | number)[];
    reason: "invalid_value";
    message: string;
  }[] = [];
  let hasLineBreak = false;
  let hasUnqualifiedWindowsPath = false;
  for (const { path, value } of fields) {
    if (/[\r\n]/u.test(value)) {
      hasLineBreak = true;
      issues.push({
        path,
        reason: "invalid_value",
        message:
          "The path contains a line break, which yara's line-oriented output cannot represent.",
      });
    }
    if (platform === "win32" && !isQualifiedCallerPath(value, platform)) {
      hasUnqualifiedWindowsPath = true;
      issues.push({
        path,
        reason: "invalid_value",
        message:
          "On Windows, paths must be drive-qualified (for example C:\\...) or UNC paths so they do not depend on the working drive.",
      });
    }
  }
  if (issues.length === 0) return undefined;
  const remediation = [
    ...(hasLineBreak
      ? ["Rename or link the file to a path without line breaks."]
      : []),
    ...(hasUnqualifiedWindowsPath
      ? ["Pass drive-qualified or UNC paths for path and rule_paths."]
      : []),
  ].join(" ");
  return new AnalysisInputError(
    OPERATION,
    {
      conformsToInputContract: true,
      remediationAction: `${remediation} Then retry.`,
    },
    issues,
  );
};

/** The repair each kind of compile error needs, in the order they are reported. */
const COMPILE_ERROR_REMEDIATION: Readonly<
  Record<YaraCompileErrorKind, string>
> = {
  include:
    "Make each included file exist and be readable; a relative include resolves against the directory of the rule file that includes it. Or remove the include.",
  syntax: "Fix the rule syntax at the reported line.",
  undefined:
    "Define the identifier or string, or import the module that provides it; rules that need external variables or module data cannot be compiled by this tool.",
  duplicate:
    "Names must be unique in their scope: rule names across all selected files and their includes, and string, tag and metadata identifiers within their rule. Rename or remove the duplicated identifier at the reported source and line.",
  unreadable_file:
    "Select a rule file that exists and is readable, or remove it from rule_paths.",
  other: "Fix the reported rule source, or remove that file from rule_paths.",
};

/** One repair sentence per kind present, then the retry. */
const compileRemediation = (diagnostics: YaraDiagnostics): string =>
  [
    ...new Set(
      diagnostics.compileErrors.map(
        ({ kind }) => COMPILE_ERROR_REMEDIATION[kind],
      ),
    ),
    "Then retry.",
  ].join(" ");

/** Lines yara wrote that match no documented form, kept for the caller. */
const unrecognizedDiagnostics = (
  diagnostics: YaraDiagnostics,
  staged: StagedScanInputs,
): Readonly<Record<string, unknown>> =>
  diagnostics.unrecognized.length === 0
    ? {}
    : {
        unrecognized_stderr_lines: diagnostics.unrecognized.map((line) =>
          restoreCallerPaths(line, staged),
        ),
      };

/** A rule source yara refused to compile is the caller's selection. */
const ruleCompileError = (
  diagnostics: YaraDiagnostics,
  staged: StagedScanInputs,
  details: AnalysisErrorOptions,
): AnalysisInputError => {
  const compileErrors = diagnostics.compileErrors.map((failure) => {
    const index =
      failure.source === null ? -1 : ruleFileIndex(staged, failure.source);
    const source =
      failure.source === null
        ? null
        : index === -1
          ? restoreCallerPaths(failure.source, staged)
          : staged.rules[index]!.callerPath;
    return {
      index,
      failure: {
        ...failure,
        source,
        message: restoreCallerPaths(failure.message, staged),
      },
    };
  });
  const issues = compileErrors.map(({ index, failure }) => ({
    path: index === -1 ? ["rule_paths"] : ["rule_paths", index],
    reason: "invalid_value" as const,
    message: `${failure.source === null ? "" : `${failure.source}${failure.line === null ? "" : `(${String(failure.line)})`}: `}${failure.rule === null ? "" : `rule "${failure.rule}": `}${failure.message}`,
  }));
  return new AnalysisInputError(
    OPERATION,
    {
      ...details,
      conformsToInputContract: true,
      userMessage: `yara could not compile the selected rules: ${issues.map((issue) => issue.message).join("; ")}`,
      remediationAction: compileRemediation(diagnostics),
      diagnostics: {
        ...details.diagnostics,
        compile_errors: compileErrors.map(({ failure }) => failure),
        ...unrecognizedDiagnostics(diagnostics, staged),
      },
    },
    issues,
  );
};

/** What one yara outcome means; owner-observed facts are shared. */
const yaraOutcomeContext = (
  staged: StagedScanInputs,
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
      staged.target.snapshotPath,
      ruleSnapshotPaths(staged),
    );
    // yara exits EXIT_FAILURE after printing why it refused the rules or the file.
    const reported =
      outcome.kind === "exited" &&
      outcome.exitCode === YARA_EXIT_FAILURE &&
      outcome.signal === null &&
      !outcome.stopRequested &&
      outcome.output?.truncated === false;
    if (reported && diagnostics.compileErrors.length > 0)
      return ruleCompileError(diagnostics, staged, details);
    return unclassified({
      diagnostics: {
        ...(diagnostics.scanErrors.length === 0
          ? {}
          : {
              scan_errors: diagnostics.scanErrors.map(({ reason }) =>
                restoreCallerPaths(reason, staged),
              ),
            }),
        ...unrecognizedDiagnostics(diagnostics, staged),
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

const buildYaraMatchesReport = (
  input: InspectYaraMatchesInput,
  staged: StagedScanInputs,
  settings: YaraScanSettings,
  maxFileBytes: number,
  scan: CompletedScan,
): YaraMatches => ({
  artifact: {
    path: input.path,
    sha256: staged.target.sha256,
    bytes: staged.target.bytes,
  },
  rule_files: staged.rules.map((rule) => ({
    path: rule.callerPath,
    sha256: rule.sha256,
    bytes: rule.bytes,
  })),
  fast_scan: input.fast_scan === true,
  matches: [...scan.parsed.matches],
  coverage: {
    status:
      scan.parsed.listedStringMatches < scan.parsed.stringMatches
        ? "partial"
        : "complete",
    matched_rules: scan.parsed.matches.length,
    string_matches: scan.parsed.stringMatches,
    listed_string_matches: scan.parsed.listedStringMatches,
  },
  limits: { ...settings, max_file_bytes: maxFileBytes },
  warnings: [...scan.warnings],
  limitations: limitations(input, scan.parsed, settings),
});

const limitations = (
  input: InspectYaraMatchesInput,
  parsed: YaraParsedMatches,
  settings: YaraScanSettings,
): string[] => [
  "REA ran the caller-selected yara command; its implementation and version are not observed.",
  "The scanned file and rule files are copied into an owned snapshot while computing their SHA-256 digests, and yara reads only those snapshot files; files included by rules and module data that yara reads are not bound to this Evidence.",
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

/**
 * Per-scan cleanup owner: closes child file handles and any retained command
 * before removing the private snapshot root, and retries in that order.
 */
class YaraScanSnapshot {
  readonly files = new ArtifactResourceScope();
  #rootClosed = false;

  constructor(readonly root: Pick<PrivateRuntimeRoot, "path" | "close">) {}

  get path(): string {
    return this.root.path;
  }

  get hasPendingFiles(): boolean {
    return this.files.hasPending;
  }

  get cleanupResources(): readonly string[] {
    return [
      ...new Set([
        ...this.files.cleanupResources,
        ...(this.#rootClosed ? [] : [this.root.path]),
      ]),
    ];
  }

  async close(): Promise<void> {
    await this.files.close();
    if (!this.#rootClosed) {
      await this.root.close();
      this.#rootClosed = true;
    }
  }
}

/** Runs caller-supplied YARA rules against one stable local file. */
export class YaraMatchesProvider implements YaraMatchesPort {
  readonly identity = YARA_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  constructor(readonly options: YaraMatchesProviderOptions) {}

  /** Retry retained command, snapshot, and descriptor cleanup. */
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
    const platform = this.options.platform ?? HOST_PLATFORM.platform;
    const maxFileBytes = input.max_file_bytes ?? YARA_FILE_BYTES.default_value;
    const refusal = pathInputRefusal(input, platform);
    if (refusal !== undefined) return err(refusal);
    const command = this.options.selectCommand();
    if (!command.ok) return err(command.error);
    let phase: ReadPhase | undefined;
    const completedFiles: CompletedAdmittedFiles = {
      rules: new Map(),
      target: undefined,
    };
    try {
      return await this.#resources.run(async () => {
        const snapshot = new YaraScanSnapshot(
          await this.#createRuntime(platform),
        );
        let outcome:
          | { readonly kind: "completed"; readonly value: YaraMatches }
          | { readonly kind: "failed"; readonly cause: unknown };
        try {
          outcome = {
            kind: "completed",
            value: await this.#inspectInSnapshot(
              snapshot,
              command.value,
              input,
              settings,
              maxFileBytes,
              platform,
              signal,
              (next) => {
                phase = next;
              },
              completedFiles,
            ),
          };
        } catch (cause: unknown) {
          outcome = { kind: "failed", cause };
        }
        const scanLease = AnalysisCleanupLease.forCloseOwner(
          snapshot,
          snapshot.path,
        );
        const scanOwner = {
          kind: "lease" as const,
          resource: snapshot.path,
          lease: scanLease,
        };
        const completed =
          outcome.kind === "completed" ? outcome.value : undefined;
        const cleanupOutcome = ():
          | { readonly kind: "completed" }
          | { readonly kind: "failed"; readonly cause: unknown } => {
          if (outcome.kind === "failed")
            return { kind: "failed", cause: outcome.cause };
          if (signal?.aborted)
            return {
              kind: "failed",
              cause: new ArtifactReaderFailure(
                "cancelled",
                "Artifact read cancelled",
                { cause: signal.reason, partialObservation: outcome.value },
              ),
            };
          return { kind: "completed" };
        };
        const composeSnapshotCleanup = (
          primary: AnalysisError,
          lease: AnalysisCleanupLease,
          failure: { readonly reason: string; readonly cause?: unknown },
        ): AnalysisError => {
          const scanCleanup = new ProviderCleanupError(
            PROVIDER_ID,
            [snapshot.path],
            { reason: failure.reason },
            {
              operation: OPERATION,
              ...(failure.cause === undefined ? {} : { cause: failure.cause }),
            },
          );
          scanCleanup.bindCleanupResourceOwner(lease);
          lease.bindCleanupError(scanCleanup);
          return analysisErrorWithCleanupDependencies(
            primary,
            scanCleanup,
            OPERATION,
          );
        };
        // Never remove the snapshot root while child handles or the child
        // process remain open; retain the ordered per-scan owner to retry
        // child cleanup first and root removal second.
        if (snapshot.hasPendingFiles) {
          this.#resources.retain(scanOwner);
          const pendingReason = `Snapshot directory ${snapshot.path} remains owned until child handles close`;
          if (
            outcome.kind === "failed" &&
            outcome.cause instanceof AnalysisError
          )
            throw composeSnapshotCleanup(outcome.cause, scanLease, {
              reason: pendingReason,
            });
          throw this.#resources.cleanupFailure(
            cleanupOutcome(),
            [
              {
                kind: "failed",
                cause: new Error(pendingReason),
                owner: scanOwner,
                lease: scanLease,
              },
            ],
            completed,
          );
        }
        const release = await this.#resources.release(scanOwner);
        if (release.kind === "failed") {
          if (
            outcome.kind === "failed" &&
            outcome.cause instanceof AnalysisError
          )
            throw composeSnapshotCleanup(outcome.cause, release.lease, {
              reason: ArtifactReaderFailure.cleanupObservation(
                release.cause,
                snapshot.path,
              ).reason,
              cause: release.cause,
            });
          throw this.#resources.cleanupFailure(
            cleanupOutcome(),
            [release],
            completed,
          );
        }
        if (outcome.kind === "failed") throw outcome.cause;
        if (signal?.aborted)
          throw cancelledBy(OPERATION, signal, {
            partialObservation: outcome.value,
          });
        return ok(outcome.value);
      });
    } catch (cause: unknown) {
      const failure = this.#failure(
        cause,
        input,
        phase,
        maxFileBytes,
        completedFiles,
      );
      return err(
        signal?.aborted
          ? analysisErrorWithCancellation(
              failure,
              cancelledBy(OPERATION, signal),
            )
          : failure,
      );
    }
  }

  async #createRuntime(
    platform: NodeJS.Platform,
  ): Promise<Pick<PrivateRuntimeRoot, "path" | "close">> {
    try {
      return this.options.createRuntime === undefined
        ? await PrivateRuntimeRoot.create({ prefix: "rea-yara-", platform })
        : await this.options.createRuntime();
    } catch (cause: unknown) {
      if (cause instanceof RuntimeControlUnavailableError)
        throw runtimeControlCapabilityError(PROVIDER_ID, OPERATION, cause);
      throw privateWorkspaceFailure(PROVIDER_ID, OPERATION, cause, null);
    }
  }

  async #stageFile(
    sourcePath: string,
    destinationPath: string,
    maxFileBytes: number,
    signal: AbortSignal | undefined,
    snapshot: YaraScanSnapshot,
    options?: {
      readonly transform?: YaraIncludeRewriter;
      readonly onIdentity?: (identity: {
        readonly path: string;
        readonly sha256: string;
        readonly bytes: number;
      }) => void;
    },
  ): Promise<StagedSnapshotFile> {
    const transform = options?.transform;
    const onIdentity = options?.onIdentity;
    let destHandle;
    try {
      destHandle =
        this.options.openSnapshotFile === undefined
          ? await open(destinationPath, "wx", 0o600)
          : await this.options.openSnapshotFile(destinationPath);
    } catch (cause: unknown) {
      throw privateWorkspaceFailure(
        PROVIDER_ID,
        OPERATION,
        cause,
        snapshot.path,
      );
    }
    return withArtifactFileHandle(
      destinationPath,
      destHandle,
      snapshot.files,
      signal,
      async (dest) => {
        const writeChunk = async (bytes: Buffer): Promise<void> => {
          if (bytes.length === 0) return;
          try {
            await dest.writeFile(bytes);
          } catch (cause: unknown) {
            throw privateWorkspaceFailure(
              PROVIDER_ID,
              OPERATION,
              cause,
              snapshot.path,
            );
          }
        };
        let streamed;
        try {
          streamed = await streamStableArtifact(sourcePath, maxFileBytes, {
            retainBytes: () => 0,
            signal,
            resourceScope: snapshot.files,
            onChunk: async (chunk) => {
              await writeChunk(
                transform === undefined ? chunk : transform.push(chunk),
              );
            },
          });
        } catch (cause: unknown) {
          const completed = completedStableArtifactStream(cause);
          if (completed !== undefined)
            onIdentity?.({
              path: sourcePath,
              sha256: completed.sha256,
              bytes: completed.size,
            });
          throw cause;
        }
        onIdentity?.({
          path: sourcePath,
          sha256: streamed.sha256,
          bytes: streamed.size,
        });
        if (transform !== undefined) await writeChunk(transform.finish());
        const state = await dest.stat({ bigint: true });
        return {
          callerPath: sourcePath,
          snapshotPath: destinationPath,
          sha256: streamed.sha256,
          bytes: streamed.size,
          state,
        };
      },
    );
  }

  async #inspectInSnapshot(
    snapshot: YaraScanSnapshot,
    command: string,
    input: InspectYaraMatchesInput,
    settings: YaraScanSettings,
    maxFileBytes: number,
    platform: NodeJS.Platform,
    signal: AbortSignal | undefined,
    setPhase: (phase: ReadPhase) => void,
    completedFiles: CompletedAdmittedFiles,
  ): Promise<YaraMatches> {
    const rulePhase = (index: number, path: string): ReadPhase => ({
      path,
      field: ["rule_paths", index],
      description: "rule file",
    });
    const targetPhase: ReadPhase = {
      path: input.path,
      field: "path",
      description: "file",
    };
    const stagedRules: StagedSnapshotFile[] = [];
    for (const [index, path] of input.rule_paths.entries()) {
      setPhase(rulePhase(index, path));
      stagedRules.push(
        await this.#stageFile(
          path,
          join(snapshot.path, `rule-${String(index)}.yar`),
          maxFileBytes,
          signal,
          snapshot,
          {
            transform: createYaraIncludeRewriter(path, platform, maxFileBytes),
            onIdentity: (identity) => {
              completedFiles.rules.set(index, identity);
            },
          },
        ),
      );
    }
    setPhase(targetPhase);
    const stagedTarget = await this.#stageFile(
      input.path,
      join(snapshot.path, "target.bin"),
      maxFileBytes,
      signal,
      snapshot,
      {
        onIdentity: (identity) => {
          completedFiles.target = identity;
        },
      },
    );
    const staged: StagedScanInputs = {
      target: stagedTarget,
      rules: stagedRules,
      fastScan: input.fast_scan === true,
    };
    const verifySnapshots = async (
      checkSignal: AbortSignal | undefined,
      trackPhase: boolean,
    ): Promise<void> => {
      // Verify that neither the target snapshot nor any rule snapshot was
      // modified while yara ran before attributing matches to their digests.
      if (trackPhase) setPhase(targetPhase);
      await assertStableArtifactState(
        stagedTarget.snapshotPath,
        stagedTarget.state,
        checkSignal,
      );
      for (const [index, rule] of stagedRules.entries()) {
        if (trackPhase) setPhase(rulePhase(index, rule.callerPath));
        await assertStableArtifactState(
          rule.snapshotPath,
          rule.state,
          checkSignal,
        );
      }
    };
    const retainVerifiedScan = async (
      cause: unknown,
      completed: CompletedScan | undefined,
    ): Promise<void> => {
      if (
        completed === undefined ||
        !(
          cause instanceof AnalysisError ||
          (cause instanceof ArtifactReaderFailure &&
            cause.reason === "cancelled")
        )
      )
        return;
      try {
        await verifySnapshots(undefined, false);
        cause.retainPartialObservation(
          buildYaraMatchesReport(
            input,
            staged,
            settings,
            maxFileBytes,
            completed,
          ),
        );
      } catch {
        // Keep file checks before presenting matches as a verified report:
        // if a snapshot changed or could not be re-verified, leave only the
        // scanned file's snapshot hash on the primary failure.
      }
    };
    let observedScan: CompletedScan | undefined;
    try {
      const scan = await this.#scan(
        command,
        staged,
        settings,
        snapshot.files,
        signal,
        (completed) => {
          observedScan = completed;
        },
      );
      observedScan = scan;
      await verifySnapshots(signal, true);
      assertArtifactReadActive(signal);
      return buildYaraMatchesReport(
        input,
        staged,
        settings,
        maxFileBytes,
        scan,
      );
    } catch (cause: unknown) {
      await retainVerifiedScan(cause, observedScan);
      throw cause;
    }
  }

  async #scan(
    command: string,
    staged: StagedScanInputs,
    settings: YaraScanSettings,
    scanResources: ArtifactResourceScope,
    signal: AbortSignal | undefined,
    onCompleted?: (scan: CompletedScan) => void,
  ): Promise<CompletedScan> {
    const parser = new YaraMatchOutputParser(
      staged.target.snapshotPath,
      settings.max_matches.value,
    );
    const context = yaraOutcomeContext(staged, settings, command);
    const maxOutputBytes = settings.max_output_bytes.value;
    const platform = this.options.platform ?? HOST_PLATFORM.platform;
    const pathApi = platform === "win32" ? win32 : posix;
    let completed: Result<CompletedScan, AnalysisOutputError> | undefined;
    const finalize = (
      observedSnapshot: ProviderProcessSnapshot,
    ): Result<CompletedScan, AnalysisOutputError> => {
      const parsed = parser.finish();
      if (!parsed.ok)
        return err(
          new AnalysisOutputError(
            OPERATION,
            `yara stdout line ${String(parsed.error.line)} is not a documented match line: ${parsed.error.reason}.`,
            { capturedOutput: capturedProviderOutput(observedSnapshot) },
          ),
        );
      const diagnostics = parseYaraDiagnostics(
        observedSnapshot.stderr.text,
        staged.target.snapshotPath,
        ruleSnapshotPaths(staged),
      );
      return ok({
        parsed: parsed.value,
        warnings: [...diagnostics.warnings, ...diagnostics.unrecognized].map(
          (line) => restoreCallerPaths(line, staged),
        ),
      });
    };
    let snapshot: ProviderProcessSnapshot;
    try {
      // Ownership preparation has its own deadline; it does not spend yara's.
      await prepareOwnedCommand(signal);
      snapshot = await runOwnedCommand(
        {
          command,
          arguments: yaraArguments(staged),
          // See RULE_NAMESPACE: no relative path resolves to a rule file.
          cwd: pathApi.parse(staged.target.snapshotPath).root,
          runId: `rea-yara-${randomUUID()}`,
          hostEnvironment: {
            ...snapshotEnvironment(this.options.environment, platform),
            LC_ALL: "C",
            LANG: "C",
          },
        },
        {
          timeoutMs: settings.command_timeout_ms.value,
          diagnosticBytes: maxOutputBytes,
          stdout: yaraMatchOutputSink(parser),
          maxStdoutBytes: maxOutputBytes,
          observeCompleted: (observed) => {
            completed = finalize(observed);
            if (completed.ok) onCompleted?.(completed.value);
          },
        },
        {
          ...(signal === undefined ? {} : { signal }),
          ...(this.options.launcher === undefined
            ? {}
            : { launcher: this.options.launcher }),
        },
      );
    } catch (cause: unknown) {
      if (completed !== undefined && !completed.ok) {
        let failure = retainProcessInspectionCleanup(
          cause,
          completed.error,
          scanResources,
          OPERATION,
        );
        const cancellation =
          cause instanceof OwnedCommandFailure &&
          cause.cancellation !== undefined
            ? cancelledBy(OPERATION, carriedReason(cause.cancellation.reason))
            : signal?.aborted
              ? cancelledBy(OPERATION, signal)
              : undefined;
        if (cancellation !== undefined)
          failure = analysisErrorWithCancellation(failure, cancellation);
        if (
          cause instanceof OwnedCommandFailure &&
          cause.reason === "timeout"
        ) {
          const outcome = providerOutcomeOf(cause);
          if (outcome !== undefined)
            primaryAnalysisError(failure).retainSecondaryFailure(
              classifyProviderOutcome(outcome, context),
            );
        }
        throw failure;
      }
      throw yaraCommandFailure(cause, context, scanResources);
    }
    const result = completed ?? finalize(snapshot);
    if (!result.ok) throw result.error;
    return result.value;
  }

  #failure(
    cause: unknown,
    input: InspectYaraMatchesInput,
    phase: ReadPhase | undefined,
    maxFileBytes: number,
    completedFiles: CompletedAdmittedFiles,
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
              limit: yaraFileBytesLimit(
                maxFileBytes,
                failure.observedBytes !== undefined &&
                  failure.observedBytes <= BigInt(Number.MAX_SAFE_INTEGER)
                  ? Number(failure.observedBytes)
                  : undefined,
              ),
            },
          ),
      }),
    );
    if (
      cause instanceof ArtifactReaderFailure &&
      cause.partialObservation !== undefined
    )
      primary.retainPartialObservation(cause.partialObservation);
    // `primary` already names the failing `read.path`. Once the scanned target
    // file is hashed, attribute `partialObservation` to it; if failure happened
    // after hashing a rule file before target staging, attribute it only to
    // that failing rule file. Keep all other completed admitted rule identities
    // separately as `argumentObservations` so earlier rules survive later failures.
    const failingRuleIndex =
      Array.isArray(read.field) &&
      read.field[0] === "rule_paths" &&
      typeof read.field[1] === "number"
        ? read.field[1]
        : undefined;
    const primaryFileIdentity =
      completedFiles.target ??
      (failingRuleIndex === undefined
        ? undefined
        : completedFiles.rules.get(failingRuleIndex));
    const projected = projectStableArtifactFailure(
      cause,
      primary,
      primaryFileIdentity === undefined ? read.path : primaryFileIdentity.path,
      PROVIDER_ID,
      OPERATION,
      primaryFileIdentity,
    );
    const hasCompleteReport =
      projected.partialObservation !== undefined &&
      "matches" in projected.partialObservation;
    if (!hasCompleteReport && completedFiles.rules.size > 0) {
      const rootPrimary = primaryAnalysisError(projected);
      for (const [index, identity] of completedFiles.rules.entries()) {
        if (completedFiles.target === undefined && failingRuleIndex === index)
          continue;
        const observation = completedStableArtifactObservation(
          undefined,
          identity.path,
          identity,
        );
        if (observation === undefined) continue;
        const argument = `rule_paths[${String(index)}]`;
        projected.retainArgumentObservation(argument, observation);
        if (rootPrimary !== projected)
          rootPrimary.retainArgumentObservation(argument, observation);
      }
    }
    return projected;
  }
}
