import type { ProcessObservation } from "./processObservation.js";
import type {
  ProcessReactiveDecision,
  ProcessReactiveEffectResult,
  ProcessReactiveEvaluation,
  ProcessReactiveSnapshot,
  ProcessReactiveTransitionRecord,
} from "./processReactiveRuntime.js";
import type { ProcessReactiveScenario } from "./processReactiveScenario.js";

type ReactiveTransition =
  ProcessReactiveScenario["states"][number]["on"][number];

const counterValue = (
  counters: readonly { readonly id: string; readonly count: number }[],
  id: string,
): number => counters.find((counter) => counter.id === id)?.count ?? 0;

const incrementCounter = (
  counters: readonly { readonly id: string; readonly count: number }[],
  id: string,
) => {
  let found = false;
  const updated = counters.map((counter) => {
    if (counter.id !== id) return counter;
    found = true;
    return { id, count: counter.count + 1 };
  });
  return found ? updated : [...updated, { id, count: 1 }];
};

/** Commit one uniquely selected transition after its declarative effects succeed. */
const applyProcessReactiveTransition = (input: {
  readonly scenario: ProcessReactiveScenario;
  readonly snapshot: ProcessReactiveSnapshot;
  readonly observation: ProcessObservation;
  readonly transition: ReactiveTransition;
  readonly triggerEventIds: readonly string[];
  readonly consumeEventIds: readonly string[];
  readonly effectResults: readonly Extract<
    ProcessReactiveEffectResult,
    { readonly status: "succeeded" }
  >[];
  readonly evaluations: readonly ProcessReactiveEvaluation[];
}): ProcessReactiveDecision => {
  const outcome =
    input.transition.target.kind === "finish"
      ? input.transition.target.outcome
      : null;
  const stateAfter =
    input.transition.target.kind === "goto"
      ? input.transition.target.state
      : null;
  const record: ProcessReactiveTransitionRecord = {
    sequence: input.snapshot.transitions.length,
    transition_id: input.transition.id,
    state_before: input.snapshot.active_state,
    state_after: stateAfter,
    outcome,
    trigger_event_ids: input.triggerEventIds,
    action_event_ids: input.effectResults.map(
      ({ observation }) => observation.event_id,
    ),
    action_types: input.transition.actions.map(({ type }) => type),
  };
  const consumed = new Set(input.snapshot.consumed_event_ids);
  for (const eventId of input.consumeEventIds) consumed.add(eventId);
  const checkpoints = [...input.snapshot.checkpoints];
  for (const [index, action] of input.transition.actions.entries())
    if (action.type === "checkpoint")
      checkpoints.push({
        name: action.name,
        event_id: input.effectResults[index]!.observation.event_id,
        capture_order: input.effectResults[index]!.observation.capture_order,
      });
  const completedCaptureOrder = Math.max(
    input.observation.capture_order,
    ...input.effectResults.map(({ observation }) => observation.capture_order),
  );
  let next: ProcessReactiveSnapshot = {
    ...input.snapshot,
    status: outcome === null ? "running" : "finished",
    outcome,
    active_state: stateAfter ?? input.snapshot.active_state,
    state_entry_capture_order:
      stateAfter === null
        ? input.snapshot.state_entry_capture_order
        : completedCaptureOrder + 1,
    consumed_event_ids: [...consumed],
    transition_uses: incrementCounter(
      input.snapshot.transition_uses,
      input.transition.id,
    ),
    state_visits:
      stateAfter === null
        ? input.snapshot.state_visits
        : incrementCounter(input.snapshot.state_visits, stateAfter),
    checkpoints,
    transitions: [...input.snapshot.transitions, record],
  };
  if (stateAfter !== null) {
    const nextState = input.scenario.states.find(({ id }) => id === stateAfter);
    if (
      nextState === undefined ||
      counterValue(next.state_visits, stateAfter) > nextState.max_visits
    )
      next = { ...next, status: "finished", outcome: "capture_incomplete" };
  }
  return next.outcome === "capture_incomplete"
    ? {
        kind: "finished",
        snapshot: next,
        evaluations: input.evaluations,
        outcome: next.outcome,
      }
    : {
        kind: "transition",
        snapshot: next,
        evaluations: input.evaluations,
        record,
      };
};

