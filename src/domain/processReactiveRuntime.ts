import type { ProcessObservation } from "./processObservation.js";
import { matchProcessReactiveTrigger } from "./processReactiveMatching.js";
import {
  PROCESS_REACTIVE_LIMITS,
  type ProcessReactiveAction,
  type ProcessReactiveScenario,
} from "./processReactiveScenario.js";
export { commitProcessReactiveProposal } from "./processReactiveTransition.js";

/** Terminal and failure outcomes produced by the pure reactive reducer. */
export type ProcessReactiveOutcome =
  | "passed"
  | "predicate_timeout"
  | "scenario_deadline"
  | "ambiguous_match"
  | "action_rejected"
  | "target_lost"
  | "capture_incomplete"
  | "cancelled"
  | "cleanup_failed";

/** One deterministic scenario transition suitable for later Evidence projection. */
export interface ProcessReactiveTransitionRecord {
  readonly sequence: number;
  readonly transition_id: string;
  readonly state_before: string;
  readonly state_after: string | null;
  readonly outcome: ProcessReactiveOutcome | null;
  readonly trigger_event_ids: readonly string[];
  readonly action_event_ids: readonly string[];
  readonly action_types: readonly ProcessReactiveAction["type"][];
}

interface Counter {
  readonly id: string;
  readonly count: number;
}

interface ReactiveCheckpoint {
  readonly name: string;
  readonly event_id: string;
  readonly capture_order: number;
}

/** Immutable reducer state owned by one validated reactive scenario run. */
export interface ProcessReactiveSnapshot {
  readonly status: "running" | "finished";
  readonly outcome: ProcessReactiveOutcome | null;
  readonly active_state: string;
  readonly state_entry_capture_order: number;
  readonly observations: readonly ProcessObservation[];
  readonly consumed_event_ids: readonly string[];
  readonly transition_uses: readonly Counter[];
  readonly state_visits: readonly Counter[];
  readonly checkpoints: readonly ReactiveCheckpoint[];
  readonly transitions: readonly ProcessReactiveTransitionRecord[];
}

/** External fact offered to the pure reducer. */
export type ProcessReactiveInput =
  | { readonly kind: "observation"; readonly observation: ProcessObservation }
  | {
      readonly kind: "state_deadline";
      readonly state_id: string;
      readonly state_entry_capture_order: number;
    }
  | { readonly kind: "scenario_deadline" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "cleanup_failed" };

/** Per-transition matching summary returned without caller payloads. */
export interface ProcessReactiveEvaluation {
  readonly transition_id: string;
  readonly status: "matched" | "unmatched" | "exhausted";
  readonly matched_event_ids: readonly string[];
}

/** Host acknowledgement for one proposed declarative effect. */
export type ProcessReactiveEffectResult =
  | {
      readonly status: "succeeded";
      readonly observation: ProcessObservation;
    }
  | { readonly status: "rejected" }
  | { readonly status: "target_lost" };

/** Immutable transition proposal awaiting host effect results. */
export interface ProcessReactiveTransitionProposal {
  readonly transition_id: string;
  readonly transition_identity: string;
  readonly observation_event_id: string;
  readonly trigger_event_ids: readonly string[];
  readonly consume_event_ids: readonly string[];
}

/** Pure scenario decision; effects remain declarative for an authorized host. */
export type ProcessReactiveDecision =
  | {
      readonly kind: "waiting" | "already_finished";
      readonly snapshot: ProcessReactiveSnapshot;
      readonly evaluations: readonly ProcessReactiveEvaluation[];
    }
  | {
      readonly kind: "proposal";
      readonly snapshot: ProcessReactiveSnapshot;
      readonly evaluations: readonly ProcessReactiveEvaluation[];
      readonly effects: readonly ProcessReactiveAction[];
      readonly proposal: ProcessReactiveTransitionProposal;
    }
  | {
      readonly kind: "transition";
      readonly snapshot: ProcessReactiveSnapshot;
      readonly evaluations: readonly ProcessReactiveEvaluation[];
      readonly record: ProcessReactiveTransitionRecord;
    }
  | {
      readonly kind: "finished";
      readonly snapshot: ProcessReactiveSnapshot;
      readonly evaluations: readonly ProcessReactiveEvaluation[];
      readonly outcome: ProcessReactiveOutcome;
    };

const counterValue = (counters: readonly Counter[], id: string): number =>
  counters.find((counter) => counter.id === id)?.count ?? 0;

/** Create the initial immutable reducer state for one validated scenario. */
export const createProcessReactiveSnapshot = (
  scenario: ProcessReactiveScenario,
): ProcessReactiveSnapshot => ({
  status: "running",
  outcome: null,
  active_state: scenario.initial_state,
  state_entry_capture_order: 0,
  observations: [],
  consumed_event_ids: [],
  transition_uses: [],
  state_visits: [{ id: scenario.initial_state, count: 1 }],
  checkpoints: [],
  transitions: [],
});

