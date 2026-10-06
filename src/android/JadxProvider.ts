import { z } from "zod";
import type { AndroidAnalysisPort } from "../application/AndroidAnalysisPort.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { AndroidRequest } from "../domain/androidAnalysis.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { err, ok } from "../domain/result.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import {
  snapshotAndroidEngine,
  snapshotAndroidTarget,
} from "./AndroidTargetSnapshot.js";
import { resolveJadxConfiguration } from "./JadxConfiguration.js";
import type { JadxLauncher } from "./JadxMcpTransport.js";
import { JadxSession } from "./JadxSession.js";

const OPERATION_TIMEOUT_MS = 120_000;
type Outcome = Awaited<ReturnType<AndroidAnalysisPort["execute"]>>;

const waitForTurn = (
  predecessor: Promise<void>,
  request: AndroidRequest,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const abort = () => reject(new AnalysisCancelledError(request.operation));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
    void predecessor.then(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    });
  });

const executionError = (context: {
  cause: unknown;
  request: AndroidRequest;
  timeout: AbortSignal;
  signal: AbortSignal | undefined;
  session: JadxSession | undefined;
}): AnalysisError => {
  const { cause, request, timeout, signal, session } = context;
  if (signal?.aborted === true)
    return new AnalysisCancelledError(request.operation);
  if (timeout.aborted)
    return new AnalysisTimeoutError(request.operation, OPERATION_TIMEOUT_MS);
  if (cause instanceof AnalysisError) return cause;
  const protocolFailure = session?.transport.failureReason();
  if (protocolFailure !== undefined && protocolFailure !== null)
    return new AnalysisOutputError(request.operation, protocolFailure, {
      cause,
    });
  if (cause instanceof z.ZodError)
    return new AnalysisOutputError(
      request.operation,
      "JADX response violated the pinned upstream protocol",
      { cause },
    );
  return new ProviderAdapterError("jadx", request.operation, {
    cause,
    diagnostics: {
      reason: cause instanceof Error ? cause.message : String(cause),
      stderr: session?.transport.diagnostics() ?? "",
    },
  });
};

const cleanup = async (
  session: JadxSession | undefined,
  root: PrivateRuntimeRoot | undefined,
  previous: Outcome,
): Promise<Outcome> => {
  const diagnostics = {
    previous_error: previous.ok
      ? null
      : { tag: previous.error._tag, message: previous.error.message },
  };
  try {
    await session?.close();
  } catch (cause) {
    // Retain an uncertain workspace until the caller can resolve process ownership.
    return err(
      new ProviderCleanupError(
        "jadx",
        [
          session?.transport.runId ?? "unknown",
          ...(root === undefined ? [] : [root.path]),
        ],
        {
          ...diagnostics,
          reason: cause instanceof Error ? cause.message : String(cause),
          provider_cleanup:
            cause instanceof ProviderCleanupError
              ? (cause.diagnostics ?? null)
              : null,
        },
        { cause },
      ),
    );
  }
  try {
    await root?.close();
  } catch (cause) {
    return err(
      new ProviderCleanupError(
        "jadx",
        [root?.path ?? "unknown"],
        {
          ...diagnostics,
          reason: cause instanceof Error ? cause.message : String(cause),
        },
        { cause },
      ),
    );
  }
  return previous;
};

/** One queued engine per REA instance, with a fresh owned workspace for every request. */
export class JadxProvider implements AndroidAnalysisPort {
  #tail: Promise<void> = Promise.resolve();
  #cleanupFailure: AnalysisError | undefined;
  constructor(
    readonly environment: Readonly<
      Record<string, string | undefined>
    > = process.env,
    readonly launcher?: JadxLauncher,
  ) {}

  /** Serialize expensive work and bind both raw and normalized results to the APK. */
  async execute(
    target: BinaryTarget,
    request: AndroidRequest,
    options?: ExecutionOptions,
  ): Promise<Outcome> {
    const predecessor = this.#tail;
    let release: () => void = () => {};
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await waitForTurn(predecessor, request, options?.signal);
    } catch {
      void predecessor.then(release);
      return err(new AnalysisCancelledError(request.operation));
    }
    try {
      if (options?.signal?.aborted === true)
        return err(new AnalysisCancelledError(request.operation));
      if (this.#cleanupFailure !== undefined) return err(this.#cleanupFailure);
      const outcome = await this.#execute(target, request, options);
      if (!outcome.ok && outcome.error.cleanupIncomplete)
        this.#cleanupFailure = outcome.error;
      return outcome;
    } finally {
      release();
    }
  }

  async #execute(
    target: BinaryTarget,
    request: AndroidRequest,
    options?: ExecutionOptions,
  ): Promise<Outcome> {
    const timeout = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
    const signal =
      options?.signal === undefined
        ? timeout
        : AbortSignal.any([options.signal, timeout]);
    let root: PrivateRuntimeRoot | undefined;
    let session: JadxSession | undefined;
    let outcome: Outcome;
    try {
      if (target.format !== "apk")
        throw new AnalysisCapabilityUnavailableError(
          "jadx",
          request.operation,
          `Target ${target.path} is ${target.format}; provide one standalone APK.`,
        );
      const configuration = await resolveJadxConfiguration(
        this.environment,
        request.operation,
      );
      signal.throwIfAborted();
      root = await PrivateRuntimeRoot.create({ prefix: "rea-android-" });
      const engine = await snapshotAndroidEngine(configuration.jar, root.path);
      const snapshot = await snapshotAndroidTarget(
        target.path,
        target.sha256,
        root.path,
        request.operation,
      );
      signal.throwIfAborted();
      session = new JadxSession(
        {
          command: configuration.java,
          arguments: [
            "-Xmx512m",
            "-XX:ActiveProcessorCount=1",
            "-jar",
            engine.path,
            "--threads",
            "1",
            "--max-source-bytes",
            "1048576",
            "--decompile-timeout-ms",
            "90000",
          ],
          cwd: root.path,
          hostEnvironment: this.environment,
          env: { _JAVA_OPTIONS: "-Xmx512m -XX:ActiveProcessorCount=1" },
        },
        this.launcher,
      );
      outcome = ok(
        await session.execute({
          request,
          target,
          snapshot,
          jarHash: engine.sha256,
          signal,
        }),
      );
    } catch (cause) {
      outcome = err(
        executionError({
          cause,
          request,
          timeout,
          signal: options?.signal,
          session,
        }),
      );
    }
    return cleanup(session, root, outcome);
  }
}
