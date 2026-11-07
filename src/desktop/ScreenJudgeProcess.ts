import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { ScreenJudge } from "../domain/desktop/appTaskScreen.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import {
  AGENTENV_PROVIDER,
  agentEnvInterpreter,
  type ComputerRelease,
} from "./AgentEnvComputerHelper.js";

const JUDGE_TIMEOUT_MS = 10 * 60 * 1000;
const answerSchema = z.object({
  id: z.string(),
  result: z.boolean(),
  description: z.string(),
});

interface Retained {
  readonly folder: string;
  readonly resources: readonly string[];
  readonly stop: () => Promise<void>;
  readonly failure: ProviderCleanupError;
}

/** A complete answer remains evidence even when subsequent process cleanup fails. */
const completedAnswer = (
  cause: unknown,
): Awaited<ReturnType<ScreenJudge>> | undefined => {
  if (
    !(cause instanceof OwnedCommandFailure) ||
    cause.collectionFailure ||
    cause.snapshot?.exitCode !== 0 ||
    cause.snapshot.outputIncomplete === true
  )
    return undefined;
  const stdout = cause.snapshot.stdout;
  if (stdout.invalidUtf8 || stdout.bytes !== stdout.observedBytes)
    return undefined;
  try {
    const answer = answerSchema.safeParse(
      JSON.parse(stdout.text.trim().split("\n").at(-1) ?? ""),
    );
    return answer.success
      ? {
          id: answer.data.id,
          passed: answer.data.result,
          description: answer.data.description,
        }
      : undefined;
  } catch {
    return undefined;
  }
};

/** Own the judge, its descendants and the screenshot until cleanup is confirmed. */
export class ScreenJudgeProcess {
  readonly #retained = new Set<Retained>();

  constructor(readonly environment: Readonly<NodeJS.ProcessEnv>) {}

