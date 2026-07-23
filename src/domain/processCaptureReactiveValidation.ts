import canonicalize from "canonicalize";

import type { ProcessCapture } from "./processCapture.js";
import {
  projectProcessObservation,
  type ProcessObservation,
} from "./processObservation.js";
import {
  commitProcessReactiveProposal,
  createProcessReactiveSnapshot,
  reduceProcessReactiveScenario,
  type ProcessReactiveDecision,
  type ProcessReactiveInput,
  type ProcessReactiveSnapshot,
} from "./processReactiveRuntime.js";
import {
  processReactiveScenarioSchema,
  type ProcessReactiveScenario,
} from "./processReactiveScenario.js";

type RequireInvariant = (
  condition: boolean,
  path: string,
  message: string,
) => void;
type ReactiveRun = NonNullable<ProcessCapture["reactive_run"]>;
type ReactiveTransition = ReactiveRun["transitions"][number];

const admittedCollection = (
  collection: NonNullable<
    ProcessCapture["event_journal"]
  >[number]["collection"],
): boolean =>
  [
    "frames",
    "interaction_events",
    "process_samples",
    "filesystem_checkpoints",
    "shim_events",
    "protocol_events",
  ].includes(collection);

const reactiveObservations = (
  capture: ProcessCapture,
): readonly ProcessObservation[] =>
  (capture.event_journal ?? []).flatMap((location) => {
    if (!admittedCollection(location.collection)) return [];
    const observation = projectProcessObservation(capture, location);
    return observation === null ? [] : [observation];
  });

const validateTransitionDeclaration = (
  transition: ReactiveTransition,
  next: ReactiveTransition | undefined,
  context: {
    readonly index: number;
    readonly scenario: ProcessReactiveScenario;
    readonly require: RequireInvariant;
  },
): void => {
  const { index, scenario, require } = context;
  const path = `reactive_run.transitions[${String(index)}]`;
  const declared = scenario.states
    .find(({ id }) => id === transition.state_before)
    ?.on.find(({ id }) => id === transition.transition_id);
  require(declared !==
    undefined, path, "reactive transition is not declared by its recorded source state");
  if (declared !== undefined) {
    const stateAfter =
      declared.target.kind === "goto" ? declared.target.state : null;
    const outcome =
      declared.target.kind === "finish" ? declared.target.outcome : null;
    require(transition.state_after === stateAfter &&
      transition.outcome ===
        outcome, path, "reactive transition target or outcome differs from the committed graph");
    require(canonicalize(transition.action_types) ===
      canonicalize(
        declared.actions.map(({ type }) => type),
      ), `${path}.action_types`, "reactive transition actions differ from the committed graph");
  }
  require(transition.sequence ===
    index, `${path}.sequence`, "reactive transition sequence must be contiguous from zero");
  if (next !== undefined)
    require(transition.state_after ===
      next.state_before, `reactive_run.transitions[${String(index + 1)}].state_before`, "reactive transition states must be contiguous");
};

const validateTransitionDeclarations = (
  run: ReactiveRun,
  scenario: ProcessReactiveScenario,
  require: RequireInvariant,
): void => {
  require(run.transitions[0]?.state_before === scenario.initial_state ||
    run.transitions.length ===
      0, "reactive_run.transitions[0].state_before", "reactive transition journal must start at the declared initial state");
  for (const [index, transition] of run.transitions.entries())
    validateTransitionDeclaration(transition, run.transitions[index + 1], {
      index,
      scenario,
      require,
    });
};

const commitRecordedEffects = (options: {
  readonly scenario: ProcessReactiveScenario;
  readonly proposal: Extract<
    ProcessReactiveDecision,
    { readonly kind: "proposal" }
  >;
  readonly expected: ReactiveTransition | undefined;
  readonly observations: ReadonlyMap<string, ProcessObservation>;
  readonly recordedFailure: "action_rejected" | "target_lost" | undefined;
}): ProcessReactiveDecision =>
  commitProcessReactiveProposal(
    options.scenario,
    options.proposal,
    options.recordedFailure === undefined
      ? options.proposal.effects.map((_, index) => {
          const eventId = options.expected?.action_event_ids[index];
          const observation =
            eventId === undefined
              ? undefined
              : options.observations.get(eventId);
          return observation === undefined
            ? { status: "rejected" as const }
            : { status: "succeeded" as const, observation };
        })
      : [
          options.recordedFailure === "target_lost"
            ? { status: "target_lost" as const }
            : { status: "rejected" as const },
        ],
    { committedSensitiveInputs: true },
  );

