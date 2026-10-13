import {
  pwntoolsDecoderFailure,
  pwntoolsUnavailable,
  capturedPwntoolsOutput,
} from "./PwntoolsFailures.js";
import { randomUUID } from "node:crypto";
import { access, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import type { ProviderIdentity } from "../../application/AnalysisProvider.js";
import type {
  AnalysisCapturedOutput,
  AnalysisPartialObservation,
} from "../../domain/analysisErrorBase.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisUnsupportedTargetError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
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
  pwntoolsResourceLimitsSchema,
  readPwntoolsFailureEvidence,
} from "./PwntoolsResourceLimits.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import {
  PWNTOOLS_PROVIDER_IDENTITY,
  PWNTOOLS_LIMITS,
} from "./PwntoolsRelease.js";
import { pwntoolsInputBytes } from "./PwntoolsInputLimit.js";

const HOST_REQUIREMENT =
  "The initial real-verified pwntools artifact profile supports Linux x64 only.";

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
  Input extends { readonly path: string },
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
    readonly rootPath: string;
    readonly resources: ArtifactResourceScope;
    readonly diagnostics: AnalysisCapturedOutput;
    readonly options: ExecutionOptions | undefined;
    readonly runCommand: PwntoolsCommand;
  }) => Report | Promise<Report>;
}

