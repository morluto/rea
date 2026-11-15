import { MAX_NODE_TIMER_DELAY_MS } from "../domain/analysisResourceLimits.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { processInspectionCancellationError } from "../providers/OwnedCommandCleanup.js";
import { APKTOOL_PROVIDER_IDENTITY } from "./ApktoolProviderIdentity.js";
import { countDecodedFiles } from "./ApktoolDecodedInventory.js";
import { ApktoolWorkspace } from "./ApktoolWorkspace.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../artifacts/AnalysisCleanupLease.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  ArtifactFileCleanupFailure,
  artifactFilePrimaryFacts,
  artifactFileCancellationCause,
} from "../artifacts/ArtifactFileOperation.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import {
  capturedApktoolCommandOutput,
  capturedApktoolFailureOutput,
} from "./ApktoolCommandOutput.js";
import { providerOutcomeOf } from "../process/ProviderOutcome.js";
import { classifyProviderOutcome } from "../process/classifyProviderOutcome.js";
import { ApktoolCommandCleanup } from "./ApktoolCommandCleanup.js";
import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import { analysisClientFailureForOperation } from "../providers/AnalysisClientFailure.js";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  type ExecutionOptions,
  type ProviderAvailability,
  createAnalysisExecution,
  type AnalysisExecution,
} from "../application/AnalysisProvider.js";
import { providerConfigurationRefusal } from "../domain/providerConfigurationRefusal.js";
import { createAnalysisExecutionEvidence } from "../domain/analysisObservation.js";
import {
  apktoolResultSchemas,
  apktoolStringTablesRequested,
  DEFAULT_APKTOOL_DECODE_TIMEOUT_MS,
  type ApktoolRequest,
  type ApktoolDecodeResult,
} from "../domain/apktool/apktoolResourceAnalysis.js";
import { projectApktoolStringTables } from "./ApktoolStringTables.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisProtocolError,
  AnalysisUnsupportedTargetError,
  cancelledBy,
  OwnerCancellation,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import { err, ok, type Result } from "../domain/result.js";
import { finalizedResult, runOwned } from "../providers/runOwned.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type { RuntimeExhaustionArea } from "../process/RuntimeExhaustion.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { WindowsBatchCommandError } from "../process/WindowsBatchCommand.js";
import { ownedProcessPrerequisiteAvailability } from "../application/ownedProcessAvailability.js";
import {
  ApktoolConfigurationFailure,
  apktoolConfigurationAvailability,
  apktoolInvocation,
  inspectApktoolClient,
  resolveApktoolCommand,
  type ApktoolCommandSelection,
  type ApktoolClientIdentity,
} from "./ApktoolConfiguration.js";
import {
  parseApktoolYml,
  parseManifestPackage,
} from "./ApktoolDecodeOutput.js";

const DECODE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 512 * 1024;
const MAX_DECODED_ENTRIES_VISITED = 100_000;
/**
 * Recovery for the JVM memory area Apktool's decoder reported exhausted. REA
 * does not set the decoder JVM's limits, so each names the launcher setting
 * that governs that area.
 */
const APKTOOL_EXHAUSTION_REMEDIATION: Readonly<
  Record<RuntimeExhaustionArea | "unknown", string>
> = {
  heap: "REA does not set Apktool's Java heap. Raise the maximum heap (-Xmx) of the selected Apktool launcher's JVM, or decode a smaller APK.",
  "gc-overhead":
    "REA does not set Apktool's Java heap. The decoder JVM spent nearly all its time collecting garbage; raise the maximum heap (-Xmx) of the selected Apktool launcher's JVM, or decode a smaller APK.",
  metaspace:
    "REA does not set Apktool's class metadata limit. Raise -XX:MaxMetaspaceSize of the selected Apktool launcher's JVM; a larger heap (-Xmx) does not raise it.",
  "array-size":
    "The decoder requested an array larger than the JVM allows; a larger heap (-Xmx) does not lift this limit. Decode a smaller APK.",
  "native-thread":
    "The decoder JVM could not create a native thread. Check host thread/process limits and available native memory for the selected Apktool launcher; a larger heap (-Xmx) does not help.",
  unknown:
    "REA does not set the memory limits of Apktool's JVM. Review the reported out-of-memory line and the selected Apktool launcher's JVM memory settings, or decode a smaller APK.",
};

