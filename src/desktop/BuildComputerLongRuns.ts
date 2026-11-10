import { randomUUID } from "node:crypto";

import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  AGENTENV_PROVIDER,
  type ComputerRelease,
} from "./AgentEnvComputerHelper.js";
import {
  answerSchema,
  runBuildController,
  type Answer,
  type ControlledComputer,
} from "./BuildComputerController.js";

const OPERATION = "export_build_environment";
const POLL_S = 30;
const CANCEL_S = 10;

interface Job {
  readonly path: string;
  readonly token: string;
  readonly stdout: string;
  readonly failures: Set<WeakRef<ProviderCleanupError>>;
}

/** Owns REA commands that need longer than one computer-exec call permits. */
export class BuildComputerLongRuns {
  readonly #jobs = new Set<Job>();

  constructor(private readonly computer: ControlledComputer) {}

  get cleanupResources(): readonly string[] {
    return [...this.#jobs].map(({ path }) => path);
  }

  async run(
    argv: readonly string[],
    options: {
      readonly work: string;
      readonly stdout: string;
      readonly files?: Readonly<Record<string, string>>;
      readonly timeoutS: number;
      readonly signal: AbortSignal;
    },
  ): Promise<{
    readonly stdoutBytes: number;
    readonly exitCode: number | null;
    readonly stderr: string;
  }> {
    const { signal } = options;
    if (signal.aborted)
      throw new AnalysisCancelledError(OPERATION, { cause: signal.reason });
    const previous = await this.release();
    if (!previous.verified)
      throw this.#cleanupFailure(
        previous.reason,
        signal.aborted
          ? new AnalysisCancelledError(OPERATION, { cause: signal.reason })
          : undefined,
      );
    if (signal.aborted)
      throw new AnalysisCancelledError(OPERATION, { cause: signal.reason });
    const token = randomUUID();
    const job: Job = {
      path: `${options.work}/jobs/${token}`,
      token,
      stdout: options.stdout,
      failures: new Set(),
    };
    this.#jobs.add(job);
    const deadline = performance.now() + options.timeoutS * 1000;
    try {
      const started = answerSchema.parse(
        await runBuildController(
          this.computer,
          "run-begin",
          {
            job: job.path,
            token,
            work: options.work,
            stdout: options.stdout,
            files: { ...options.files },
            argv: [...argv],
            timeout_s: options.timeoutS,
          },
          { timeoutS: POLL_S, signal },
        ),
      );
      if (typeof started.refused === "string") {
        this.#jobs.delete(job);
        throw new Error(started.refused);
      }
      if (started.started !== true)
        throw new Error(
          typeof started.error === "string"
            ? started.error
            : "The REA command did not start.",
        );
      for (;;) {
        if (performance.now() >= deadline)
          throw new Error(
            "The REA command exceeded its time budget and is still stopping.",
          );
        const answer = answerSchema.parse(
          await runBuildController(
            this.computer,
            "run-poll",
            {
              job: job.path,
              token,
              timeout_s: POLL_S,
            },
            { timeoutS: POLL_S, signal },
          ),
        );
        if (answer.pending === true && answer.timed_out === true)
          throw new Error(
            "The REA command exceeded its time budget and is still stopping.",
          );
        if (answer.pending === true) continue;
        if (answer.finished !== true)
          throw new Error(
            typeof answer.error === "string"
              ? answer.error
              : "The REA command did not report its outcome.",
          );
        this.#jobs.delete(job);
        if (answer.timed_out === true || typeof answer.error === "string") {
          const failure = new ProviderAdapterError(
            AGENTENV_PROVIDER,
            OPERATION,
            {
              userMessage:
                answer.error ?? "The REA command exceeded its time budget.",
            },
          );
          throw failure.retainDiagnostics({
            completed_command: this.#receipt(job, answer),
          });
        }
        if (
          typeof answer.exit_code !== "number" ||
          typeof answer.stdout_bytes !== "number"
        )
          throw new Error(
            "The REA command did not report its output and exit status.",
          );
        return {
          stdoutBytes: answer.stdout_bytes,
          exitCode: answer.exit_code,
          stderr: typeof answer.stderr === "string" ? answer.stderr : "",
        };
      }
    } catch (cause: unknown) {
      let primary = signal.aborted
        ? new AnalysisCancelledError(OPERATION, { cause: signal.reason })
        : cause instanceof AnalysisError
          ? cause
          : new ProviderAdapterError(AGENTENV_PROVIDER, OPERATION, {
              userMessage:
                cause instanceof Error ? cause.message : String(cause),
              cause,
            });
      if (signal.aborted && cause instanceof AnalysisError && cause !== primary)
        primary.retainSecondaryFailure(cause);
      if (!this.#jobs.has(job)) throw primary;
      const released = await this.#cancel(job);
      if (signal.aborted && !(primary instanceof AnalysisCancelledError)) {
        const cancelled = new AnalysisCancelledError(OPERATION, {
          cause: signal.reason,
        });
        cancelled.retainSecondaryFailure(primary);
        primary = cancelled;
      }
      if (released.verified) {
        if (released.completed !== undefined)
          primary.retainDiagnostics({ completed_command: released.completed });
        throw primary;
      }
      throw this.#cleanupFailure(released.reason, primary, job);
    }
  }

  /** Stop each command and retain any job whose completion cannot be confirmed. */
  async release(): Promise<ComputerRelease> {
    const failures: string[] = [];
    for (const job of this.#jobs) {
      const result = await this.#cancel(job);
      if (!result.verified) failures.push(result.reason);
    }
    return failures.length === 0
      ? { verified: true, teardown: "agentenv" }
      : {
          verified: false,
          reason: failures.join("; "),
          resources: this.cleanupResources,
        };
  }

  async #cancel(
    job: Job,
  ): Promise<
    | { readonly verified: true; readonly completed?: JsonValue }
    | { readonly verified: false; readonly reason: string }
  > {
    try {
      const answer = answerSchema.parse(
        await runBuildController(
          this.computer,
          "run-cancel",
          {
            job: job.path,
            token: job.token,
            timeout_s: CANCEL_S,
          },
          { timeoutS: CANCEL_S },
        ),
      );
      if (answer.absent !== true && answer.finished !== true)
        return {
          verified: false,
          reason:
            typeof answer.error === "string"
              ? answer.error
              : `The remote REA command has not confirmed that it stopped.${answer.progress === undefined ? "" : ` Supervisor output: ${answer.progress}`}`,
        };
      const completed =
        answer.finished === true ? this.#receipt(job, answer) : undefined;
      this.#jobs.delete(job);
      for (const reference of job.failures) {
        const failure = reference.deref();
        if (completed !== undefined)
          failure?.retainDiagnostics({ completed_command: completed });
        failure?.resolveCleanup();
      }
      return {
        verified: true,
        ...(completed === undefined ? {} : { completed }),
      };
    } catch (cause: unknown) {
      return {
        verified: false,
        reason: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  #receipt(job: Job, answer: Answer): JsonValue {
    return {
      stdout: job.stdout,
      ...(typeof answer.stdout_bytes === "number"
        ? { stdout_bytes: answer.stdout_bytes }
        : {}),
      ...(typeof answer.exit_code === "number"
        ? { exit_code: answer.exit_code }
        : {}),
      ...(typeof answer.stderr === "string" ? { stderr: answer.stderr } : {}),
      ...(typeof answer.error === "string" ? { error: answer.error } : {}),
      ...(answer.timed_out === undefined
        ? {}
        : { timed_out: answer.timed_out }),
      ...(answer.cancelled === undefined
        ? {}
        : { cancelled: answer.cancelled }),
    };
  }

  #cleanupFailure(
    reason: string,
    primary?: AnalysisError,
    job?: Job,
  ): ProviderCleanupError {
    const failure = new ProviderCleanupError(
      AGENTENV_PROVIDER,
      this.cleanupResources,
      { reason },
      {
        operation: OPERATION,
        ...(primary === undefined ? {} : { cleanupPrimary: primary }),
        remediationAction:
          "Retry the export or close the build computer to retry stopping the owned command.",
      },
    );
    failure.bindCleanupResourceOwner(this);
    for (const pending of job === undefined ? this.#jobs : [job])
      pending.failures.add(new WeakRef(failure));
    return failure;
  }
}