/** Thin owned-process adapter; all ELF parsing and heuristics come from unchanged upstream code. */
export class PwntoolsDecoder<
  Input extends { readonly path: string },
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
        process: ProviderProcessSupervisor | undefined;
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
        err(new AnalysisCancelledError(this.profile.operation)),
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
        return err(new AnalysisCancelledError(this.profile.operation));
      return this.#closing ? err(this.#closedError()) : inspect();
    });
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return admission.then((state) =>
      state === "cancelled"
        ? err(new AnalysisCancelledError(this.profile.operation))
        : operation,
    );
  }

  async #inspect(
    input: Input,
    options?: ExecutionOptions,
  ): Promise<Result<Report, AnalysisError>> {
    const pending = await this.#retire();
    if (pending !== undefined) return err(pending);
    const OPERATION = this.profile.operation;
    const context = { operation: OPERATION, providerId: this.identity.id };
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
        reported_limits: pwntoolsResourceLimitsSchema.nullable().optional(),
      }),
    ]);
    let root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
    let result: Result<Report, AnalysisError>;
    let phase: "configuration" | "artifact-read" | "decoder" = "configuration";
    const executablePath = this.environment.REA_PWNTOOLS_PYTHON ?? "";
    let selectedPath = executablePath;
    const failure = (cause: unknown) =>
      pwntoolsDecoderFailure(
        cause,
        phase,
        selectedPath,
        executablePath,
        {},
        context,
      );
    try {
      if (options?.signal?.aborted) throw new AnalysisCancelledError(OPERATION);
      if (process.platform !== "linux" || process.arch !== "x64")
        throw new AnalysisCapabilityUnavailableError(
          this.identity.id,
          OPERATION,
          HOST_REQUIREMENT,
          { userMessage: HOST_REQUIREMENT },
        );
      if (!isAbsolute(selectedPath))
        throw pwntoolsUnavailable(
          "Set REA_PWNTOOLS_PYTHON to an absolute caller-supplied Python executable with pwntools 4.15.0, pyelftools 0.33 and Unicorn 2.1.2; REA never installs Python or packages.",
          selectedPath,
          undefined,
          undefined,
          context,
        );
      await access(selectedPath, constants.X_OK);
      if (!(await stat(selectedPath)).isFile())
        throw pwntoolsUnavailable(
          "Selected Python executable must be a regular executable file, not a directory: " +
            selectedPath,
          selectedPath,
          undefined,
          undefined,
          context,
        );
      const inputLimit = pwntoolsInputBytes(this.environment);
      if (!inputLimit.configured)
        throw pwntoolsUnavailable(
          inputLimit.error,
          selectedPath,
          undefined,
          undefined,
          {
            ...context,
            configurationKey: "REA_PWNTOOLS_MAX_INPUT_BYTES",
          },
        );
      phase = "artifact-read";
      selectedPath = input.path;
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
        process: undefined,
        failure: undefined,
        diagnostics: undefined,
        observation: undefined,
      };
      const requestPath = join(root.path, "request.json");
      const snapshotPath = join(root.path, "object.snapshot");
      const replyPath = join(root.path, "reply.json");
      await writeFile(snapshotPath, snapshot.bytes, {
        flag: "wx",
        mode: 0o600,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      await writeFile(
        requestPath,
        JSON.stringify({ snapshot_path: snapshotPath, reply_path: replyPath }),
        { flag: "wx", mode: 0o600 },
      );
      const execution = await this.#runCommand(
        {
          command: this.environment.REA_PWNTOOLS_PYTHON ?? "",
          arguments: [
            "-I",
            fileURLToPath(this.profile.bridge),
            join(root.path, "resource.failure"),
            requestPath,
          ],
          cwd: root.path,
          // Caller-selected Python launchers can exec through prlimit or a
          // shell wrapper. Keep parent/group/run-token ownership across exec.
          expectedCommand: null,
          runId: `rea-artifact-decoder-${randomUUID()}`,
          hostEnvironment: {
            ...this.environment,
            PWNLIB_NOTERM: "1",
            OPENBLAS_NUM_THREADS: "1",
            OMP_NUM_THREADS: "1",
          },
        },
        options,
        failure,
      );
      const capturedOutput = capturedPwntoolsOutput(execution);
      let reply: z.output<typeof replySchema>;
      try {
        const file = await readStableArtifact(
          replyPath,
          PWNTOOLS_LIMITS.outputBytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        reply = replySchema.parse(JSON.parse(file.bytes.toString("utf8")));
      } catch (cause: unknown) {
        if (options?.signal?.aborted)
          throw new AnalysisCancelledError(OPERATION, {
            cause,
            capturedOutput,
          });
        throw new AnalysisOutputError(
          OPERATION,
          `Owned pwntools decoder reply failed for ${input.path}: ${cause instanceof z.ZodError ? cause.issues[0]?.message + " at " + (cause.issues[0]?.path.map(String).join(".") ?? "root") : cause instanceof Error ? cause.message : String(cause)}`,
          { cause, capturedOutput },
        );
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
            reply.message,
            reply.reported_limits ?? null,
            { capturedOutput },
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
            this.environment.REA_PWNTOOLS_PYTHON ?? "",
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
          });
        throw new ProviderAdapterError(this.identity.id, OPERATION, {
          diagnostics: {
            phase,
            failure_kind: reply.reason,
            reason: reply.message,
            stdout: execution.stdout.text,
            stderr: execution.stderr.text,
            captured_output: { ...capturedOutput },
          },
        });
      }
      result = ok(
        await this.profile.project({
          input,
          payload: reply.value,
          snapshot,
          rootPath: root.path,
          resources: this.#resources,
          diagnostics: capturedOutput,
          options,
          runCommand: (spawn, classifyFailure) =>
            this.#runCommand(spawn, options, classifyFailure),
        }),
      );
    } catch (cause: unknown) {
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
      );
      const primary =
        options?.signal?.aborted &&
        (cause === options.signal.reason ||
          (cause instanceof Error && cause.name === "AbortError") ||
          (cause instanceof ArtifactReaderFailure &&
            cause.cleanup !== undefined))
          ? new AnalysisCancelledError(OPERATION, { cause })
          : pwntoolsDecoderFailure(
              cause,
              phase,
              selectedPath,
              executablePath,
              evidence,
              context,
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
    const cleanup = await this.#completeCleanup(() => this.#retire());
    if (cleanup !== undefined)
      return err(
        result.ok
          ? cleanup
          : analysisErrorWithCleanupFailure(result.error, cleanup, OPERATION),
      );
    return result.ok && options?.signal?.aborted
      ? err(
          new AnalysisCancelledError(OPERATION, {
            partialObservation: result.value,
            capturedOutput: {
              stdout: result.value.diagnostics.stdout,
              stderr: result.value.diagnostics.stderr,
              truncated: result.value.diagnostics.truncated,
            },
          }),
        )
      : result;
  }

  async #runCommand(
    spawn: OwnedProviderProcessSpawnOptions,
    options: ExecutionOptions | undefined,
    failure: (cause: unknown) => AnalysisError,
  ): Promise<ProviderProcessSnapshot> {
    // A runtime is registered before either decoder stage may acquire a process.
    const pending = this.#pendingCleanup;
    if (pending === undefined)
      throw new Error("Decoder command requires an owned runtime.");
    let outcome: Result<ProviderProcessSnapshot, unknown>;
    try {
      outcome = ok(
        await runOwnedCommand(
          spawn,
          {
            timeoutMs: PWNTOOLS_LIMITS.timeoutMs,
            diagnosticBytes: PWNTOOLS_LIMITS.diagnosticBytes,
          },
          {
            ...(options?.signal === undefined
              ? {}
              : { signal: options.signal }),
            ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
            retainCleanup: (owner) => {
              pending.process = owner;
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
      throw analysisErrorWithCleanupFailure(
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
            { reason: cause instanceof Error ? cause.message : String(cause) },
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
          failure =
            failure === undefined
              ? resourceFailure
              : analysisErrorWithCleanupFailure(
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
    const stopped = await pending.process.stop();
    const ownership = pending.process.launch.ownership;
    if (stopped.status === "incomplete")
      return new ProviderCleanupError(
        this.identity.id,
        ownership === undefined
          ? [
              "owned-decoder",
              ...(pending.root === undefined ? [] : [pending.root.path]),
            ]
          : ownedCommandResources(ownership, pending.root?.path),
        {
          reason: stopped.reason,
          captured_output: {
            ...(pending.diagnostics ??
              capturedPwntoolsOutput(pending.process.snapshot())),
          },
          previous_error:
            pending.failure === undefined
              ? null
              : projectAnalysisError(pending.failure),
        },
        {
          operation: this.profile.operation,
          ...(pending.observation === undefined
            ? {}
            : { partialObservation: pending.observation }),
        },
      );
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
    const processFailure = await this.#retireProcess();
    if (processFailure !== undefined) {
      return failure === undefined
        ? processFailure
        : analysisErrorWithCleanupFailure(
            failure,
            processFailure,
            this.profile.operation,
          );
    }
    const pending = this.#pendingCleanup;
    if (pending?.root !== undefined) {
      const root = pending.root;
      try {
        await root.close();
        pending.root = undefined;
      } catch (cause: unknown) {
        const rootFailure = new ProviderCleanupError(
          this.identity.id,
          [root.path],
          {
            reason: cause instanceof Error ? cause.message : String(cause),
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
        failure =
          failure === undefined
            ? rootFailure
            : analysisErrorWithCleanupFailure(
                failure,
                rootFailure,
                this.profile.operation,
              );
      }
    }
    if (!this.#resources.hasPending && pending?.root === undefined)
      this.#pendingCleanup = undefined;
    return failure;
  }
}
