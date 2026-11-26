import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
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
  type YaraDiagnostics,
  type YaraParsedMatches,
} from "./YaraOutput.js";
import {
  ArtifactResourceScope,
  artifactFilePrimaryFacts,
  assertArtifactReadActive,
  assertStableArtifactState,
  closeArtifactResources,
  projectStableArtifactFailure,
  streamStableArtifact,
  withArtifactFileHandle,
  type RequestField,
} from "../resources/index.js";
import {
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
}

/** The selected file a failed phase was reading. */
interface ReadPhase {
  readonly path: string;
  readonly field: RequestField;
  readonly description: string;
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

const RULE_COMPILE_REMEDIATION =
  "Fix the reported rule source, or remove that file from rule_paths, then retry. Rule names must be unique across all selected files, and rules that need external variables or module data cannot be compiled by this tool.";

/** A rule source yara refused to compile is the caller's selection. */
const ruleCompileError = (
  diagnostics: YaraDiagnostics,
  staged: StagedScanInputs,
  details: AnalysisErrorOptions,
): AnalysisInputError => {
  const compileErrors = diagnostics.compileErrors.map((failure) => {
    const index = ruleFileIndex(staged, failure.source);
    const source =
      index === -1
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
    message: `${failure.source}${failure.line === null ? "" : `(${String(failure.line)})`}: ${failure.message}`,
  }));
  return new AnalysisInputError(
    OPERATION,
    {
      ...details,
      conformsToInputContract: true,
      userMessage: `yara could not compile the selected rules: ${issues.map((issue) => issue.message).join("; ")}`,
      remediationAction: RULE_COMPILE_REMEDIATION,
      diagnostics: {
        ...details.diagnostics,
        compile_errors: compileErrors.map(({ failure }) => failure),
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
    );
    // yara exits 1 after printing why it refused the rules or the file.
    const reported =
      outcome.kind === "exited" &&
      outcome.exitCode === 1 &&
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
    let identity:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () => {
        const root = await this.#createRuntime(platform);
        let outcome:
          | { readonly kind: "completed"; readonly value: YaraMatches }
          | { readonly kind: "failed"; readonly cause: unknown };
        try {
          outcome = {
            kind: "completed",
            value: await this.#inspectInSnapshot(
              root.path,
              command.value,
              input,
              settings,
              maxFileBytes,
              signal,
              (next) => {
                phase = next;
              },
              (verified) => {
                identity = verified;
              },
            ),
          };
        } catch (cause: unknown) {
          outcome = { kind: "failed", cause };
        }
        const release = await this.#resources.release({
          kind: "private-runtime-root",
          resource: root.path,
          root,
        });
        if (release.kind === "failed")
          throw this.#resources.cleanupFailure(
            outcome.kind === "completed"
              ? { kind: "completed" }
              : { kind: "failed", cause: outcome.cause },
            [release],
          );
        if (outcome.kind === "failed") throw outcome.cause;
        assertArtifactReadActive(signal);
        return ok(outcome.value);
      });
    } catch (cause: unknown) {
      return err(this.#failure(cause, input, phase, maxFileBytes, identity));
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
    rootPath: string,
  ): Promise<StagedSnapshotFile> {
    let destHandle;
    try {
      destHandle = await open(destinationPath, "wx", 0o600);
    } catch (cause: unknown) {
      throw privateWorkspaceFailure(PROVIDER_ID, OPERATION, cause, rootPath);
    }
    return withArtifactFileHandle(
      destinationPath,
      destHandle,
      this.#resources,
      signal,
      async (dest) => {
        const streamed = await streamStableArtifact(sourcePath, maxFileBytes, {
          retainBytes: () => 0,
          signal,
          resourceScope: this.#resources,
          onChunk: async (chunk) => {
            try {
              await dest.writeFile(chunk);
            } catch (cause: unknown) {
              throw privateWorkspaceFailure(
                PROVIDER_ID,
                OPERATION,
                cause,
                rootPath,
              );
            }
          },
        });
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
    rootPath: string,
    command: string,
    input: InspectYaraMatchesInput,
    settings: YaraScanSettings,
    maxFileBytes: number,
    signal: AbortSignal | undefined,
    setPhase: (phase: ReadPhase) => void,
    setIdentity: (identity: {
      readonly sha256: string;
      readonly bytes: number;
    }) => void,
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
          join(rootPath, `rule-${String(index)}.yar`),
          maxFileBytes,
          signal,
          rootPath,
        ),
      );
    }
    setPhase(targetPhase);
    const stagedTarget = await this.#stageFile(
      input.path,
      join(rootPath, "target.bin"),
      maxFileBytes,
      signal,
      rootPath,
    );
    setIdentity({ sha256: stagedTarget.sha256, bytes: stagedTarget.bytes });
    const staged: StagedScanInputs = {
      target: stagedTarget,
      rules: stagedRules,
      fastScan: input.fast_scan === true,
    };
    const { parsed, warnings } = await this.#scan(
      command,
      staged,
      settings,
      signal,
    );
    // Verify that neither the target snapshot nor any rule snapshot was
    // modified while yara ran before attributing matches to their digests.
    setPhase(targetPhase);
    await assertStableArtifactState(
      stagedTarget.snapshotPath,
      stagedTarget.state,
      signal,
    );
    for (const [index, rule] of stagedRules.entries()) {
      setPhase(rulePhase(index, rule.callerPath));
      await assertStableArtifactState(rule.snapshotPath, rule.state, signal);
    }
    assertArtifactReadActive(signal);
    return {
      artifact: {
        path: input.path,
        sha256: stagedTarget.sha256,
        bytes: stagedTarget.bytes,
      },
      rule_files: stagedRules.map((rule) => ({
        path: rule.callerPath,
        sha256: rule.sha256,
        bytes: rule.bytes,
      })),
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
  }

  async #scan(
    command: string,
    staged: StagedScanInputs,
    settings: YaraScanSettings,
    signal: AbortSignal | undefined,
  ): Promise<CompletedScan> {
    const parser = new YaraMatchOutputParser(
      staged.target.snapshotPath,
      settings.max_matches.value,
    );
    const context = yaraOutcomeContext(staged, settings, command);
    const maxOutputBytes = settings.max_output_bytes.value;
    const platform = this.options.platform ?? HOST_PLATFORM.platform;
    const pathApi = platform === "win32" ? win32 : posix;
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
    const diagnostics = parseYaraDiagnostics(
      snapshot.stderr.text,
      staged.target.snapshotPath,
    );
    return {
      parsed: parsed.value,
      warnings: [...diagnostics.warnings, ...diagnostics.unrecognized].map(
        (line) => restoreCallerPaths(line, staged),
      ),
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
