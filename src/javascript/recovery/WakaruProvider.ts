import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JavaScriptRecoveryPort } from "../../application/javascript/JavaScriptRecoveryPort.js";
import {
  type AnalysisExecution,
  type ExecutionOptions,
} from "../../application/AnalysisProvider.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import type { JavaScriptRecoveryInput } from "../../domain/javascript/javascriptRecovery.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  checkRecoveryCancellation,
  checkRecoveryDeadline,
  recoveryFailureMessage,
  recoveryInputFailure,
  snapshotRecoveryInput,
} from "./RecoveryFiles.js";
import {
  resolveWakaruCommand,
  type WakaruLauncher,
  WakaruCleanupFailure,
} from "./WakaruCommand.js";
import type { ProviderProcessSupervisor } from "../../process/ProviderProcess.js";
import { prepareWakaruExecution } from "./WakaruExecution.js";
import { RECOVERY_LIMITS } from "./WakaruRelease.js";

const OPERATION = "recover_javascript_sources";

/** Serialized recovery adapter retaining failed process, workspace and publication cleanup. */
export class WakaruProvider implements JavaScriptRecoveryPort {
  #tail: Promise<void> = Promise.resolve();
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #pendingCleanup:
    | {
        root: string | undefined;
        process: ProviderProcessSupervisor | undefined;
        tree: SafeOutputTree | undefined;
      }
    | undefined;

  constructor(
    readonly environment: Readonly<
      Record<string, string | undefined>
    > = process.env,
    readonly launcher?: WakaruLauncher,
  ) {}

  /** Recover one script using validated upstream reports and verified output bytes. */
  recover(
    input: JavaScriptRecoveryInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (this.#closing)
      return Promise.resolve(
        err(
          new ProviderCleanupError(
            "wakaru",
            [],
            { reason: "Provider is closing" },
            { operation: OPERATION },
          ),
        ),
      );
    const operation = this.#tail.then(() =>
      this.#closing
        ? err(
            new ProviderCleanupError(
              "wakaru",
              [],
              { reason: "Provider is closing" },
              { operation: OPERATION },
            ),
          )
        : this.#recover(input, options),
    );
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #recover(
    input: JavaScriptRecoveryInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const pending = await this.#retire();
    if (pending !== undefined) return err(pending);
    let root: string | undefined;
    let tree: SafeOutputTree | undefined;
    let failure: unknown;
    let execution: AnalysisExecution | undefined;
    const deadline = Date.now() + RECOVERY_LIMITS.timeoutMs;
    try {
      checkRecoveryCancellation(options?.signal);
      const engine = await resolveWakaruCommand(this.environment);
      root = await mkdtemp(join(tmpdir(), "rea-wakaru-"));
      const inputs = join(root, "inputs");
      const staging = join(root, "modules");
      await mkdir(inputs, { mode: 0o700 });
      await mkdir(staging, { mode: 0o700 });
      const source = await snapshotRecoveryInput(
        input.path,
        join(inputs, "bundle.js"),
        options?.signal,
      );
      tree = await SafeOutputTree.create(input.output_directory).catch(
        (cause: unknown) => {
          throw recoveryInputFailure(
            "output_directory",
            `Cannot create new recovery directory ${input.output_directory}: ${recoveryFailureMessage(cause)}`,
            cause,
          );
        },
      );
      execution = await prepareWakaruExecution({
        root,
        tree,
        input,
        source,
        engine,
        environment: this.environment,
        launcher: this.launcher,
        options,
        deadline,
      });
      checkRecoveryDeadline(deadline, options?.signal);
      await rm(root, { recursive: true, force: true });
      root = undefined;
      checkRecoveryDeadline(deadline, options?.signal);
      await tree.commit();
    } catch (cause: unknown) {
      failure = cause;
    }
    if (failure !== undefined) {
      const residuals: string[] = [];
      const cleanupOwner =
        failure instanceof WakaruCleanupFailure
          ? failure.cleanupOwner
          : undefined;
      let failedTree: SafeOutputTree | undefined;
      try {
        await tree?.rollback();
      } catch {
        if (tree !== undefined) {
          failedTree = tree;
          residuals.push(tree.outputRoot);
        }
      }
      if (cleanupOwner !== undefined)
        residuals.push(cleanupOwner.launch.ownership?.runId ?? "wakaru-worker");
      if (root !== undefined && cleanupOwner === undefined) {
        const failedRoot = root;
        try {
          await rm(failedRoot, { recursive: true, force: true });
          root = undefined;
        } catch {
          residuals.push(failedRoot);
        }
      }
      if (
        cleanupOwner !== undefined ||
        failedTree !== undefined ||
        root !== undefined
      ) {
        this.#pendingCleanup = {
          root,
          process: cleanupOwner,
          tree: failedTree,
        };
        if (root !== undefined) residuals.push(root);
        root = undefined;
      }
      if (residuals.length > 0)
        return err(
          new ProviderCleanupError("wakaru", residuals, {
            previous_error: recoveryFailureMessage(failure),
          }),
        );
      return err(
        failure instanceof AnalysisError
          ? failure
          : new ProviderAdapterError("wakaru", OPERATION, {
              cause: failure,
              diagnostics: { reason: recoveryFailureMessage(failure) },
            }),
      );
    }
    return execution === undefined
      ? err(
          new AnalysisOutputError(OPERATION, "Recovery returned no execution"),
        )
      : ok(execution);
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#tail
      .then(async () => {
        const failure = await this.#retire();
        if (failure !== undefined) throw failure;
      })
      .catch((cause: unknown) => {
        this.#closePromise = undefined;
        throw cause;
      });
    return this.#closePromise;
  }

  async #retire(): Promise<ProviderCleanupError | undefined> {
    const pending = this.#pendingCleanup;
    if (pending === undefined) return undefined;
    if (pending.process !== undefined) {
      const stopped = await pending.process.stop();
      if (stopped.status === "incomplete")
        return new ProviderCleanupError(
          "wakaru",
          [
            pending.process.launch.ownership?.runId ?? "wakaru-worker",
            ...(pending.root === undefined ? [] : [pending.root]),
          ],
          { reason: stopped.reason },
          { operation: OPERATION },
        );
      pending.process = undefined;
    }
    if (pending.tree !== undefined) {
      const tree = pending.tree;
      try {
        await tree.rollback();
        pending.tree = undefined;
      } catch (cause: unknown) {
        return new ProviderCleanupError(
          "wakaru",
          [tree.outputRoot],
          { reason: recoveryFailureMessage(cause) },
          { operation: OPERATION, cause },
        );
      }
    }
    if (pending.root !== undefined) {
      const root = pending.root;
      try {
        await rm(root, { recursive: true, force: true });
        pending.root = undefined;
      } catch (cause: unknown) {
        return new ProviderCleanupError(
          "wakaru",
          [root],
          { reason: recoveryFailureMessage(cause) },
          { operation: OPERATION, cause },
        );
      }
    }
    this.#pendingCleanup = undefined;
    return undefined;
  }
}
