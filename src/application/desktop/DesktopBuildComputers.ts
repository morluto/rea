import { randomUUID } from "node:crypto";

import type { BuildSource } from "../../domain/desktop/appBuild.js";
import {
  driverCall,
  type ComputerAction,
  type ComputerActionInput,
  type ScreenshotOptions,
} from "../../domain/desktop/computerActions.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
} from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  AgentEnvComputer,
  ComputerStartFailure,
  type DriverResult,
} from "../../desktop/AgentEnvComputer.js";
import {
  AGENTENV_PROVIDER,
  ComputerHelper,
  type ComputerRelease,
} from "../../desktop/AgentEnvComputerHelper.js";
import type { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import { writeRequestBundle } from "./DesktopBuildBundle.js";

const START = "start_build_computer";
const ACT = "act_on_build_computer";
const CLOSE = "close_build_computer";

/** A result with the driver's content blocks, delivered after REA's own. */
export interface ForwardedResult<Value> {
  readonly value: Value;
  readonly content: DriverResult["content"];
}

/** One forwarded action, in the order REA sent it, as the witness reads it. */
export interface BuildComputerAction {
  readonly index: number;
  readonly action: ComputerAction;
  readonly tool: string;
  /** The driver's arguments as sent, keys translated. */
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly outcome: "pending" | "applied" | "refused" | "failed";
}

/** What later stages read of a live build computer: its action log and recording hooks. */
export interface BuildComputerSession {
  readonly sandboxId: string;
  readonly actions: readonly BuildComputerAction[];
  readonly startRecording: AgentEnvComputer["startRecording"];
  readonly endRecording: AgentEnvComputer["endRecording"];
  readonly recordingSegments: AgentEnvComputer["recordingSegments"];
}

/** A computer REA owns: a live one, or a failed start whose cleanup is still unconfirmed. */
interface HeldComputer {
  readonly computer: AgentEnvComputer | undefined;
  /** Brings the computer down; absent when no helper was spawned. */
  readonly release: (() => Promise<ComputerRelease>) | undefined;
  readonly workspace: PrivateRuntimeRoot | undefined;
  readonly actions: BuildComputerAction[];
  closing: boolean;
}

/** A start still in progress, which shutdown cancels and joins. */
interface PendingStart {
  readonly settled: Promise<unknown>;
  readonly stop: AbortController;
}

const unknownComputer = (operation: string) =>
  new AnalysisInputError(operation, {
    userMessage:
      "No build computer has this id in this REA server; start one with start_build_computer.",
    conformsToInputContract: true,
  });

const failure = (
  operation: string,
  cause: unknown,
  signal: AbortSignal,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (signal.aborted)
    return new AnalysisCancelledError(operation, { cause: signal.reason });
  return new ProviderAdapterError(AGENTENV_PROVIDER, operation, {
    userMessage: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
};

/**
 * Why a start failed, with the helper's output, and, when its teardown is
 * unconfirmed, the id REA keeps that teardown under for close to retry.
 */
const startFailure = (
  cause: unknown,
  signal: AbortSignal,
  output: AnalysisCapturedOutput | undefined,
  kept: { readonly id: string; readonly release: ComputerRelease },
): AnalysisError => {
  if (cause instanceof AnalysisError && kept.release.verified) return cause;
  const options = {
    cause,
    ...(output === undefined ? {} : { capturedOutput: output }),
    ...(kept.release.verified
      ? {}
      : {
          cleanup: {
            reason: kept.release.reason,
            resources: kept.release.resources,
          },
          diagnostics: { computer_id: kept.id },
          remediationAction: `REA keeps this computer's teardown as ${kept.id}; once the reported problem is fixed, call close_build_computer with that computer_id.`,
        }),
  };
  if (signal.aborted)
    return new AnalysisCancelledError(START, {
      ...options,
      cause: signal.reason,
    });
  return new ProviderAdapterError(AGENTENV_PROVIDER, START, {
    ...(cause instanceof ComputerStartFailure &&
    cause.remediation !== undefined &&
    kept.release.verified
      ? { remediationAction: cause.remediation }
      : {}),
    userMessage: cause instanceof Error ? cause.message : String(cause),
    ...options,
  });
};

/**
 * Owns the build computers one REA server keeps up: starts each from a
 * request or a bundle, forwards actions to its driver with an action log,
 * and brings each down on close or when the server closes. A start in
 * progress is owned from its helper's spawn; one that fails without a
 * confirmed teardown stays held so close and shutdown can retry it.
 */
export class DesktopBuildComputers {
  readonly #computers = new Map<string, HeldComputer>();
  readonly #starts = new Set<PendingStart>();
  #closed = false;

  constructor(private readonly environment: Readonly<NodeJS.ProcessEnv>) {}

  async start(
    input: {
      readonly source: BuildSource;
      readonly screenshot?: ScreenshotOptions | undefined;
    },
    signal: AbortSignal,
  ): Promise<
    Result<
      ForwardedResult<{
        readonly computer_id: string;
        readonly sandbox_id: string;
        readonly environment: string;
        readonly screenshot: Readonly<Record<string, JsonValue>> | null;
      }>,
      AnalysisError
    >
  > {
    if (this.#closed)
      return err(
        new AnalysisCancelledError(START, {
          cause: new Error("REA is closing its build computers"),
        }),
      );
    const stop = new AbortController();
    const settled = this.#start(input, AbortSignal.any([signal, stop.signal]));
    const pending = { settled, stop };
    this.#starts.add(pending);
    try {
      return await settled;
    } finally {
      this.#starts.delete(pending);
    }
  }

  async #start(
    input: Parameters<DesktopBuildComputers["start"]>[0],
    signal: AbortSignal,
  ): ReturnType<DesktopBuildComputers["start"]> {
    const { source } = input;
    let target: {
      readonly bundle: string;
      readonly name: string;
      readonly workspace?: PrivateRuntimeRoot;
    };
    try {
      target =
        source.kind === "bundle"
          ? { bundle: source.path, name: source.path }
          : await writeRequestBundle(source, this.environment);
    } catch (cause: unknown) {
      return err(failure(START, cause, signal));
    }
    const id = randomUUID();
    let helper: ComputerHelper | undefined;
    let computer: AgentEnvComputer | undefined;
    try {
      helper = await ComputerHelper.spawn({
        bundle: target.bundle,
        environment: this.environment,
        signal,
        operation: START,
      });
      computer = await AgentEnvComputer.connect(helper, signal);
      const shot = driverCall("screenshot", input.screenshot ?? {});
      if (!shot.ok) throw new TypeError("screenshot options are its own");
      const taken = await computer.callTool(
        shot.value.tool,
        shot.value.arguments,
        signal,
      );
      const live = computer;
      this.#computers.set(id, {
        computer: live,
        release: () => live.close(),
        workspace: target.workspace,
        actions: [],
        closing: false,
      });
      return ok({
        value: {
          computer_id: id,
          sandbox_id: live.sandboxId,
          environment: target.name,
          screenshot: taken.isError ? null : taken.structured,
        },
        content: taken.content,
      });
    } catch (cause: unknown) {
      const owner = helper;
      const connected = computer;
      this.#computers.set(id, {
        computer: undefined,
        release:
          connected !== undefined
            ? () => connected.close()
            : owner === undefined
              ? undefined
              : () => owner.release(),
        workspace: target.workspace,
        actions: [],
        closing: true,
      });
      const release = await this.#retire(id);
      return err(startFailure(cause, signal, owner?.output(), { id, release }));
    }
  }

  /** Forward one action to the computer's driver and log it; a driver refusal is an error carrying its message. */
  async act(
    input: ComputerActionInput,
    signal: AbortSignal,
  ): Promise<
    Result<
      ForwardedResult<{
        readonly computer_id: string;
        readonly action: ComputerAction;
        readonly action_index: number;
        readonly result: Readonly<Record<string, JsonValue>> | null;
      }>,
      AnalysisError
    >
  > {
    const { computer_id: id, action, ...fields } = input;
    const held = this.#computers.get(id);
    const computer = held?.computer;
    if (held === undefined || computer === undefined || held.closing)
      return err(unknownComputer(ACT));
    const call = driverCall(action, fields);
    if (!call.ok)
      return err(
        new AnalysisInputError(
          ACT,
          {
            userMessage: `${action} does not take ${call.error.field}; it takes ${call.error.accepted.join(", ")}.`,
          },
          [
            {
              path: [call.error.field],
              reason: "unknown_argument",
              expected: [...call.error.accepted],
            },
          ],
        ),
      );
    const index = held.actions.length;
    const entry: BuildComputerAction = {
      index,
      action,
      tool: call.value.tool,
      arguments: call.value.arguments,
      started_at: new Date().toISOString(),
      ended_at: null,
      outcome: "pending",
    };
    held.actions.push(entry);
    const settle = (outcome: BuildComputerAction["outcome"]) => {
      held.actions[index] = {
        ...entry,
        outcome,
        ended_at: new Date().toISOString(),
      };
    };
    let result: DriverResult;
    try {
      result = await computer.callTool(
        call.value.tool,
        call.value.arguments,
        signal,
      );
    } catch (cause: unknown) {
      settle("failed");
      return err(failure(ACT, cause, signal));
    }
    settle(result.isError ? "refused" : "applied");
    if (result.isError)
      return err(
        new AnalysisInputError(ACT, {
          userMessage: `The computer refused the ${action}: ${result.content
            .flatMap((block) =>
              typeof block.text === "string" ? [block.text] : [],
            )
            .join(" ")}`,
          remediationAction:
            "Follow the computer's message; actions on frame coordinates need a screenshot first.",
          conformsToInputContract: true,
        }),
      );
    return ok({
      value: {
        computer_id: id,
        action,
        action_index: index,
        result: result.structured,
      },
      content: result.content,
    });
  }

  /** Bring a computer down; one whose teardown is not confirmed stays held so close can be retried. */
  async close(id: string): Promise<
    Result<
      {
        readonly computer_id: string;
        readonly teardown: "agentenv" | "container_label";
      },
      AnalysisError
    >
  > {
    if (!this.#computers.has(id)) return err(unknownComputer(CLOSE));
    const release = await this.#retire(id);
    return release.verified
      ? ok({ computer_id: id, teardown: release.teardown })
      : err(
          new ProviderCleanupError(
            AGENTENV_PROVIDER,
            release.resources,
            { reason: release.reason },
            { operation: CLOSE, remediationAction: release.reason },
          ),
        );
  }

  /** Release a held computer and its bundle folder; it stays held while either is unconfirmed. */
  async #retire(id: string): Promise<ComputerRelease> {
    const held = this.#computers.get(id);
    if (held === undefined) return { verified: true, teardown: "agentenv" };
    held.closing = true;
    const release = (await held.release?.()) ?? {
      verified: true,
      teardown: "agentenv",
    };
    if (!release.verified) return release;
    try {
      await held.workspace?.close();
    } catch (cause: unknown) {
      return {
        verified: false,
        reason: `the build bundle folder could not be removed: ${cause instanceof Error ? cause.message : String(cause)}`,
        resources: [held.workspace?.path ?? id],
      };
    }
    this.#computers.delete(id);
    return release;
  }

  /** Cancel and join the starts in progress, then bring every held computer down, as the server closes. */
  async closeAll(): Promise<void> {
    this.#closed = true;
    const starts = [...this.#starts];
    for (const start of starts)
      start.stop.abort(new Error("REA is closing its build computers"));
    await Promise.allSettled(starts.map((start) => start.settled));
    const results = await Promise.all(
      [...this.#computers.keys()].map((id) => this.close(id)),
    );
    const failures = results.flatMap((result) =>
      result.ok ? [] : [result.error],
    );
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Build computer teardown is incomplete",
      );
  }

  /** A live computer's action log and recording hooks, for the witness. */
  session(id: string): BuildComputerSession | undefined {
    const held = this.#computers.get(id);
    const computer = held?.computer;
    if (held === undefined || computer === undefined) return undefined;
    return {
      sandboxId: computer.sandboxId,
      actions: held.actions,
      startRecording: (...request) => computer.startRecording(...request),
      endRecording: (...request) => computer.endRecording(...request),
      recordingSegments: (...request) => computer.recordingSegments(...request),
    };
  }
}
