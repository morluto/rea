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
import type { JavaScriptRecoveryInput } from "../../domain/javascriptRecovery.js";
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
import { resolveWakaruCommand, type WakaruLauncher } from "./WakaruCommand.js";
import { prepareWakaruExecution } from "./WakaruExecution.js";
import { RECOVERY_LIMITS } from "./WakaruRelease.js";

const OPERATION = "recover_javascript_sources";

/** Stateless adapter; each recovery owns its snapshot, process and publication. */
export class WakaruProvider implements JavaScriptRecoveryPort {
  constructor(
    readonly environment: Readonly<
      Record<string, string | undefined>
    > = process.env,
    readonly launcher?: WakaruLauncher,
  ) {}

  /** Recover one script using validated upstream reports and verified output bytes. */
  async recover(
    input: JavaScriptRecoveryInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
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
      try {
        await tree?.rollback();
      } catch {
        if (tree !== undefined) residuals.push(tree.outputRoot);
      }
      if (
        root !== undefined &&
        !(failure instanceof AnalysisError && failure.cleanupIncomplete)
      ) {
        try {
          await rm(root, { recursive: true, force: true });
        } catch {
          residuals.push(root);
        }
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
}