const replayTransitions = (
  scenario: ProcessReactiveScenario,
  run: ReactiveRun,
  observations: readonly ProcessObservation[],
  require: RequireInvariant,
): ProcessReactiveSnapshot => {
  const observationsById = new Map(
    observations.map((observation) => [observation.event_id, observation]),
  );
  let snapshot = createProcessReactiveSnapshot(scenario);
  let transitionIndex = 0;
  const advance = (input: ProcessReactiveInput): void => {
    let decision = reduceProcessReactiveScenario(scenario, snapshot, input);
    if (decision.kind === "proposal") {
      const proposal = decision;
      decision = commitRecordedEffects({
        scenario,
        proposal: decision,
        expected: run.transitions[transitionIndex],
        observations: observationsById,
        recordedFailure:
          run.transitions[transitionIndex] === undefined &&
          decision.effects.length > 0 &&
          (run.outcome === "action_rejected" || run.outcome === "target_lost")
            ? run.outcome
            : undefined,
      });
      require(decision.kind !== "finished" ||
        decision.outcome !== "action_rejected" ||
        run.outcome ===
          "action_rejected", `reactive_run.transitions[${String(transitionIndex)}].action_event_ids`, `recorded action observations do not match proposed effects: ${canonicalize(
        {
          effects: proposal.effects,
          observations: run.transitions[transitionIndex]?.action_event_ids.map(
            (eventId) => observationsById.get(eventId),
          ),
        },
      )}`);
    }
    if (decision.kind === "transition") {
      const expected = run.transitions[transitionIndex];
      require(expected !== undefined &&
        canonicalize(decision.record) ===
          canonicalize(
            expected,
          ), `reactive_run.transitions[${String(transitionIndex)}]`, "reactive transition differs from deterministic journal replay");
      transitionIndex += 1;
    }
    snapshot = decision.snapshot;
  };
  const advanceControl = (
    control: ReactiveRun["controls"][number],
    index: number,
  ): void => {
    require(snapshot.status !== "finished" ||
      control.kind ===
        "cleanup_failed", `reactive_run.controls[${String(index)}]`, "reactive control cannot follow a finished run");
    advance(
      control.kind === "state_deadline"
        ? {
            kind: control.kind,
            state_id: snapshot.active_state,
            state_entry_capture_order: snapshot.state_entry_capture_order,
          }
        : { kind: control.kind },
    );
  };
  let controlIndex = 0;
  for (const observation of observations) {
    while (
      (run.controls[controlIndex]?.after_capture_order ??
        Number.MAX_SAFE_INTEGER) < observation.capture_order
    ) {
      const control = run.controls[controlIndex]!;
      advanceControl(control, controlIndex);
      controlIndex += 1;
    }
    advance({ kind: "observation", observation });
  }
  for (; controlIndex < run.controls.length; controlIndex += 1) {
    const control = run.controls[controlIndex]!;
    advanceControl(control, controlIndex);
  }
  require(transitionIndex ===
    run.transitions
      .length, "reactive_run.transitions", `reactive transition journal is not reproduced by deterministic replay (replayed ${String(transitionIndex)} of ${String(run.transitions.length)}; outcome ${snapshot.outcome})`);
  return snapshot;
};

const validateControls = (
  run: ReactiveRun,
  observations: readonly ProcessObservation[],
  require: RequireInvariant,
): void => {
  const admittedOrders = new Set([
    -1,
    ...observations.map(({ capture_order }) => capture_order),
  ]);
  for (const [index, control] of run.controls.entries()) {
    require(control.sequence ===
      index, `reactive_run.controls[${String(index)}].sequence`, "reactive control sequence must be contiguous");
    require(admittedOrders.has(
      control.after_capture_order,
    ), `reactive_run.controls[${String(index)}].after_capture_order`, "reactive control cutoff must identify the last admitted observation");
    require(index === 0 ||
      control.after_capture_order >=
        run.controls[index - 1]!
          .after_capture_order, `reactive_run.controls[${String(index)}].after_capture_order`, "reactive control cutoffs must be ordered");
  }
};

/** Validate one capture's reactive journal by replaying the production reducer. */
export const validateProcessCaptureReactiveRun = (
  capture: ProcessCapture,
  require: RequireInvariant,
): void => {
  const declared = capture.manifest.scenario["reactive"];
  const run = capture.reactive_run;
  const declaredReactive = declared !== undefined && declared !== null;
  require(declaredReactive ===
    (run !==
      null), "reactive_run", "reactive result presence must match the committed scenario");
  if (run === null) return;
  const parsed = processReactiveScenarioSchema.safeParse(declared);
  require(parsed.success, "manifest.scenario.reactive", "committed reactive scenario does not satisfy its declared schema");
  if (!parsed.success) return;
  require(run.status === "finished" &&
    run.outcome !==
      null, "reactive_run.outcome", "completed capture requires a finished reactive outcome");
  validateTransitionDeclarations(run, parsed.data, require);
  const observations = reactiveObservations(capture);
  validateControls(run, observations, require);
  const snapshot = replayTransitions(parsed.data, run, observations, require);
  require(snapshot.outcome ===
    run.outcome, "reactive_run.outcome", "reactive outcome differs from deterministic journal replay");
  require(snapshot.active_state ===
    run.active_state, "reactive_run.active_state", "reactive active state differs from deterministic journal replay");
};