const STDERR_EXCERPT_BYTES = 512;

const apktoolDecodeTimeoutGuidance = (
  timeoutMs: number,
): { readonly userMessage: string; readonly remediationAction: string } => ({
  userMessage: `apktool decode reached its ${String(timeoutMs)} ms wall-clock deadline (deadlineExpired).`,
  remediationAction: `${
    timeoutMs < MAX_NODE_TIMER_DELAY_MS
      ? `Increase decode_timeout_ms above ${String(timeoutMs)} (integer milliseconds from 1 to ${String(MAX_NODE_TIMER_DELAY_MS)}; omitted means ${String(DEFAULT_APKTOOL_DECODE_TIMEOUT_MS)}), or use rea decode-android-resources <path> --decode-timeout-ms <milliseconds> on the CLI.`
      : `decode_timeout_ms is already at the maximum ${String(MAX_NODE_TIMER_DELAY_MS)} ms; do not increase it further.`
  } A change applies on the next decode. It does not raise the ${String(DECODE_MAX_OUTPUT_BYTES)}-byte output capture allowance or the version probe; both have no runtime override. Allow execution, cleanup and delivery headroom in the outer MCP client deadline. Confirm outstanding work and cleanup before retrying.`,
});

const throwIfCancelled = (
  operation: string,
  signal: AbortSignal | undefined,
): void => {
  if (signal?.aborted === true) throw cancelledBy(operation, signal);
};

interface DecodeLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

const runApktool = async (
  operation: string,
  targetPath: string,
  selection: ApktoolCommandSelection,
  arguments_: readonly string[],
  limits: DecodeLimits,
  signal: AbortSignal | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  commands: ApktoolCommandCleanup,
  root: string,
): Promise<Result<{ stdout: string; stderr: string }, AnalysisError>> => {
  if (signal?.aborted === true) return err(cancelledBy(operation, signal));
  let invocation: ReturnType<typeof apktoolInvocation>;
  try {
    invocation = apktoolInvocation(selection, arguments_, environment);
  } catch (cause) {
    if (!(cause instanceof WindowsBatchCommandError)) throw cause;
    const reason = `The apktool batch launcher cannot receive REA's decode paths through cmd.exe: ${cause.message}`;
    return err(
      new AnalysisCapabilityUnavailableError(
        APKTOOL_PROVIDER_IDENTITY.id,
        operation,
        reason,
        { cause, userMessage: reason },
      ),
    );
  }
  try {
    const output = await runOwnedCommand(
      {
        command: invocation.command,
        arguments: invocation.arguments,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        // Apktool launchers are commonly interpreter scripts, so ownership is
        // proved by the run token rather than the launcher's argv prefix.
        expectedCommand: null,
        runId: randomUUID(),
        hostEnvironment: environment,
      },
      {
        timeoutMs: limits.timeoutMs,
        diagnosticBytes: limits.maxOutputBytes,
        // Apktool is a Java program; its heap exhaustion is not a target refusal.
        runtime: "jvm",
      },
      signal === undefined ? {} : { signal },
    );
    return ok({ stdout: output.stdout.text, stderr: output.stderr.text });
  } catch (cause) {
    return err(
      commands.retainFailure(
        cause,
        apktoolCommandFailure(cause, operation, targetPath, selection, limits),
        operation,
        root,
      ),
    );
  }
};

