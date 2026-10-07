import { z } from "zod";
import { chmod, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AndroidAnalysisPort } from "../application/android/AndroidAnalysisPort.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
  AnalysisInputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { AndroidRequest } from "../domain/android/androidAnalysis.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { err, ok, type Result } from "../domain/result.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import {
  snapshotAndroidEngine,
  hashAndroidFile,
  snapshotAndroidTarget,
} from "./AndroidTargetSnapshot.js";
import { resolveJadxConfiguration } from "./JadxConfiguration.js";
import type { JadxLauncher } from "./JadxMcpTransport.js";

import { JadxSession } from "./JadxSession.js";

const OPERATION_TIMEOUT_MS = 120_000;
const BRIDGE_SOURCE = fileURLToPath(
  new URL("../../bridge/android/ReaJadxBridge.java", import.meta.url),
);
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

const cleanup = async <Value>(
  session: JadxSession | undefined,
  root: PrivateRuntimeRoot | undefined,
  previous: Result<Value, AnalysisError>,
): Promise<Result<Value, AnalysisError>> => {
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

interface RetainedSession {
  readonly key: string;
  readonly root: PrivateRuntimeRoot;
  readonly session: JadxSession;
  readonly snapshot: string;
  readonly jarHash: string;
  readonly bridgeHash: string;
}

/** One serialized, immutable APK session per REA instance, retired on idle or shutdown. */
export class JadxProvider implements AndroidAnalysisPort {
  #tail: Promise<void> = Promise.resolve();
  #cleanupFailure: AnalysisError | undefined;
  #retained: RetainedSession | undefined;
  #idle: NodeJS.Timeout | undefined;
  readonly #shutdown = new AbortController();
  #closePromise: Promise<void> | undefined;
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
    if (this.#shutdown.signal.aborted)
      return err(new AnalysisCancelledError(request.operation));
    const signal =
      options?.signal === undefined
        ? this.#shutdown.signal
        : AbortSignal.any([options.signal, this.#shutdown.signal]);
    const predecessor = this.#tail;
    let release: () => void = () => {};
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await waitForTurn(predecessor, request, signal);
    } catch {
      void predecessor.then(release);
      return err(new AnalysisCancelledError(request.operation));
    }
    try {
      if (signal.aborted)
        return err(new AnalysisCancelledError(request.operation));
      if (this.#cleanupFailure !== undefined) return err(this.#cleanupFailure);
      clearTimeout(this.#idle);
      const outcome = await this.#execute(target, request, { signal });
      if (!outcome.ok && outcome.error.cleanupIncomplete)
        this.#cleanupFailure = outcome.error;
      if (outcome.ok) this.#scheduleIdle();
      return outcome;
    } finally {
      release();
    }
  }

  /** Cancel queued/active operations and join the owned engine and workspace cleanup. */
  close(): Promise<void> {
    this.#shutdown.abort();
    clearTimeout(this.#idle);
    this.#closePromise ??= this.#tail.then(() => this.#retire());
    return this.#closePromise;
  }

  async #retire(): Promise<void> {
    if (this.#cleanupFailure !== undefined) throw this.#cleanupFailure;
    const retained = this.#retained;
    this.#retained = undefined;
    const result = await cleanup(
      retained?.session,
      retained?.root,
      ok(undefined),
    );
    if (!result.ok) {
      this.#cleanupFailure = result.error;
      throw result.error;
    }
  }

  #scheduleIdle(): void {
    this.#idle = setTimeout(() => {
      const retirement = this.#tail.then(() => this.#retire());
      this.#tail = retirement.catch(() => undefined);
    }, 60_000);
    this.#idle.unref();
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
      const jarHash = await hashAndroidFile(configuration.jar);
      const bridgeHash = await hashAndroidFile(BRIDGE_SOURCE);
      if ((await hashAndroidFile(target.path)) !== target.sha256)
        throw new AnalysisInputError(request.operation, undefined, [
          {
            path: ["path"],
            reason: "invalid_value",
            message:
              "APK bytes changed after admission; retry against a stable file.",
          },
        ]);
      const key = JSON.stringify({
        path: target.path,
        sha256: target.sha256,
        jar: configuration.jar,
        jarHash,
        bridgeHash,
        java: configuration.java,
        arguments: configuration.jvmArguments,
        options: [
          this.environment.JAVA_TOOL_OPTIONS,
          this.environment._JAVA_OPTIONS,
          this.environment.JDK_JAVA_OPTIONS,
          this.environment.PATH,
          this.environment.JAVA_HOME,
        ],
      });
      if (this.#retained !== undefined && this.#retained.key !== key)
        await this.#retire();
      let retained = this.#retained;
      if (retained === undefined) {
        root = await PrivateRuntimeRoot.create({ prefix: "rea-android-" });
        const engine = await snapshotAndroidEngine(
          configuration.jar,
          jarHash,
          root.path,
          request.operation,
        );
        const snapshot = await snapshotAndroidTarget(
          target.path,
          target.sha256,
          root.path,
          request.operation,
        );
        const bridge = join(root.path, "ReaJadxBridge.java");
        await copyFile(BRIDGE_SOURCE, bridge);
        await chmod(bridge, 0o400);
        if ((await hashAndroidFile(bridge)) !== bridgeHash)
          throw new AnalysisCapabilityUnavailableError(
            "jadx",
            request.operation,
            "REA Android bridge bytes changed during admission; retry with a stable installation.",
          );
        signal.throwIfAborted();
        session = new JadxSession(
          {
            command: configuration.java,
            arguments: [
              ...configuration.jvmArguments,
              "--class-path",
              engine.path,
              bridge,
            ],
            cwd: root.path,
            hostEnvironment: this.environment,
          },
          this.launcher,
        );
        retained = {
          key,
          root,
          session,
          snapshot,
          jarHash: engine.sha256,
          bridgeHash,
        };
      }
      root = retained.root;
      session = retained.session;
      const { snapshot } = retained;
      outcome = ok(
        await session.execute({
          request,
          target,
          snapshot,
          jarHash: retained.jarHash,
          bridgeHash: retained.bridgeHash,
          signal,
        }),
      );
      signal.throwIfAborted();
      this.#retained = retained;
      return outcome;
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
    // An existing session also needs retirement when admission fails before selection.
    root ??= this.#retained?.root;
    session ??= this.#retained?.session;
    this.#retained = undefined;
    return cleanup(session, root, outcome);
  }
}
