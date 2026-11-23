import { finalizedResult, runOwned } from "../../providers/runOwned.js";
import {
  capturedProviderOutput,
  providerResultDiagnostics,
} from "../../process/capturedProviderOutput.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { isAbortOf } from "../../process/SignalAbort.js";
import {
  HOST_PLATFORM,
  type HostPlatform,
} from "../../platform/HostPlatform.js";
import { snapshotEnvironment } from "../../process/snapshotEnvironment.js";
import { invariantViolation } from "../../domain/internalInvariant.js";
import { safeParseUtf8Json } from "../../domain/safeJson.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
  bindArtifactFileCleanup,
  artifactFileCancellationCause,
  completedStableArtifact,
  readStableArtifact,
  ArtifactResourceScope,
  ArtifactReaderFailure,
} from "../../resources/index.js";
import {
  pwntoolsFailureDialect,
  pwntoolsUnavailable,
  pwntoolsBudgetRecovery,
  pwntoolsReplyOutputLimit,
} from "./PwntoolsFailures.js";
import { randomUUID } from "node:crypto";
import { access, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../../ports/AnalysisProvider.js";
import type {
  AnalysisCapturedOutput,
  AnalysisPartialObservation,
} from "../../domain/analysisErrorBase.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisUnsupportedTargetError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  cancelledBy,
  carriedReason,
} from "../../domain/analysisErrorCore.js";
import {
  projectAnalysisError,
  projectAnalysisErrorWithoutCapturedOutput,
} from "../../domain/analysisErrorProjection.js";
import { analysisErrorWithCleanupDependencies } from "../../domain/analysisErrorCleanup.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  ownedCommandResources,
  runOwnedCommand,
} from "../../process/OwnedCommand.js";
import type {
  ProviderProcessSupervisor,
  OwnedProviderProcessSpawnOptions,
  ProviderProcessSnapshot,
} from "../../process/ProviderProcess.js";
import { PendingOperations } from "../../process/PendingOperations.js";
import {
  pwntoolsResourceLimitsSchemaFor,
  readPwntoolsFailureEvidence,
} from "./PwntoolsResourceLimits.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import {
  PWNTOOLS_LIMITS,
  pwntoolsProducerLimitsSchema,
  resolvePwntoolsLimits,
  type PwntoolsProducerLimitsInput,
  type PwntoolsProducerLimits,
} from "../../domain/native/pwntoolsResourceLimits.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { PWNTOOLS_PROVIDER_IDENTITY } from "./PwntoolsProviderIdentity.js";
import { pwntoolsInputBytes } from "../../config/pwntoolsInputLimit.js";
import { errorMessage } from "../../kernel/errorMessage.js";

/** Names the detected host so a host refusal is not read as a target refusal. */
const pwntoolsHostRequirement = (
  platform: NodeJS.Platform,
  arch: string,
): string =>
  `The real-verified pwntools artifact profile runs only on a Linux x64 host; this host is ${platform}/${arch}. The selected target was not read.`;

/** The pwntools profile runs only on Linux x64; discovery and execution share this check. */
export const pwntoolsHostSupported = (
  platform: NodeJS.Platform,
  arch: string,
): boolean => platform === "linux" && arch === "x64";

/** Owned launcher seam shared by the offline pwntools artifact adapters. */
export type PwntoolsLauncher = NonNullable<
  Parameters<typeof runOwnedCommand>[2]
>["launcher"];
/** Owner-bound execution; replies and failure files are stable only after this settles without cleanup uncertainty. */
export type PwntoolsCommand = (
  spawn: OwnedProviderProcessSpawnOptions,
  /** Project the original failure without reading files an unresolved worker may change. */
  failure: (cause: unknown) => AnalysisError,
) => Promise<ProviderProcessSnapshot>;
type DecoderReport = AnalysisPartialObservation & {
  readonly diagnostics: AnalysisCapturedOutput;
};
/** Adapter-selected semantics around a shared owned pwntools process boundary. */
export interface PwntoolsDecoderProfile<
  Input extends {
    readonly path: string;
    readonly pwntools_timeout_ms?: number | undefined;
    readonly producer_limits?: PwntoolsProducerLimitsInput | undefined;
  },
  Payload,
  Report extends DecoderReport,