  readonly judge: ScreenJudge = async (verifier, check, image, signal) => {
    const cleanup = await this.close();
    if (!cleanup.verified) {
      const pending = [...this.#retained].map((item) => item.failure);
      if (pending.length === 1) throw pending[0];
      throw new ProviderCleanupError(
        AGENTENV_PROVIDER,
        cleanup.resources,
        { reason: cleanup.reason },
        {
          operation: "check_build_task",
          remediationAction: "Close the build computer to retry judge cleanup.",
        },
      ).bindCleanupDependencies(pending);
    }
    if (signal.aborted)
      throw new AnalysisCancelledError("check_build_task", {
        cause: signal.reason,
      });
    const python = await agentEnvInterpreter(
      this.environment,
      "check_build_task",
    );
    const folder = await mkdtemp(join(tmpdir(), "rea-screen-judge-"));
    let retained = false;
    let primary: { readonly cause: unknown } | undefined;
    let outcome: Awaited<ReturnType<ScreenJudge>> | undefined;
    try {
      const screen = join(folder, "screen.jpg");
      await writeFile(screen, image);
      const snapshot = await runOwnedCommand(
        {
          command: python,
          arguments: [verifier, "judge", JSON.stringify(check), screen],
          runId: randomUUID(),
          expectedCommand: null,
          hostEnvironment: { ...this.environment },
          env: { PYTHONDONTWRITEBYTECODE: "1" },
          sweepTokenOwnedProcesses: true,
        },
        { timeoutMs: JUDGE_TIMEOUT_MS, diagnosticBytes: 1024 * 1024 },
        { signal },
      );
      const answer = answerSchema.parse(
        JSON.parse(snapshot.stdout.text.trim().split("\n").at(-1) ?? ""),
      );
      outcome = {
        id: answer.id,
        passed: answer.result,
        description: answer.description,
      };
    } catch (cause: unknown) {
      primary = { cause };
      const cleanup = this.#retainProcessFailure(folder, cause);
      if (cleanup !== undefined) {
        retained = true;
        primary = { cause: cleanup };
      } else if (cause instanceof OwnedCommandFailure) {
        primary = {
          cause:
            cause.reason === "cancelled"
              ? new AnalysisCancelledError("check_build_task", {
                  cause: cause.cancellation?.reason,
                })
              : new ProviderAdapterError(
                  AGENTENV_PROVIDER,
                  "check_build_task",
                  {
                    cause,
                    userMessage: `The bundle's screen judge failed: ${cause.snapshot?.stderr.text.trim().split("\n").slice(-3).join(" ") || cause.message}`,
                  },
                ),
        };
        const completed = completedAnswer(cause);
        if (completed !== undefined && primary.cause instanceof AnalysisError)
          primary.cause.retainDiagnostics({
            completed_judge_result: completed,
          });
      }
    }
    if (!retained) await this.#removeScreen(folder, outcome, primary?.cause);
    if (primary !== undefined) throw primary.cause;
    if (outcome === undefined) throw new Error("Judge produced no outcome.");
    return outcome;
  };

  async #removeScreen(
    folder: string,
    outcome: Awaited<ReturnType<ScreenJudge>> | undefined,
    primary: unknown,
  ): Promise<void> {
    try {
      await rm(folder, { recursive: true, force: true });
    } catch (cause: unknown) {
      const failure = new ProviderCleanupError(
        AGENTENV_PROVIDER,
        [folder],
        {
          reason: cause instanceof Error ? cause.message : String(cause),
          ...(outcome === undefined ? {} : { completed_judge_result: outcome }),
        },
        {
          operation: "check_build_task",
          cause: primary ?? cause,
          ...(primary instanceof AnalysisError
            ? { cleanupPrimary: primary }
            : {}),
          remediationAction:
            "Close the build computer to retry screenshot cleanup.",
        },
      );
      this.#retained.add({
        folder,
        resources: [],
        failure,
        stop: async () => {},
      });
      throw failure;
    }
  }

  #retainProcessFailure(
    folder: string,
    cause: unknown,
  ): ProviderCleanupError | undefined {
    const owner =
      cause instanceof OwnedCommandFailure ? cause.cleanupOwner : undefined;
    const preparation =
      cause instanceof OwnedCommandFailure
        ? cause.preparationFailure
        : cause instanceof DarwinProcessOwnershipInspectionError
          ? cause
          : undefined;
    if (owner === undefined && preparation?.cleanupOwner === undefined)
      return undefined;
    let processStopped = owner === undefined;
    let preparationClosed = preparation?.cleanupOwner === undefined;
    const completed = completedAnswer(cause);
    const original =
      cause instanceof OwnedCommandFailure && cause.reason === "cancelled"
        ? new AnalysisCancelledError("check_build_task", {
            cause: cause.cancellation?.reason,
          })
        : new ProviderAdapterError(AGENTENV_PROVIDER, "check_build_task", {
            cause,
          });
    const processResources =
      cause instanceof OwnedCommandFailure ? cause.resources : [];
    const message = cause instanceof Error ? cause.message : String(cause);
    const failure = new ProviderCleanupError(
      AGENTENV_PROVIDER,
      [...processResources, folder],
      {
        reason:
          (cause instanceof OwnedCommandFailure
            ? cause.cleanupFailure
            : null) ?? message,
        primary_failure: message,
        ...(completed === undefined
          ? {}
          : { completed_judge_result: completed }),
      },
      {
        operation: "check_build_task",
        cause,
        ...(completed === undefined ? { cleanupPrimary: original } : {}),
        remediationAction: "Close the build computer to retry judge cleanup.",
      },
    );
    this.#retained.add({
      folder,
      resources: processResources,
      failure,
      stop: async () => {
        if (!processStopped && owner !== undefined) {
          const result = await owner.stop();
          if (result.status === "incomplete") throw new Error(result.reason);
          owner.dispose();
          processStopped = true;
        }
        if (!preparationClosed) {
          await preparation?.cleanupOwner?.close();
          preparationClosed = true;
        }
      },
    });
    return failure;
  }

  /** Retry unconfirmed process and screenshot cleanup before releasing the computer. */
  async close(): Promise<ComputerRelease> {
    const failures: string[] = [];
    const resources: string[] = [];
    for (const item of this.#retained) {
      try {
        await item.stop();
        await rm(item.folder, { recursive: true, force: true });
        this.#retained.delete(item);
        item.failure.resolveCleanup();
      } catch (cause: unknown) {
        failures.push(cause instanceof Error ? cause.message : String(cause));
        resources.push(...item.resources, item.folder);
      }
    }
    return failures.length === 0
      ? { verified: true, teardown: "agentenv" }
      : { verified: false, reason: failures.join("; "), resources };
  }
}
