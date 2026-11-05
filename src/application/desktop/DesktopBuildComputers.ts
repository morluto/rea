import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import {
  renderBuildBundle,
  type BuildRequest,
  type BuildSource,
  type ReaPayload,
} from "../../domain/desktop/appBuild.js";
import {
  driverCall,
  type ComputerAction,
  type ComputerActionInput,
} from "../../domain/desktop/computerActions.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  AgentEnvComputer,
  type DriverResult,
} from "../../desktop/AgentEnvComputer.js";
import { AGENTENV_PROVIDER } from "../../desktop/AgentEnvComputerHelper.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";

const START = "start_build_computer";
const ACT = "act_on_build_computer";
const CLOSE = "close_build_computer";
const MAX_KEY_BYTES = 1024 * 1024;

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

interface HeldComputer {
  readonly computer: AgentEnvComputer;
  readonly workspace: PrivateRuntimeRoot | undefined;
  readonly actions: BuildComputerAction[];
  closing: boolean;
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

/** The archive the build layer unpacks REA from, as the operator configured it. */
const reaPayload = async (
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<ReaPayload> => {
  const path = environment.REA_BUILD_COMPUTER_REA_ARCHIVE;
  const reason =
    "A build computer from a request needs REA_BUILD_COMPUTER_REA_ARCHIVE, the absolute path of a tar archive of a runnable REA whose one top folder holds scripts/rea.mjs.";
  if (
    path === undefined ||
    !isAbsolute(path) ||
    !(await stat(path).then(
      (entry) => entry.isFile(),
      () => false,
    ))
  )
    throw new AnalysisCapabilityUnavailableError(
      AGENTENV_PROVIDER,
      START,
      reason,
      {
        userMessage: reason,
        remediationAction:
          "Pack a built REA with its production dependencies, set REA_BUILD_COMPUTER_REA_ARCHIVE to the archive and restart REA, or start from an exported bundle folder.",
      },
    );
  return { kind: "file", path };
};

/** An apt repository's key file, read whole once it is known to be a small regular file. */
const readAptKey = async (path: string): Promise<Buffer> => {
  const refuse = (reason: string, cause?: unknown) =>
    new AnalysisInputError(START, {
      userMessage: `The apt key file ${path} ${reason}.`,
      conformsToInputContract: true,
      ...(cause === undefined ? {} : { cause }),
    });
  const entry = await stat(path).catch((cause: unknown) => {
    throw refuse("cannot be read", cause);
  });
  if (!entry.isFile() || entry.size > MAX_KEY_BYTES)
    throw refuse(
      `is not a regular file of at most ${String(MAX_KEY_BYTES)} bytes, as a signing key is`,
    );
  return readFile(path).catch((cause: unknown) => {
    throw refuse("cannot be read", cause);
  });
};

/** Write the request's build bundle into a private folder, which the computer's owner removes on close. */
const writeBuildBundle = async (
  request: BuildRequest,
  payload: ReaPayload,
): Promise<{
  readonly workspace: PrivateRuntimeRoot;
  readonly bundle: string;
  readonly name: string;
}> => {
  const key =
    request.install.kind === "apt_repository"
      ? await readAptKey(request.install.key_file)
      : undefined;
  const { name, files } = renderBuildBundle(request, payload, key);
  const workspace = await PrivateRuntimeRoot.create({
    prefix: "rea-build-computer-",
  });
  try {
    const bundle = join(workspace.path, "bundle");
    for (const file of files) {
      const target = join(bundle, file.path);
      await mkdir(dirname(target), { recursive: true });
      if (
        typeof file.content === "string" ||
        file.content instanceof Uint8Array
      )
        await writeFile(target, file.content);
      else await copyFile(file.content.copyFrom, target);
    }
    return { workspace, bundle, name };
  } catch (cause: unknown) {
    await workspace.close();
    throw cause;
  }
};

/**
 * Owns the build computers one REA server keeps up: starts each from a
 * request or a bundle, forwards actions to its driver with an action log,
 * and brings each down on close or when the server closes.
 */
export class DesktopBuildComputers {
  readonly #computers = new Map<string, HeldComputer>();

  constructor(private readonly environment: Readonly<NodeJS.ProcessEnv>) {}

  async start(
    input: { readonly source: BuildSource },
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
    const { source } = input;
    let workspace: PrivateRuntimeRoot | undefined;
    let computer: AgentEnvComputer | undefined;
    try {
      const target =
        source.kind === "bundle"
          ? { bundle: source.path, name: source.path, workspace: undefined }
          : await writeBuildBundle(source, await reaPayload(this.environment));
      workspace = target.workspace;
      computer = await AgentEnvComputer.start({
        bundle: target.bundle,
        environment: this.environment,
        signal,
        operation: START,
      });
      const shot = await computer.callTool("computer_screenshot", {}, signal);
      const id = randomUUID();
      this.#computers.set(id, {
        computer,
        workspace,
        actions: [],
        closing: false,
      });
      return ok({
        value: {
          computer_id: id,
          sandbox_id: computer.sandboxId,
          environment: target.name,
          screenshot: shot.isError ? null : shot.structured,
        },
        content: shot.content,
      });
    } catch (cause: unknown) {
      const release = await computer?.close();
      await workspace?.close().catch(() => undefined);
      const primary = failure(START, cause, signal);
      return err(
        release === undefined || release.verified
          ? primary
          : new ProviderCleanupError(
              AGENTENV_PROVIDER,
              release.resources,
              { reason: release.reason },
              { operation: START, cause: primary },
            ),
      );
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
    if (held === undefined || held.closing) return err(unknownComputer(ACT));
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
      result = await held.computer.callTool(
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
    const held = this.#computers.get(id);
    if (held === undefined) return err(unknownComputer(CLOSE));
    held.closing = true;
    const release = await held.computer.close();
    if (!release.verified)
      return err(
        new ProviderCleanupError(
          AGENTENV_PROVIDER,
          release.resources,
          { reason: release.reason },
          { operation: CLOSE, remediationAction: release.reason },
        ),
      );
    const { workspace } = held;
    if (workspace !== undefined)
      try {
        await workspace.close();
      } catch (cause: unknown) {
        return err(
          new ProviderCleanupError(
            AGENTENV_PROVIDER,
            [workspace.path],
            { reason: "the build bundle folder could not be removed" },
            { operation: CLOSE, cause },
          ),
        );
      }
    this.#computers.delete(id);
    return ok({ computer_id: id, teardown: release.teardown });
  }

  /** Bring every held computer down, as the server closes. */
  async closeAll(): Promise<void> {
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
    if (held === undefined) return undefined;
    const { computer } = held;
    return {
      sandboxId: computer.sandboxId,
      actions: held.actions,
      startRecording: (requestId, signal) =>
        computer.startRecording(requestId, signal),
      endRecording: (recordingId, signal) =>
        computer.endRecording(recordingId, signal),
      recordingSegments: (manifest, signal) =>
        computer.recordingSegments(manifest, signal),
    };
  }
}