> {
  readonly identity: ProviderIdentity;
  readonly operation: string;
  readonly bridge: URL;
  readonly payloadSchema: z.ZodType<Payload>;
  readonly project: (context: {
    readonly input: Input;
    readonly payload: Payload;
    readonly snapshot: { readonly bytes: Buffer; readonly sha256: string };
    readonly diagnostics: AnalysisCapturedOutput;
  }) => Report;
  /** Describe admitted facts when the reply cannot be finalized before enrichment. */
  readonly partialObservation?: (
    input: Input,
    report: Report,
  ) => AnalysisPartialObservation;
  /** Optional resource-acquiring work starts only after base report admission and reply finalization. */
  readonly enrich?: (context: {
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly input: Input;
    readonly report: Report;
    readonly snapshot: { readonly bytes: Buffer; readonly sha256: string };
    readonly rootPath: string;
    readonly resources: ArtifactResourceScope;
    readonly options: ExecutionOptions | undefined;
    readonly runCommand: PwntoolsCommand;
    readonly timeoutMs: number;
    readonly producerLimits: PwntoolsProducerLimits;
  }) => Promise<Report>;
}

/** Thin owned-process adapter; all ELF parsing and heuristics come from unchanged upstream code. */
export class PwntoolsDecoder<
  Input extends {
    readonly path: string;
    readonly pwntools_timeout_ms?: number | undefined;
    readonly producer_limits?: PwntoolsProducerLimitsInput | undefined;
  },
  Payload,
  Report extends DecoderReport,