const apktoolCommandFailure = (
  failure: unknown,
  operation: string,
  targetPath: string,
  selection: ApktoolCommandSelection,
  limits: DecodeLimits,
): AnalysisError => {
  const capturedOutput = capturedApktoolFailureOutput(failure);
  const inspectionCancellation =
    !(failure instanceof OwnedCommandFailure) ||
    failure.preparationFailure !== undefined
      ? processInspectionCancellationError(failure, operation)
      : undefined;
  if (inspectionCancellation !== undefined) return inspectionCancellation;
  const commandFailure = (details: AnalysisErrorOptions): AnalysisError =>
    new ProviderAdapterError("apktool", operation, {
      ...details,
      ...(failure instanceof OwnedCommandFailure
        ? {
            userMessage: `The selected Apktool command failed while decoding ${targetPath}`,
          }
        : {}),
      diagnostics: {
        selected_command: selection.command,
        target_path: targetPath,
      },
    });
  if (!(failure instanceof OwnedCommandFailure))
    return commandFailure({
      cause: failure,
      ...(capturedOutput === undefined ? {} : { capturedOutput }),
    });
  return classifyProviderOutcome(providerOutcomeOf(failure), {
    operation,
    capturedOutput: capturedApktoolCommandOutput,
    // Ownership preparation can retain output before any process exists.
    details: capturedOutput === undefined ? {} : { capturedOutput },
    timeout: {
      ms: limits.timeoutMs,
      ...apktoolDecodeTimeoutGuidance(limits.timeoutMs),
    },
    outputLimit: {
      limits: { max_output_bytes: limits.maxOutputBytes },
      recovery: fixedAllowanceOptions(
        `The apktool output capture allowance of ${String(limits.maxOutputBytes)} bytes (this release has no runtime override; decode_timeout_ms does not raise it)`,
        "capture",
      ),
    },
    runtimeExhaustion: ({ area }) => ({
      limits: null,
      recovery: {
        retryable: false,
        remediationAction: `${APKTOOL_EXHAUSTION_REMEDIATION[area ?? "unknown"]} Repeating the unchanged request is expected to fail the same way.`,
      },
    }),
    dialect: (exit, details) => {
      // A physical launcher/capture failure does not establish target refusal.
      // Only a fully collected ordinary nonzero decode exit carries that meaning.
      if (
        exit.kind !== "exited" ||
        failure.processError !== undefined ||
        failure.preparationFailure !== undefined ||
        exit.exitCode === null ||
        exit.exitCode === 0 ||
        exit.signal !== null ||
        exit.output?.truncated !== false
      )
        return commandFailure(details);
      return new AnalysisUnsupportedTargetError(
        operation,
        targetPath,
        exit.output.snapshot.stderr.text
          .trim()
          .slice(0, STDERR_EXCERPT_BYTES) ||
          `apktool exited with code ${String(exit.exitCode)} for ${operation}`,
        details,
      );
    },
  });
};

export interface ApktoolProviderOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly removeWorkspace?: (path: string) => Promise<void>;
}

type DecodeFacts = Pick<ApktoolDecodeResult, "client" | "target" | "locale"> &
  Partial<
    Omit<ApktoolDecodeResult, "metadata" | "client" | "target" | "locale">
  > & {
    metadata?: Partial<ApktoolDecodeResult["metadata"]>;
  };

/**
 * Apktool resource decoding over a caller-selected launcher.
 *
 * Decoding happens in a provider-owned temporary workspace that is removed
 * once the requested facts are projected; smali production is skipped
 * (`--no-src`) because Java-source recovery belongs to the JADX family.
 */
export class ApktoolProvider {
  private readonly selectedEnvironment:
    | Readonly<Record<string, string | undefined>>
    | undefined;