const finishedDecision = (
  snapshot: ProcessReactiveSnapshot,
  outcome: ProcessReactiveOutcome,
  evaluations: readonly ProcessReactiveEvaluation[] = [],
): ProcessReactiveDecision => ({
  kind: "finished",
  outcome,
  evaluations,
  snapshot: { ...snapshot, status: "finished", outcome },
});

const reduceControlInput = (
  snapshot: ProcessReactiveSnapshot,
  input: ProcessReactiveInput,
): ProcessReactiveDecision | null => {
  if (input.kind === "cleanup_failed")
    return finishedDecision(snapshot, "cleanup_failed");
  if (snapshot.status === "finished")
    return { kind: "already_finished", snapshot, evaluations: [] };
  if (input.kind === "observation") return null;
  if (input.kind === "state_deadline")
    return input.state_id === snapshot.active_state &&
      input.state_entry_capture_order === snapshot.state_entry_capture_order
      ? finishedDecision(snapshot, "predicate_timeout")
      : { kind: "waiting", snapshot, evaluations: [] };
  if (input.kind === "scenario_deadline")
    return finishedDecision(snapshot, "scenario_deadline");
  return finishedDecision(snapshot, "cancelled");
};

/** Advance one validated scenario using only an observation or explicit deadline. */
export const reduceProcessReactiveScenario = (
  scenario: ProcessReactiveScenario,
  snapshot: ProcessReactiveSnapshot,
  input: ProcessReactiveInput,
): ProcessReactiveDecision => {
  const controlDecision = reduceControlInput(snapshot, input);
  if (controlDecision !== null) return controlDecision;
  if (input.kind !== "observation")
    return finishedDecision(snapshot, "capture_incomplete");
  const prior = snapshot.observations.at(-1);
  if (
    (prior !== undefined &&
      input.observation.capture_order <= prior.capture_order) ||
    snapshot.observations.some(
      ({ event_id }) => event_id === input.observation.event_id,
    )
  )
    return finishedDecision(snapshot, "capture_incomplete");
  if (
    snapshot.observations.length >= PROCESS_REACTIVE_LIMITS.retainedObservations
  )
    return finishedDecision(snapshot, "capture_incomplete");
  const observed = {
    ...snapshot,
    observations: [...snapshot.observations, input.observation],
  };
  const state = scenario.states.find(({ id }) => id === observed.active_state);
  if (state === undefined) return finishedDecision(observed, "target_lost");
  const budget = { remaining: PROCESS_REACTIVE_LIMITS.evaluationWork };
  const matches = state.on.map((transition) => ({
    transition,
    match: matchProcessReactiveTrigger(transition.when, observed, budget),
    uses: counterValue(observed.transition_uses, transition.id),
  }));
  if (matches.some(({ match }) => match.overflow))
    return finishedDecision(observed, "capture_incomplete");
  const evaluations: ProcessReactiveEvaluation[] = matches.map(
    ({ transition, match, uses }) => ({
      transition_id: transition.id,
      status:
        uses >= transition.max_uses
          ? "exhausted"
          : match.matched
            ? "matched"
            : "unmatched",
      matched_event_ids: match.eventIds,
    }),
  );
  const eligible = matches.filter(
    ({ transition, match, uses }) =>
      match.matched && uses < transition.max_uses,
  );
  if (eligible.length === 0)
    return { kind: "waiting", snapshot: observed, evaluations };
  const minimumPriority = Math.min(
    ...eligible.map(({ transition }) => transition.priority),
  );
  const winners = eligible.filter(
    ({ transition }) => transition.priority === minimumPriority,
  );
  if (winners.length !== 1)
    return finishedDecision(observed, "ambiguous_match", evaluations);
  const winner = winners[0];
  if (winner === undefined)
    return finishedDecision(observed, "capture_incomplete", evaluations);
  const targetDeclaration = winner.transition.target;
  if (targetDeclaration.kind === "goto") {
    const target = scenario.states.find(
      ({ id }) => id === targetDeclaration.state,
    );
    if (
      target === undefined ||
      counterValue(observed.state_visits, target.id) >= target.max_visits
    )
      return finishedDecision(observed, "capture_incomplete", evaluations);
  }
  return {
    kind: "proposal",
    snapshot: observed,
    evaluations,
    effects: winner.transition.actions,
    proposal: {
      transition_id: winner.transition.id,
      transition_identity: canonicalize(winner.transition) ?? "",
      observation_event_id: input.observation.event_id,
      trigger_event_ids: winner.match.eventIds,
      consume_event_ids: winner.match.consumeIds,
    },
  };
};
import canonicalize from "canonicalize";
