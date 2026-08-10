import type { IPty } from "@lydell/node-pty";

import type {
  InteractionEvent,
  ProcessCapture,
  ProcessReactiveControlRecord,
  ProcessSample,
  ProcessScenario,
  ProtocolEvent,
  TerminalFrame,
} from "../domain/processCapture.js";
import type { ProcessReactiveInput } from "../domain/processReactiveRuntime.js";
import { ProcessCaptureError } from "./ProcessCaptureError.js";
import type { ProcessCaptureJournal } from "./ProcessCaptureJournal.js";
import type { ProcessCheckpoints } from "./ProcessCheckpoints.js";
import type { CommandShimReplay } from "./CommandShimReplay.js";
import { ProcessReactiveCoordinator } from "./ProcessReactiveCoordinator.js";
import {
  executeProcessReactiveEffects,
  type ProcessReactiveTerminal,
  unsupportedProcessReactiveFeatures,
} from "./ProcessReactiveEffects.js";
import { subscribeProcessReactiveObservations } from "./ProcessReactiveObservations.js";
import {
  normalizeProcessSamples,
  normalizeProcessShimEvent,
  redactProtocolEvents,
} from "./ProcessNormalization.js";
import type { TerminalRenderer } from "./TerminalRenderer.js";

/** Coordinator and subscription owned by one live process capture. */
export interface ProcessReactiveHarness {
  readonly coordinator: ProcessReactiveCoordinator;
  readonly controls: readonly ProcessReactiveControlRecord[];
  readonly unsubscribe: () => void;
}

const reactiveTerminalFor = (
  terminal: IPty | undefined,
): ProcessReactiveTerminal | undefined => {
  if (terminal === undefined) return undefined;
  return {
    write: (data) => terminal.write(data),
    resize: (columns, rows) => terminal.resize(columns, rows),
    closeInput: () => {
      const end: unknown = Reflect.get(terminal, "end");
      if (typeof end !== "function")
        throw new ProcessCaptureError(
          "PTY backend does not expose an stdin-close operation",
        );
      Reflect.apply(end, terminal, []);
    },
    kill: (signal) => terminal.kill(signal),
  };
};

const controlKind = (
  input: ProcessReactiveInput,
): ProcessReactiveControlRecord["kind"] | undefined =>
  input.kind === "observation" ? undefined : input.kind;

/** Reject reactive declarations the current process adapter cannot execute. */
export const assertSupportedReactiveScenario = (
  scenario: ProcessScenario,
): void => {
  if (scenario.reactive === null) return;
  const unsupported = unsupportedProcessReactiveFeatures(scenario.reactive);
  if (unsupported.length === 0) return;
  throw new ProcessCaptureError(
    `reactive scenario requests unsupported features: ${unsupported.join(", ")}`,
  );
};

/**
 * Attach the serialized reactive runtime once the target PID is available.
 *
 * Subscription replays journal entries admitted during launcher startup before
 * observing new records, so PID-dependent normalization cannot drop them.
 */
export const startProcessReactiveHarness = (options: {
  readonly scenario: ProcessScenario;
  readonly terminal: () => IPty | undefined;
  readonly renderer: TerminalRenderer;
  readonly checkpoints: ProcessCheckpoints;
  readonly shimReplay: CommandShimReplay;
  readonly started: number;
  readonly capture: {
    readonly interactions: InteractionEvent[];
    readonly journal: ProcessCaptureJournal;
    readonly frames: readonly TerminalFrame[];
    readonly processSamples: readonly ProcessSample[];
    readonly protocolEvents: () => readonly ProtocolEvent[];
    readonly temporaryRoot: string;
  };
}): ProcessReactiveHarness | undefined => {
  if (options.scenario.reactive === null) return undefined;
  const controls: ProcessReactiveControlRecord[] = [];
  const coordinator = new ProcessReactiveCoordinator({
    scenario: options.scenario.reactive,
    executor: {
      execute: (actions, signal) =>
        executeProcessReactiveEffects(
          {
            terminal: () => reactiveTerminalFor(options.terminal()),
            renderer: options.renderer,
            checkpoints: options.checkpoints,
            interactions: options.capture.interactions,
            journal: options.capture.journal,
            startedAtMs: options.started,
            now: Date.now,
          },
          actions,
          signal,
        ),
    },
    onDecision: (decision, input) => {
      const kind = controlKind(input);
      if (kind === undefined || decision.kind !== "finished") return;
      controls.push({
        sequence: controls.length,
        kind,
        after_capture_order:
          decision.snapshot.observations.at(-1)?.capture_order ?? -1,
      });
    },
  });
  return {
    coordinator,
    controls,
    unsubscribe: subscribeProcessReactiveObservations({
      journal: options.capture.journal,
      frames: options.capture.frames,
      interactions: options.capture.interactions,
      checkpointAt: (index) => options.checkpoints.at(index),
      processSampleAt: (index) => {
        const rootPid = options.terminal()?.pid;
        return rootPid === undefined
          ? undefined
          : normalizeProcessSamples(
              options.capture.processSamples,
              options.scenario,
              rootPid,
            )[index];
      },
      protocolEventAt: (index) =>
        redactProtocolEvents(
          options.capture.protocolEvents().slice(index, index + 1),
          options.scenario,
        )[0],
      shimEventAt: (index) => {
        const event = options.shimReplay.events[index];
        const rootPid = options.terminal()?.pid;
        return event === undefined || rootPid === undefined
          ? undefined
          : normalizeProcessShimEvent(
              event,
              options.scenario,
              options.capture.temporaryRoot,
              rootPid,
            );
      },
      sink: coordinator,
    }),
  };
};

/** Project internal reducer state into the stable Process Capture shape. */
export const projectProcessReactiveRun = (
  harness: ProcessReactiveHarness | undefined,
): ProcessCapture["reactive_run"] => {
  if (harness === undefined) return null;
  const snapshot = harness.coordinator.snapshot;
  const completion =
    snapshot.status === "running"
      ? { status: snapshot.status, outcome: null }
      : { status: snapshot.status, outcome: snapshot.outcome };
  return {
    ...completion,
    active_state: snapshot.active_state,
    transitions: snapshot.transitions,
    controls: harness.controls,
  };
};