  readonly #artifacts = new ArtifactResourceScope();
  private readonly removeWorkspace:
    | ((path: string) => Promise<void>)
    | undefined;
  readonly #commands = new ApktoolCommandCleanup();
  readonly #shutdown = new AbortController();
  readonly #active = new Set<Promise<void>>();
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: ApktoolProviderOptions = {}) {
    this.selectedEnvironment =
      options.environment === undefined
        ? undefined
        : snapshotEnvironment(options.environment, HOST_PLATFORM.platform);
    this.removeWorkspace = options.removeWorkspace;
  }

  private operationEnvironment(): Readonly<NodeJS.ProcessEnv> {
    return (
      this.selectedEnvironment ??
      snapshotEnvironment(process.env, HOST_PLATFORM.platform)
    );
  }

  /** Probe the selected apktool launcher; decodes nothing. */
  inspectAvailability(signal?: AbortSignal): Promise<ProviderAvailability> {
    if (this.#closing)
      return Promise.reject(
        cancelledBy("inspect_apktool_client", OwnerCancellation.ownerClosed),
      );
    const operationSignal =
      signal === undefined
        ? this.#shutdown.signal
        : AbortSignal.any([signal, this.#shutdown.signal]);
    return this.#track(
      this.#commands
        .run(
          () =>
            this.#artifacts.run(() =>
              this.#inspectAvailability(operationSignal),
            ),
          "inspect_apktool_client",
        )
        .catch((cause: unknown) => {
          throw analysisClientFailureForOperation(
            cause,
            "apktool",
            "inspect_apktool_client",
          );
        }),
    );
  }

  async #inspectAvailability(
    signal: AbortSignal,
  ): Promise<ProviderAvailability> {
    const environment = this.operationEnvironment();
    try {
      const selection = await resolveApktoolCommand(
        environment,
        process.platform,
        signal,
      );
      await inspectApktoolClient(selection, this.#commands, {
        signal,
        environment,
      });
      throwIfCancelled("inspect_apktool_client", signal);
      return {
        status: "available",
        code: null,
        reason: null,
        diagnostics: {
          selected_command: selection.command,
          command_source: selection.commandSource,
        },
      };
    } catch (cause) {
      if (cause instanceof ApktoolConfigurationFailure) {
        return apktoolConfigurationAvailability(cause);
      }
      const prerequisite = ownedProcessPrerequisiteAvailability(cause);
      if (prerequisite !== undefined) return prerequisite;
      throw cause;
    }
  }

  /** Retain failed cleanup ownership and retry it on close. */
  async close(): Promise<void> {
    this.#closing = true;
    this.#shutdown.abort(OwnerCancellation.ownerClosed);
    this.#closePromise ??= this.#drainAndClean().catch((cause: unknown) => {
      this.#closePromise = undefined;
      throw cause;
    });
    return this.#closePromise;
  }

  execute(
    request: ApktoolRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (this.#closing)
      return Promise.resolve(
        err(cancelledBy(request.operation, OwnerCancellation.ownerClosed)),
      );
    const signal =
      options?.signal === undefined
        ? this.#shutdown.signal
        : AbortSignal.any([options.signal, this.#shutdown.signal]);
    return this.#track(
      this.#commands
        .run(
          () => this.#artifacts.run(() => this.#execute(request, signal)),
          request.operation,
        )
        .catch((cause: unknown) =>
          err(
            analysisClientFailureForOperation(
              cause,
              "apktool",
              request.operation,
            ),
          ),
        ),
    );
  }

  async #execute(
    request: ApktoolRequest,
    signal: AbortSignal,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (signal?.aborted === true)
      return err(cancelledBy(request.operation, signal));
    const environment = this.operationEnvironment();
    let selection: ApktoolCommandSelection;
    let identity: ApktoolClientIdentity;
    try {
      selection = await resolveApktoolCommand(
        environment,
        process.platform,
        signal,
      );
      identity = await inspectApktoolClient(selection, this.#commands, {
        signal,
        environment,
      });
    } catch (cause) {
      if (cause instanceof AnalysisError)
        return err(
          analysisClientFailureForOperation(
            cause,
            "apktool",
            request.operation,
          ),
        );
      if (cause instanceof ApktoolConfigurationFailure) {
        return err(
          providerConfigurationRefusal(
            APKTOOL_PROVIDER_IDENTITY.id,
            request.operation,
            cause,
          ),
        );
      }
      return err(
        new AnalysisProtocolError(
          `apktool version probe failed for ${request.operation}`,
          { cause },
        ),
      );
    }
    if (signal.aborted) return err(cancelledBy(request.operation, signal));
    const client = {
      command: selection.command,
      command_source: selection.commandSource,
      apktool_version: identity.version,
    };
    const provider = {
      ...APKTOOL_PROVIDER_IDENTITY,
      version: identity.version,
    };
    if (request.operation === "inspect_apktool_client")
      return ok(
        createAnalysisExecution({ client }, provider, {
          limitations: identity.limitations,
        }),
      );
    return this.decodeResources(
      request.operation,
      selection,
      environment,
      client,
      provider,
      request.input,
      identity.limitations,
      signal,
    );
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#active.add(settled);
    void settled.then(() => this.#active.delete(settled));
    return operation;
  }

  async #drainAndClean(): Promise<void> {
    await Promise.all(this.#active);
    const failures: AnalysisError[] = [];
    for (const close of [
      () => this.#commands.close(),
      () => this.#artifacts.close(),
    ]) {
      try {
        await close();
      } catch (cause) {
        failures.push(
          analysisClientFailureForOperation(cause, "apktool", "close"),
        );
      }
    }
    const first = failures.shift();
    if (first === undefined) return;
    throw failures.reduce(
      (primary, cleanup) =>
        analysisErrorWithCleanupFailure(
          primary,
          cleanup,
          "close",
        ).bindCleanupDependencies([primary, cleanup]),
      first,
    );
  }

  private async decodeResources(
    operation: "decode_android_resources",
    selection: ApktoolCommandSelection,
    environment: Readonly<NodeJS.ProcessEnv>,
    client: ApktoolDecodeResult["client"],
    provider: { id: string; name: string; version: string | null },
    input: Extract<
      ApktoolRequest,
      { operation: "decode_android_resources" }
    >["input"],
    clientLimitations: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const runtime = await PrivateRuntimeRoot.create({ prefix: "rea-apktool-" });
    const resources = new ApktoolWorkspace(
      runtime,
      this.#commands,
      this.removeWorkspace,
    );
    const root = resources.path;
    const workspace = join(root, "decoded");
    const snapshot = join(root, "input.apk");
    const framework = join(root, "framework");
    const lease = new AnalysisCleanupLease(() => resources.close(), [root]);
    const owner = { kind: "lease" as const, resource: root, lease };
    this.#artifacts.retain(owner);
    let result: Result<AnalysisExecution, AnalysisError>;
    let completedDecode: DecodeFacts | undefined;
    let stoppedAt = "metadata";
    const limitations: string[] = [
      ...clientLimitations,
      "Decoding skips smali (--no-src); Java-source recovery belongs to the JADX family",
    ];
    try {
      const identity = await resources.snapshotInput(
        input.path,
        operation,
        signal,
      );
      const sha256 = identity.sha256;
      await mkdir(workspace);
      await mkdir(framework);
      const decoded = await runApktool(
        operation,
        input.path,
        selection,
        [
          "d",
          "--no-src",
          "-f",
          "-o",
          workspace,
          "--frame-path",
          framework,
          snapshot,
        ],
        {
          timeoutMs:
            input.decode_timeout_ms ?? DEFAULT_APKTOOL_DECODE_TIMEOUT_MS,
          maxOutputBytes: DECODE_MAX_OUTPUT_BYTES,
        },
        signal,
        environment,
        this.#commands,
        root,
      );
      if (!decoded.ok) {
        throw decoded.error;
      }
      completedDecode = {
        client,
        target: { path: input.path, bytes: identity.bytes, sha256 },
        locale: input.locale ?? null,
        coverage: "partial",
      };
      throwIfCancelled(operation, signal);
      const yml = await resources.readText(
        join(workspace, "apktool.yml"),
        MANIFEST_MAX_BYTES,
        signal,
      );
      if (yml.text === null || yml.truncated) {
        throw new AnalysisProtocolError(
          `apktool produced missing or oversized apktool.yml: ${input.path}`,
        );
      }
      const metadata = parseApktoolYml(yml.text);
      completedDecode.metadata = {
        version_name: metadata.versionName,
        version_code: metadata.versionCode,
        min_sdk_version: metadata.minSdkVersion,
        target_sdk_version: metadata.targetSdkVersion,
      };
      stoppedAt = "manifest";
      const manifestRead = await resources.readText(
        join(workspace, "AndroidManifest.xml"),
        MANIFEST_MAX_BYTES,
        signal,
      );
      const manifest = manifestRead.text;
      completedDecode.manifest = manifest;
      if (manifestRead.truncated) {
        limitations.push(
          `manifest is truncated at ${String(MANIFEST_MAX_BYTES)} bytes`,
        );
      }
      const packageName =
        manifest === null || manifestRead.truncated
          ? null
          : parseManifestPackage(manifest);
      completedDecode.metadata.package_name = packageName;
      stoppedAt = "inventory";
      const inventory = await countDecodedFiles(
        resources,
        workspace,
        signal,
        MAX_DECODED_ENTRIES_VISITED,
      );
      const files = inventory.ok ? inventory.value : inventory.error.partial;
      completedDecode.locales = [...files.locales];
      completedDecode.decoded_file_count = files.count;
      if (files.unreadableStringsTables.length > 0) {
        limitations.push(
          `String tables omitted because they are not regular files: ${files.unreadableStringsTables.map((table) => `${JSON.stringify(table.path)} (${table.kind})`).join(", ")}`,
        );
      }
      if (files.otherStringsTables.length > 0) {
        limitations.push(
          `Other strings tables are not selected by locale; their resource configuration suffixes are preserved without inferring Android runtime matching: ${files.otherStringsTables.map((table) => JSON.stringify(table)).join(", ")}`,
        );
      }
      if (files.capped) {
        limitations.push(
          `Decoded workspace enumeration stopped after ${String(MAX_DECODED_ENTRIES_VISITED)} entries; decoded_file_count and locales may be partial`,
        );
      }
      if (!inventory.ok) throw inventory.error.cause;
      throwIfCancelled(operation, signal);
      stoppedAt = "string projection";

      const projection = await projectApktoolStringTables(
        resources,
        workspace,
        input,
        signal,
      );
      const projectedStrings = projection.ok
        ? projection.value
        : projection.error.partial;
      limitations.push(...projectedStrings.limitations);
      const coverage =
        projectedStrings.coverage === "partial" ||
        manifestRead.truncated ||
        files.capped ||
        files.unreadableStringsTables.length > 0
          ? "partial"
          : "complete";

      completedDecode.strings = [...projectedStrings.strings];
      if (apktoolStringTablesRequested(input))
        completedDecode.string_tables = [...projectedStrings.tables];
      completedDecode.coverage = coverage;
      if (!projection.ok) throw projection.error.cause;
      result = ok(
        createAnalysisExecution(
          apktoolResultSchemas.decode_android_resources.parse(completedDecode),
          provider,
          {
            subject: { path: input.path, sha256, format: "apk" },
            limitations,
          },
        ),
      );
    } catch (cause) {
      const { cause: physical, origin } = artifactFilePrimaryFacts(cause);
      const primary =
        origin === "owned-or-classified" && physical instanceof AnalysisError
          ? physical
          : origin === "owned-or-classified" &&
              physical instanceof ArtifactReaderFailure &&
              physical.reason === "cancelled"
            ? cancelledBy(
                operation,
                carriedReason(artifactFileCancellationCause(physical)),
              )
            : new AnalysisProtocolError("Apktool resource projection failed", {
                cause: physical,
              });
      const failure = analysisClientFailureForOperation(
        cause,
        "apktool",
        operation,
      );
      if (
        cause instanceof ArtifactReaderFailure &&
        cause.cleanup !== undefined &&
        !(cause instanceof ArtifactFileCleanupFailure)
      )
        new AnalysisCleanupLeaseGroup(failure, [lease]);
      const retained =
        physical === cause && cause instanceof AnalysisError
          ? cause
          : failure.cleanupIncomplete
            ? analysisErrorWithCleanupFailure(
                primary,
                failure,
                operation,
              ).bindCleanupDependencies([primary, failure])
            : primary;
      if (
        completedDecode !== undefined &&
        retained.partialObservation === undefined
      ) {
        limitations.push(
          `Decode observation stopped during ${stoppedAt}; fields not yet observed are omitted`,
        );
        const partialExecution = createAnalysisExecution(
          { ...completedDecode, coverage: "partial" },
          provider,
          {
            subject: {
              path: input.path,
              sha256: completedDecode.target.sha256,
              format: "apk",
            },
            limitations,
          },
        );
        retained.retainPartialObservation(
          createAnalysisExecutionEvidence(
            operation,
            input,
            partialExecution,
            "observed",
          ),
        );
      }
      if (
        resources.snapshot !== undefined &&
        retained.partialObservation === undefined
      )
        retained.retainPartialObservation({
          kind: "file-snapshot-hash",
          ...resources.snapshot,
        });
      result = err(retained);
    }
    const completed = result;
    return finalizedResult(
      await runOwned(async () => completed, {
        providerId: "apktool",
        operation,
        signal,
        close: async () => {
          const released = await this.#artifacts.release(owner);
          if (released.kind === "failed")
            throw new ProviderCleanupError(
              "apktool",
              [root],
              {},
              { operation, cause: released.cause },
            );
        },
        cleanupLeases: [lease],
        partial: (execution) =>
          createAnalysisExecutionEvidence(
            operation,
            input,
            execution,
            "observed",
          ),
      }),
    );
  }
}
