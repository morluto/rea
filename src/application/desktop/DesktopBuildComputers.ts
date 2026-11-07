import { randomUUID } from "node:crypto";

import {
  extraPackagesOf,
  type BuildSource,
} from "../../domain/desktop/appBuild.js";
import { counted } from "../../domain/desktop/appExportUnowned.js";
import { SETTLE_TIMING } from "../../domain/desktop/appSettle.js";
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
import {
  resolveBuildComputerEnvironment,
  type BuildComputerDefaults,
} from "../../desktop/BuildComputerEnvironment.js";
import { buildSecretsDirectory } from "../../desktop/BuildSecretFiles.js";
import type { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import type { ProgressReporter } from "../ProgressReporter.js";
import {
  BuildComputerActionLog,
  type ReadonlyActionLog,
} from "./DesktopBuildActionLog.js";
import { seededLockFiles, writeRequestBundle } from "./DesktopBuildBundle.js";
import { DesktopBuildCapture } from "./DesktopBuildCapture.js";
import {
  DesktopBuildSecrets,
  settingsEnvironment,
  typeSecret,
} from "./DesktopBuildSecrets.js";
import type { BuildSettle } from "./DesktopBuildSettle.js";
import { DesktopBuildTurns } from "./DesktopBuildTurns.js";
import { DesktopBuildWitness } from "./DesktopBuildWitness.js";

const START = "start_build_computer";
const ACT = "act_on_build_computer";
const CLOSE = "close_build_computer";

/** A result with the driver's content blocks, delivered after REA's own. */
export interface ForwardedResult<Value> {
  readonly value: Value;
  readonly content: DriverResult["content"];
}

/** What an action answers: its place in the log and the driver's structured result. */
type Acted = ForwardedResult<{
  readonly computer_id: string;
  readonly action: ComputerAction;
  readonly action_index: number;
  readonly result: Readonly<Record<string, JsonValue>> | null;
}>;

/** What later stages read of a live build computer: its action log and recording hooks. */
export interface BuildComputerSession {
  readonly sandboxId: string;
  readonly actions: ReadonlyActionLog;
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
  readonly actions: BuildComputerActionLog;
  /** REA's capture of the app and the task's witness, on a live computer. */
  readonly steps: BuildComputerSteps | undefined;
  /** Every action, step and close on the computer takes its turn here. */
  readonly turns: DesktopBuildTurns;
  closing: boolean;
}

/** What the build step tools work on: a live computer, its capture, its witness and the turns they take. */
export interface BuildComputerSteps {
  readonly computer: AgentEnvComputer;
  readonly capture: DesktopBuildCapture;
  readonly witness: DesktopBuildWitness;
  readonly turns: DesktopBuildTurns;
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

/** The text of a driver's answer, such as a refusal's message. */
const driverMessage = (content: DriverResult["content"]): string =>
  content
    .flatMap((block) => (typeof block.text === "string" ? [block.text] : []))
    .join(" ");

/**
 * Restore the app's data to its seed with `data/reset`, which relaunches the
 * app, and wait until the computer reports ready again; a screenshot after,
 * when asked.
 */
const reset = async (
  computer: AgentEnvComputer,
  fields: Readonly<Record<string, JsonValue>>,
  signal: AbortSignal,
): Promise<DriverResult> => {
  const startedAt = Date.now();
  await computer.appData("data/reset", signal);
  await computer.waitUntilReady(signal);
  const ready = { reset: true, ready_ms: Date.now() - startedAt };
  if (fields.screenshot !== true)
    return { isError: false, content: [], structured: ready };
  // The reset has happened: a screenshot that fails after it is reported beside it, and only an abort propagates.
  const shot = await computer
    .callTool("computer_screenshot", {}, signal)
    .catch((cause: unknown) => {
      if (signal.aborted) throw cause;
      return cause instanceof Error ? cause.message : String(cause);
    });
  if (typeof shot === "string" || shot.isError)
    return {
      isError: false,
      content: [],
      structured: {
        ...ready,
        screenshot_error:
          typeof shot === "string" ? shot : driverMessage(shot.content),
      },
    };
  return {
    isError: false,
    content: shot.content,
    structured: { ...ready, frame: shot.structured },
  };
};

/** What every computer of one server shares: how checks settle and the secrets typed on them. */
interface SharedSettings {
  readonly settle: BuildSettle;
  readonly secrets: DesktopBuildSecrets;
}

/** A live computer as REA holds it: its action log, its capture and witness, and the turns all its calls take. */
const liveComputer = (
  computer: AgentEnvComputer,
  workspace: PrivateRuntimeRoot | undefined,
  source: BuildSource,
  { settle, secrets }: SharedSettings,
): HeldComputer => {
  const actions = new BuildComputerActionLog(secrets.redact);
  const turns = new DesktopBuildTurns();
  return {
    computer,
    release: () => computer.close(),
    workspace,
    actions,
    steps: {
      computer,
      capture: new DesktopBuildCapture(
        computer,
        source.kind === "request" ? source : undefined,
        {
          all: () => secrets.all(),
          keep: (handle, bytes) => secrets.keep(handle, bytes),
        },
      ),
      witness: new DesktopBuildWitness(computer, actions, settle, {
        bundle: source.kind === "bundle" ? source.path : undefined,
        redact: secrets.redactJson,
      }),
      turns,
    },
    turns,
    closing: false,
  };
};

/** How agentenv and REA say a computer's readiness checks never passed. */
const NOT_READY = /\bnot ready\b|wasn't ready|didn't boot/u;

/**
 * A bundle's start that failed on readiness, naming the lock files its seed
 * holds, which an app that finds its profile or document in use may never
 * start past; any other failure as it is.
 */
const withSeededLocks = async (
  source: BuildSource,
  cause: unknown,
): Promise<unknown> => {
  if (
    source.kind !== "bundle" ||
    !(cause instanceof ComputerStartFailure) ||
    !NOT_READY.test(cause.message)
  )
    return cause;
  const locks = await seededLockFiles(source.path);
  return locks.length === 0
    ? cause
    : new ComputerStartFailure(
        `${cause.message} The bundle's seed holds lock files, which can keep the app from starting when it finds its profile or document in use: ${counted(locks)}. Delete them from the bundle, or export it again, which leaves them out, and start again.`,
        cause.remediation,
        cause.cause === undefined ? undefined : { cause: cause.cause },
      );
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
  readonly #secrets: DesktopBuildSecrets;
  readonly #shared: SharedSettings;
  #closed = false;

  constructor(
    private readonly environment: Readonly<NodeJS.ProcessEnv>,
    settle: BuildSettle = SETTLE_TIMING,
    private readonly defaults: BuildComputerDefaults = {},
  ) {
    this.#secrets = new DesktopBuildSecrets(buildSecretsDirectory(environment));
    this.#shared = { settle, secrets: this.#secrets };
  }

  /** How results show the secrets typed on this server's computers, and credentials by their shape. */
  get redaction(): Pick<DesktopBuildSecrets, "redact" | "redactJson"> {
    return this.#secrets;
  }

  async start(
    input: {
      readonly source: BuildSource;
      readonly screenshot?: ScreenshotOptions | undefined;
    },
    signal: AbortSignal,
    progress?: ProgressReporter,
  ): Promise<
    Result<
      ForwardedResult<{
        readonly computer_id: string;
        readonly sandbox_id: string;
        readonly environment: string;
        readonly extra_packages: string[];
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
    const settled = this.#start(
      input,
      AbortSignal.any([signal, stop.signal]),
      progress,
    );
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
    progress: ProgressReporter | undefined,
  ): ReturnType<DesktopBuildComputers["start"]> {
    const { source } = input;
    const resolved = await this.#environment(source);
    if (!resolved.ok) return resolved;
    const environment = resolved.value;
    let target: {
      readonly bundle: string;
      readonly name: string;
      readonly workspace?: PrivateRuntimeRoot;
    };
    try {
      target =
        source.kind === "bundle"
          ? { bundle: source.path, name: source.path }
          : await writeRequestBundle(source, environment);
    } catch (cause: unknown) {
      return err(failure(START, cause, signal));
    }
    const id = randomUUID();
    let helper: ComputerHelper | undefined;
    let computer: AgentEnvComputer | undefined;
    try {
      helper = await ComputerHelper.spawn({
        bundle: target.bundle,
        environment,
        signal,
        operation: START,
      });
      const connected = await AgentEnvComputer.connect(
        helper,
        signal,
        progress === undefined
          ? undefined
          : (message) => {
              void progress
                .report({ phase: START, completed: 0, total: null, message })
                .catch(() => undefined);
            },
      );
      computer = connected.computer;
      const shot = driverCall("screenshot", input.screenshot ?? {});
      if (!shot.ok) throw new TypeError("screenshot options are its own");
      // The caller's region, format or quality apply to the drawn frame.
      const taken =
        Object.keys(shot.value.arguments).length === 0
          ? connected.frame
          : await computer.callTool(
              shot.value.tool,
              shot.value.arguments,
              signal,
            );
      this.#computers.set(
        id,
        liveComputer(computer, target.workspace, source, this.#shared),
      );
      return ok({
        value: {
          computer_id: id,
          sandbox_id: computer.sandboxId,
          environment: target.name,
          extra_packages: [...extraPackagesOf(source)],
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
        actions: new BuildComputerActionLog(this.#secrets.redact),
        steps: undefined,
        turns: new DesktopBuildTurns(),
        closing: true,
      });
      const release = await this.#retire(id);
      const failed = signal.aborted
        ? cause
        : await withSeededLocks(source, cause);
      return err(
        startFailure(failed, signal, owner?.output(), { id, release }),
      );
    }
  }

  /** Forward one action to the computer's driver and log it; a driver refusal is an error carrying its message. */
  async act(
    input: ComputerActionInput,
    signal: AbortSignal,
  ): Promise<Result<Acted, AnalysisError>> {
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
            userMessage:
              call.error.missing === true
                ? `${action} needs ${call.error.field}.`
                : `${action} does not take ${call.error.field}; it takes ${call.error.accepted.join(", ")}.`,
          },
          [
            {
              path: [call.error.field],
              reason:
                call.error.missing === true
                  ? "missing_argument"
                  : "unknown_argument",
              expected: [...call.error.accepted],
            },
          ],
        ),
      );
    return held.turns.run(ACT, signal, (turn) =>
      this.#forward(held, computer, { id, action, ...call.value }, turn),
    );
  }

  /** Log and send one action on its turn, so the log holds no action still pending while another call runs. */
  async #forward(
    held: HeldComputer,
    computer: AgentEnvComputer,
    call: {
      readonly id: string;
      readonly action: ComputerAction;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, JsonValue>>;
    },
    signal: AbortSignal,
  ): Promise<Result<Acted, AnalysisError>> {
    const { id, action } = call;
    // A secret is logged by its handle; only the computer receives its value.
    const logged = held.actions.begin(action, call.tool, call.arguments);
    if (action === "type_secret") {
      const handle = String(call.arguments.secret);
      const typed = await typeSecret(this.#secrets, computer, handle, signal);
      logged.settle(typed.outcome);
      return typed.answer(id, logged.index);
    }
    let result: DriverResult;
    try {
      result =
        action === "reset"
          ? await reset(computer, call.arguments, signal)
          : await computer.callTool(call.tool, call.arguments, signal);
    } catch (cause: unknown) {
      logged.settle("failed");
      return err(failure(ACT, cause, signal));
    }
    logged.settle(result.isError ? "refused" : "applied");
    if (result.isError)
      return err(
        new AnalysisInputError(ACT, {
          userMessage: `The computer refused the ${action}: ${driverMessage(result.content)}`,
          remediationAction:
            "Follow the computer's message; actions on frame coordinates need a screenshot first.",
          conformsToInputContract: true,
        }),
      );
    return ok({
      value: {
        computer_id: id,
        action,
        action_index: logged.index,
        result: result.structured,
      },
      content: result.content,
    });
  }

  /** The helper's environment: the build settings, then each variable a bundle's withheld settings read, from its secret. */
  async #environment(
    source: BuildSource,
  ): Promise<Result<Readonly<NodeJS.ProcessEnv>, AnalysisError>> {
    const settings = await settingsEnvironment(this.#secrets, source);
    if (!settings.ok) return settings;
    const environment = await resolveBuildComputerEnvironment(
      this.environment,
      process.platform,
      this.defaults,
    );
    return ok({ ...environment, ...settings.value });
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
    const held = this.#computers.get(id);
    if (held === undefined) return err(unknownComputer(CLOSE));
    held.closing = true;
    // Tear down only once the call it cancels has ended; the calls waiting are refused.
    const release = await held.turns.close(() => this.#retire(id));
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

  /** A live computer's capture and witness, for the build step tools; undefined for an unknown or closing id. */
  steps(id: string): BuildComputerSteps | undefined {
    const held = this.#computers.get(id);
    return held === undefined || held.closing ? undefined : held.steps;
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