> {
  readonly identity: ProviderIdentity;
  #tail: Promise<void> = Promise.resolve();
  readonly #admissions = new PendingOperations<
    symbol,
    "admitted" | "cancelled"
  >();
  readonly #resources = new ArtifactResourceScope();
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #pendingCleanup:
    | {
        root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
        rootLease: AnalysisCleanupLease;
        process:
          | {
              readonly supervisor: ProviderProcessSupervisor;
              readonly lease: AnalysisCleanupLease;
            }
          | undefined;
        failure: AnalysisError | undefined;
        diagnostics: AnalysisCapturedOutput | undefined;
        observation: AnalysisPartialObservation | undefined;
      }
    | undefined;
  constructor(
    readonly profile: PwntoolsDecoderProfile<Input, Payload, Report>,
    readonly environment: Readonly<NodeJS.ProcessEnv>,
    readonly launcher?: PwntoolsLauncher,
    readonly createRuntime: () => Promise<
      Pick<PrivateRuntimeRoot, "path" | "close">
    > = () => PrivateRuntimeRoot.create({ prefix: "rea-artifact-decoder-" }),
    /** The host the decoder runs on; selects the supported-host gate. */
    readonly host: HostPlatform = HOST_PLATFORM,
  ) {
    this.identity = profile.identity;
  }

  /** Snapshot one explicit artifact and return complete static observations without launching the selected object as a host process. */
  inspect(
    input: Input,
    options?: ExecutionOptions,
  ): Promise<Result<Report, AnalysisError>> {
    return this.#enqueue(() => this.#inspect(input, options), options);
  }

  /** Finalize an admitted inspection before publishing its outcome; rejected admission acquires nothing and does not close the provider. */
  inspectAndClose(
    input: Input,
    options?: ExecutionOptions,
  ): Promise<Result<Report, AnalysisError>> {
    return this.#enqueue(() => {
      this.#closing = true;
      return this.#inspect(input, options);
    }, options);
  }

  #enqueue(
    inspect: () => Promise<Result<Report, AnalysisError>>,
    options?: ExecutionOptions,
  ): Promise<Result<Report, AnalysisError>> {
    if (options?.signal?.aborted)
      return Promise.resolve(
        err(cancelledBy(this.profile.operation, options?.signal)),
      );
    if (this.#closing) return Promise.resolve(err(this.#closedError()));
    const key = Symbol();
    const admission = this.#admissions.wait(key, {
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      cancelledValue: () => "cancelled",
    });
    const operation = this.#tail.then(() => {
      this.#admissions.settle(key, "admitted");
      if (options?.signal?.aborted)
        return err(cancelledBy(this.profile.operation, options?.signal));
      return this.#closing ? err(this.#closedError()) : inspect();
    });
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return admission.then((state) =>
      state === "cancelled"
        ? err(
            cancelledBy(
              this.profile.operation,
              carriedReason(options?.signal?.reason),
            ),
          )
        : operation,
    );
  }

  async #inspect(
    input: Input,
    options?: ExecutionOptions,
  ): Promise<Result<Report, AnalysisError>> {
    const environment = snapshotEnvironment(
      this.environment,
      this.host.platform,
    );
    const selectedLimits = pwntoolsProducerLimitsSchema.safeParse(
      input.producer_limits === undefined ? {} : input.producer_limits,
    );
    if (!selectedLimits.success)
      return err(
        analysisInputErrorFromIssues(
          this.profile.operation,
          selectedLimits.error.issues.map((issue) => ({
            ...issue,
            path: ["producer_limits", ...issue.path],
          })),
          input,
        ),
      );
    const pending = await this.#retire();
    if (pending !== undefined) return err(pending);
    const OPERATION = this.profile.operation;
    const timeoutMs =
      input.pwntools_timeout_ms ?? PWNTOOLS_LIMITS.command_timeout_ms;
    let producerLimits = {
      ...resolvePwntoolsLimits(selectedLimits.data),
      command_timeout_ms: timeoutMs,
    };
    let inputBytesSource:
      | "default"
      | "setting"
      | "runtime"
      | "request"
      | undefined;
    const context = {
      operation: OPERATION,
      providerId: this.identity.id,
      timeoutMs,
      get producerLimits() {
        return producerLimits;
      },
      get inputBytesSource() {
        return inputBytesSource;
      },
    };
    const replySchema = z.discriminatedUnion("ok", [
      z.strictObject({
        ok: z.literal(true),
        profile: z.literal(PWNTOOLS_PROVIDER_IDENTITY.version),
        value: this.profile.payloadSchema,
      }),
      z.strictObject({
        ok: z.literal(false),
        reason: z.enum([
          "format",
          "unsupported",
          "unsupported-target",
          "unavailable",
          "resource-limit",
          "output-limit",
          "decoder",
        ]),
        message: z.string(),
        reported_limits: pwntoolsResourceLimitsSchemaFor(producerLimits)
          .nullable()
          .optional(),
      }),
    ]);
    let root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
    let result: Result<Report, AnalysisError>;
    let replyFinalization: AnalysisError | undefined;
    let phase: "configuration" | "artifact-read" | "decoder" = "configuration";
    const executablePath = environment.REA_PWNTOOLS_PYTHON ?? "";
    const failure = (cause: unknown) =>
      classifyProviderFailure(
        cause,
        pwntoolsFailureDialect(
          phase,
          phase === "configuration" ? executablePath : input.path,
          executablePath,
          {},
          context,
        ),
      );
    try {
      if (options?.signal?.aborted)
        throw cancelledBy(OPERATION, options.signal);
      if (!pwntoolsHostSupported(this.host.platform, this.host.architecture)) {
        const requirement = pwntoolsHostRequirement(
          this.host.platform,
          this.host.architecture,
        );
        throw new AnalysisCapabilityUnavailableError(
          this.identity.id,
          OPERATION,
          requirement,
          { userMessage: requirement },
        );
      }
      if (!isAbsolute(executablePath))
        throw pwntoolsUnavailable(
          "Set REA_PWNTOOLS_PYTHON to an absolute caller-supplied Python executable with pwntools 4.15.0, pyelftools 0.33 and Unicorn 2.1.2; REA never installs Python or packages.",
          executablePath,
          undefined,
          undefined,
          context,
        );
      await access(executablePath, constants.X_OK);
      if (!(await stat(executablePath)).isFile())
        throw pwntoolsUnavailable(
          "Selected Python executable must be a regular executable file, not a directory: " +
            executablePath,
          executablePath,
          undefined,
          undefined,
          context,
        );
      const inputLimit =
        selectedLimits.data.input_bytes === undefined
          ? pwntoolsInputBytes(environment)
          : {
              configured: true as const,
              bytes: selectedLimits.data.input_bytes,
              source: "request" as const,
            };
      if (!inputLimit.configured)
        throw pwntoolsUnavailable(
          inputLimit.error,
          executablePath,
          undefined,
          undefined,
          {
            ...context,
            configurationKey: "REA_PWNTOOLS_MAX_INPUT_BYTES",
          },
        );
      inputBytesSource = inputLimit.source;
      phase = "artifact-read";
      producerLimits = {
        ...resolvePwntoolsLimits(selectedLimits.data, inputLimit.bytes),
        command_timeout_ms: timeoutMs,
      };
      const snapshot = await readStableArtifact(
        input.path,
        inputLimit.bytes,
        options?.signal,
        undefined,
        this.#resources,
      );
      phase = "decoder";
      root = await this.createRuntime();
      this.#pendingCleanup = {
        root,
        rootLease: AnalysisCleanupLease.forCloseOwner(root, root.path),
        process: undefined,
        failure: undefined,
        diagnostics: undefined,
        observation: undefined,
      };
      const requestPath = join(root.path, "request.json");
      const snapshotPath = join(root.path, "object.snapshot");
      const replyPath = join(root.path, "reply.json");
      try {
        await writeFile(snapshotPath, snapshot.bytes, {
          flag: "wx",
          mode: 0o600,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (cause: unknown) {
        // Normalize Node's abort envelope only at the write that produced it.
        if (
          options?.signal?.aborted === true &&
          cause !== options.signal.reason &&
          isAbortOf(cause, options.signal)
        )
          throw cancelledBy(OPERATION, options.signal);
        throw cause;
      }
      await writeFile(
        requestPath,
        JSON.stringify({
          snapshot_path: snapshotPath,
          reply_path: replyPath,
          producer_limits: producerLimits,
        }),
        { flag: "wx", mode: 0o600 },
      );
      const execution = await this.#runCommand(
        producerLimits,
        {
          command: environment.REA_PWNTOOLS_PYTHON ?? "",
          arguments: [
            "-I",
            fileURLToPath(this.profile.bridge),
            join(root.path, "resource.failure"),
            requestPath,
          ],
          cwd: root.path,
          runId: `rea-artifact-decoder-${randomUUID()}`,
          hostEnvironment: {
            ...environment,
            PWNLIB_NOTERM: "1",
            OPENBLAS_NUM_THREADS: "1",
            OMP_NUM_THREADS: "1",
          },
        },
        options,
        failure,
      );
      const capturedOutput = capturedProviderOutput(execution);
      let reply: z.output<typeof replySchema>;
      try {
        let file;
        try {
          file = await readStableArtifact(
            replyPath,
            producerLimits.output_bytes,
            options?.signal,
            undefined,
            this.#resources,
          );
        } catch (cause: unknown) {
          const completed = completedStableArtifact(cause);
          if (
            !(cause instanceof ArtifactReaderFailure) ||
            completed === undefined
          )
            throw cause;
          file = completed;
          const cleanup =
            cause.cleanup === undefined
              ? undefined
              : new ProviderCleanupError(
                  this.identity.id,
                  cause.cleanup.resources,
                  {
                    phase: "reply_descriptor_close",
                    reason: cause.cleanup.reason,
                  },
                  { operation: OPERATION, cause, capturedOutput },
                );
          if (cleanup !== undefined) bindArtifactFileCleanup(cause, cleanup);
          const primary =
            cause.reason === "cancelled"
              ? cancelledBy(
                  OPERATION,
                  carriedReason(artifactFileCancellationCause(cause)),
                  { capturedOutput },
                )
              : (cleanup ??
                new AnalysisOutputError(OPERATION, cause.message, {
                  cause,
                  capturedOutput,
                }));
          replyFinalization =
            cleanup !== undefined && primary !== cleanup
              ? analysisErrorWithCleanupDependencies(
                  primary,
                  cleanup,
                  OPERATION,
                )
              : primary;
        }
        const decoded = safeParseUtf8Json(file.bytes);
        if (!decoded.ok) throw decoded.cause;
        reply = replySchema.parse(decoded.value);
      } catch (cause: unknown) {
        if (
          cause instanceof ArtifactReaderFailure &&
          cause.reason === "cancelled"
        ) {
          const error = cancelledBy(
            OPERATION,
            carriedReason(artifactFileCancellationCause(cause)),
            {
              capturedOutput,
              ...(cause instanceof ArtifactReaderFailure &&
              cause.cleanup !== undefined
                ? { cleanup: cause.cleanup }
                : {}),
            },
          );
          bindArtifactFileCleanup(cause, error);
          throw error;
        }
        const error = new AnalysisOutputError(
          OPERATION,
          `Owned pwntools decoder reply failed for ${input.path}: ${cause instanceof z.ZodError ? cause.issues[0]?.message + " at " + (cause.issues[0]?.path.map(String).join(".") ?? "root") : errorMessage(cause)}`,
          {
            cause,
            capturedOutput,
            ...(cause instanceof ArtifactReaderFailure &&
            cause.reason === "limit"
              ? pwntoolsReplyOutputLimit(producerLimits)
              : {}),
            ...(cause instanceof ArtifactReaderFailure
              ? { cleanup: cause.cleanup }
              : {}),
          },
        );
        bindArtifactFileCleanup(cause, error);
        throw error;
      }
      if (!reply.ok) {
        if (reply.reason === "unsupported-target")
          throw new AnalysisUnsupportedTargetError(
            OPERATION,
            input.path,
            reply.message,
            { capturedOutput },
          );
        if (reply.reason === "resource-limit")
          throw new AnalysisResourceConstraintError(
            OPERATION,
            "memory",
            `${reply.message} ${pwntoolsBudgetRecovery(producerLimits)}`,
            reply.reported_limits ?? null,
            {
              capturedOutput,
              remediationAction: `Review reported limits and available host memory; allocation failure alone does not prove exhaustion. ${pwntoolsBudgetRecovery(producerLimits)}`,
            },
          );
        if (reply.reason === "format")
          throw new AnalysisInputError(OPERATION, { capturedOutput }, [
            {
              path: ["path"],
              reason: "invalid_format",
              message: reply.message,
            },
          ]);
        if (reply.reason === "unavailable")
          throw pwntoolsUnavailable(
            reply.message,
            environment.REA_PWNTOOLS_PYTHON ?? "",
            undefined,
            capturedOutput,
            context,
          );
        if (reply.reason === "unsupported")
          throw new AnalysisCapabilityUnavailableError(
            this.identity.id,
            OPERATION,
            reply.message,
            { userMessage: reply.message, capturedOutput },
          );
        if (reply.reason === "output-limit")
          throw new AnalysisOutputError(OPERATION, reply.message, {
            capturedOutput,
            ...pwntoolsReplyOutputLimit(producerLimits),
          });
        throw new ProviderAdapterError(this.identity.id, OPERATION, {
          diagnostics: {
            phase,
            failure_kind: reply.reason,
            reason: reply.message,
            stdout: capturedOutput.stdout,
            stderr: capturedOutput.stderr,
            captured_output: { ...capturedOutput },
          },
        });
      }
      const admitted = this.profile.project({
        input,
        payload: reply.value,
        snapshot,
        diagnostics: providerResultDiagnostics(capturedOutput),
      });
      if (replyFinalization !== undefined) {
        result = err(
          replyFinalization.retainPartialObservation(
            this.profile.partialObservation?.(input, admitted) ?? admitted,
          ),
        );
      } else {
        result = ok(
          this.profile.enrich === undefined
            ? admitted
            : await this.profile.enrich({
                environment,
                input,
                report: admitted,
                snapshot,
                rootPath: root.path,
                resources: this.#resources,
                options,
                runCommand: (spawn, classifyFailure) =>
                  this.#runCommand(
                    producerLimits,
                    spawn,
                    options,
                    classifyFailure,
                  ),
                timeoutMs,
                producerLimits,
              }),
        );
      }
    } catch (caught: unknown) {
      let cause = caught;
      if (replyFinalization !== undefined && cause !== replyFinalization) {
        const primary = failure(cause);
        cause = replyFinalization.cleanupIncomplete
          ? analysisErrorWithCleanupDependencies(
              primary,
              replyFinalization,
              OPERATION,
            )
          : primary.retainSecondaryFailure(replyFinalization, {
              reply_finalization_error:
                projectAnalysisErrorWithoutCapturedOutput(replyFinalization),
            });
      }
      // The command owner has exhausted this operation's cleanup attempts.
      // Keep its resources and do not consume files an unresolved worker may change.
      if (cause instanceof AnalysisError && cause.cleanupIncomplete) {
        if (this.#pendingCleanup !== undefined) {
          this.#pendingCleanup.failure = cause;
          this.#pendingCleanup.observation = cause.partialObservation;
        }
        return err(cause);
      }
      const evidence = await readPwntoolsFailureEvidence(
        cause,
        root?.path,
        this.#resources,
        producerLimits,
      );
      const primary = classifyProviderFailure(
        cause,
        pwntoolsFailureDialect(
          phase,
          phase === "configuration" ? executablePath : input.path,
          executablePath,
          evidence,
          context,
        ),
      );
      result = err(primary);
    }
    if (this.#pendingCleanup !== undefined) {
      this.#pendingCleanup.failure = result.ok ? undefined : result.error;
      this.#pendingCleanup.observation = result.ok
        ? result.value
        : result.error.partialObservation;
      this.#pendingCleanup.diagnostics = result.ok
        ? result.value.diagnostics
        : result.error.capturedOutput;
    }
    const finalized = await runOwned(async () => result, {
      providerId: this.identity.id,
      operation: OPERATION,
      signal: options?.signal,
      partial: (report) => report,
      capturedOutput: (report, replacement) =>
        replacement === "cancellation" ? report.diagnostics : undefined,
      close: async () => {
        const cleanup = await this.#completeCleanup(() => this.#retire());
        if (cleanup !== undefined) throw cleanup;
      },
    });
    const completed = finalizedResult(finalized);
    if (!completed.ok && this.#pendingCleanup !== undefined)
      this.#pendingCleanup.failure = completed.error;
    return completed;
  }

  async #runCommand(
    limits: PwntoolsProducerLimits,
    spawn: OwnedProviderProcessSpawnOptions,
    options: ExecutionOptions | undefined,
    failure: (cause: unknown) => AnalysisError,
  ): Promise<ProviderProcessSnapshot> {
    // A runtime is registered before either decoder stage may acquire a process.
    const pending = this.#pendingCleanup;
    if (pending === undefined)
      throw invariantViolation("Decoder command requires an owned runtime.");
    let outcome: Result<ProviderProcessSnapshot, unknown>;
    try {
      outcome = ok(
        await runOwnedCommand(
          {
            ...spawn,
            // Every decoder stage can replace its launcher through exec,
            // including the optional Python-to-GDB handoff. Preserve explicit
            // pins; otherwise keep parent/group/run-token proof across exec.
            expectedCommand: spawn.expectedCommand ?? null,
          },
          {
            timeoutMs: limits.command_timeout_ms,
            diagnosticBytes: limits.diagnostic_bytes,
          },
          {
            ...(options?.signal === undefined
              ? {}
              : { signal: options.signal }),
            ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
            retainCleanup: (supervisor) => {
              const ownership = supervisor.launch.ownership;
              pending.process = {
                supervisor,
                lease: new AnalysisCleanupLease(
                  async () => {
                    const stopped = await supervisor.stop();
                    if (stopped.status === "incomplete")
                      throw new Error(stopped.reason, { cause: stopped });
                  },
                  ownership === undefined
                    ? ["owned-decoder"]
                    : ownedCommandResources(ownership),
                ),
              };
            },
          },
        ),
      );
    } catch (cause: unknown) {
      outcome = err(cause);
    }
    const cleanup = await this.#completeCleanup(() => this.#retireProcess());
    if (cleanup !== undefined) {
      if (outcome.ok) throw cleanup;
      // Until retirement succeeds, resource-limit markers remain unverified.
      const primary = failure(outcome.error);
      throw analysisErrorWithCleanupDependencies(
        primary,
        cleanup,
        this.profile.operation,
      );
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /** Drain the running inspection, reject queued acquisition, and retry retained processes before deleting their files. */
  close(): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#tail
      .then(async () => {
        let failure: AnalysisError | undefined;
        try {
          failure = await this.#retire();
        } catch (cause: unknown) {
          failure = new ProviderCleanupError(
            this.identity.id,
            [this.#pendingCleanup?.root?.path ?? "pwntools decoder"],
            { reason: errorMessage(cause) },
            { operation: this.profile.operation, cause },
          );
        }
        try {
          await this.#resources.close();
        } catch (cause: unknown) {
          const observation = ArtifactReaderFailure.cleanupObservation(
            cause,
            "pwntools artifact read",
          );
          const resourceFailure = new ProviderCleanupError(
            this.identity.id,
            observation.resources,
            { reason: observation.reason },
            { operation: this.profile.operation, cause },
          );
          bindArtifactFileCleanup(cause, resourceFailure);
          failure =
            failure === undefined
              ? resourceFailure
              : analysisErrorWithCleanupDependencies(
                  failure,
                  resourceFailure,
                  this.profile.operation,
                );
        }
        if (failure !== undefined) throw failure;
      })
      .catch((cause: unknown) => {
        this.#closePromise = undefined;
        throw cause;
      });
    return this.#closePromise;
  }

  #closedError(): AnalysisCapabilityUnavailableError {
    return new AnalysisCapabilityUnavailableError(
      this.identity.id,
      this.profile.operation,
      "Provider is closing; create a new inspection service.",
    );
  }

  async #completeCleanup(
    retire: () => Promise<AnalysisError | undefined>,
  ): Promise<AnalysisError | undefined> {
    const failure = await retire();
    return failure !== undefined && this.#closing ? retire() : failure;
  }

  async #retireProcess(): Promise<ProviderCleanupError | undefined> {
    const pending = this.#pendingCleanup;
    if (pending?.process === undefined) return undefined;
    const process = pending.process;
    const ownership = process.supervisor.launch.ownership;
    try {
      await process.lease.release();
    } catch (cause: unknown) {
      const failure = new ProviderCleanupError(
        this.identity.id,
        ownership === undefined
          ? [
              "owned-decoder",
              ...(pending.root === undefined ? [] : [pending.root.path]),
            ]
          : ownedCommandResources(ownership, pending.root?.path),
        {
          reason: errorMessage(cause),
          captured_output: {
            ...(pending.diagnostics ??
              capturedProviderOutput(process.supervisor.snapshot())),
          },
          previous_error:
            pending.failure === undefined
              ? null
              : projectAnalysisError(pending.failure),
        },
        {
          operation: this.profile.operation,
          cause,
          ...(pending.observation === undefined
            ? {}
            : { partialObservation: pending.observation }),
        },
      );
      new AnalysisCleanupLeaseGroup(failure, [
        process.lease,
        pending.rootLease,
      ]);
      return failure;
    }
    pending.process = undefined;
    return undefined;
  }

  async #retire(): Promise<AnalysisError | undefined> {
    let failure: AnalysisError | undefined;
    try {
      await this.#resources.retryCleanup();
    } catch (cause: unknown) {
      const observation = ArtifactReaderFailure.cleanupObservation(
        cause,
        "pwntools artifact read",
      );
      failure = new ProviderCleanupError(
        this.identity.id,
        observation.resources,
        { reason: observation.reason },
        {
          operation: this.profile.operation,
          cause,
          ...(this.#pendingCleanup?.observation === undefined
            ? {}
            : { partialObservation: this.#pendingCleanup.observation }),
        },
      );
    }
    if (failure !== undefined) bindArtifactFileCleanup(failure.cause, failure);
    const processFailure = await this.#retireProcess();
    if (processFailure !== undefined) {
      return failure === undefined
        ? processFailure
        : analysisErrorWithCleanupDependencies(
            failure,
            processFailure,
            this.profile.operation,
          );
    }
    // Retained descriptors still own local evidence under this root.
    if (failure !== undefined) return failure;
    const pending = this.#pendingCleanup;
    if (pending?.root !== undefined) {
      const root = pending.root;
      try {
        await pending.rootLease.release();
        pending.root = undefined;
      } catch (cause: unknown) {
        const rootFailure = new ProviderCleanupError(
          this.identity.id,
          [root.path],
          {
            reason: errorMessage(cause),
            ...(pending.diagnostics === undefined
              ? {}
              : { captured_output: { ...pending.diagnostics } }),
            previous_error:
              pending.failure === undefined
                ? null
                : projectAnalysisError(pending.failure),
          },
          {
            operation: this.profile.operation,
            cause,
            ...(pending.observation === undefined
              ? {}
              : { partialObservation: pending.observation }),
          },
        );
        new AnalysisCleanupLeaseGroup(rootFailure, [pending.rootLease]);
        failure = rootFailure;
      }
    }
    if (!this.#resources.hasPending && pending?.root === undefined)
      this.#pendingCleanup = undefined;
    return failure;
  }
}