const effectObservationMatchesAction = (
  action: ProcessReactiveScenario["states"][number]["on"][number]["actions"][number],
  observation: ProcessObservation,
  committedSensitiveInputs: boolean,
): boolean => {
  const payload =
    typeof observation.payload === "object" &&
    observation.payload !== null &&
    !Array.isArray(observation.payload)
      ? observation.payload
      : null;
  const journalIdentityMatches =
    observation.source_sequence === observation.location.index &&
    observation.capture_order === observation.location.capture_order &&
    observation.event_id ===
      `obs.${observation.location.collection}.${String(observation.location.index)}`;
  if (!journalIdentityMatches || payload === null) return false;
  if (action.type === "checkpoint")
    return (
      observation.source === "filesystem" &&
      observation.location.collection === "filesystem_checkpoints" &&
      payload["name"] === action.name
    );
  if (
    observation.source !== "interaction" ||
    observation.location.collection !== "interaction_events" ||
    payload["outcome"] !== "dispatched"
  )
    return false;
  if (action.type === "send_input")
    return (
      payload["type"] === "input" &&
      payload["data"] ===
        expectedInputEvidence(
          action.data,
          action.sensitive,
          committedSensitiveInputs,
        )
    );
  if (action.type === "resize")
    return (
      payload["type"] === "resize" &&
      payload["data"] === `${String(action.columns)}x${String(action.rows)}`
    );
  return payload["type"] === "signal" && payload["data"] === action.signal;
};

const expectedInputEvidence = (
  data: string,
  sensitive: boolean,
  committedSensitiveInput: boolean,
): string =>
  !sensitive ||
  (committedSensitiveInput && /^<redacted-input:\d+-bytes>$/.test(data))
    ? data
    : `<redacted-input:${String(Buffer.byteLength(data))}-bytes>`;

const failedProposal = (
  proposed: Extract<ProcessReactiveDecision, { readonly kind: "proposal" }>,
  outcome: "action_rejected" | "target_lost",
): ProcessReactiveDecision => ({
  kind: "finished",
  outcome,
  evaluations: proposed.evaluations,
  snapshot: { ...proposed.snapshot, status: "finished", outcome },
});

/** Commit a proposal only after the host reports every effect as successful. */
export const commitProcessReactiveProposal = (
  scenario: ProcessReactiveScenario,
  proposed: Extract<ProcessReactiveDecision, { readonly kind: "proposal" }>,
  results: readonly ProcessReactiveEffectResult[],
  options: { readonly committedSensitiveInputs?: boolean } = {},
): ProcessReactiveDecision => {
  if (results.some(({ status }) => status === "target_lost"))
    return failedProposal(proposed, "target_lost");
  const state = scenario.states.find(
    ({ id }) => id === proposed.snapshot.active_state,
  );
  const transition = state?.on.find(
    ({ id }) => id === proposed.proposal.transition_id,
  );
  const observation = proposed.snapshot.observations.find(
    ({ event_id }) => event_id === proposed.proposal.observation_event_id,
  );
  if (
    transition === undefined ||
    observation === undefined ||
    canonicalize(transition) !== proposed.proposal.transition_identity ||
    canonicalize(proposed.effects) !== canonicalize(transition.actions)
  )
    return failedProposal(proposed, "target_lost");
  if (
    results.length !== transition.actions.length ||
    results.some(({ status }) => status === "rejected")
  )
    return failedProposal(proposed, "action_rejected");
  const succeeded = results.filter(
    (
      result,
    ): result is Extract<
      ProcessReactiveEffectResult,
      { readonly status: "succeeded" }
    > => result.status === "succeeded",
  );
  let previousOrder =
    proposed.snapshot.observations.find(
      ({ event_id }) => event_id === proposed.proposal.observation_event_id,
    )?.capture_order ?? -1;
  const knownEventIds = new Set([
    ...proposed.snapshot.observations.map(({ event_id }) => event_id),
    ...proposed.snapshot.transitions.flatMap(
      ({ action_event_ids }) => action_event_ids,
    ),
  ]);
  for (const [index, result] of succeeded.entries()) {
    const action = transition.actions[index];
    const effectObservation = result.observation;
    if (
      action === undefined ||
      !effectObservationMatchesAction(
        action,
        effectObservation,
        options.committedSensitiveInputs ?? false,
      ) ||
      !Number.isSafeInteger(effectObservation.capture_order) ||
      effectObservation.capture_order <= previousOrder ||
      knownEventIds.has(effectObservation.event_id)
    )
      return failedProposal(proposed, "action_rejected");
    knownEventIds.add(effectObservation.event_id);
    previousOrder = effectObservation.capture_order;
  }
  return applyProcessReactiveTransition({
    scenario,
    snapshot: proposed.snapshot,
    observation,
    transition,
    triggerEventIds: proposed.proposal.trigger_event_ids,
    consumeEventIds: proposed.proposal.consume_event_ids,
    effectResults: succeeded,
    evaluations: proposed.evaluations,
  });
};
import canonicalize from "canonicalize";
