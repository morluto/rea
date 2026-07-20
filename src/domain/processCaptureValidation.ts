import type { ProcessCapture } from "./processCapture.js";
import { replayMachineSchema, type ReplayMachine } from "./replayMachine.js";
import { digestProcessCommitment } from "./processScenario.js";

/** One pure semantic validation failure in an otherwise shaped v4 capture. */
export interface ProcessCaptureValidationIssue {
  readonly path: string;
  readonly message: string;
}

type RequireInvariant = (
  condition: boolean,
  path: string,
  message: string,
) => void;

const orderedTimestamps = (
  values: readonly { readonly at_ms: number }[],
): boolean =>
  values.every(
    (value, index) => index === 0 || value.at_ms >= values[index - 1]!.at_ms,
  );

const validateCommitments = (
  capture: ProcessCapture,
  require: RequireInvariant,
): void => {
  const { manifest } = capture;
  require(manifest.scenario.executable_sha256 ===
    manifest.executable_sha256, "manifest.executable_sha256", "executable commitment does not match the scenario projection");
  for (const [field, value] of [
    ["full_scenario_sha256", manifest.scenario],
    ["comparison_contract_sha256", manifest.comparison_contract],
    ["normalization_sha256", capture.normalization],
    ["shim_plan_sha256", manifest.shim_plan],
    ["replay_plan_sha256", manifest.replay_plan],
  ] as const)
    require(manifest[field] ===
      digestProcessCommitment(
        value,
      ), `manifest.${field}`, "commitment does not match its canonical value");
  require(Date.parse(manifest.started_at) <=
    Date.parse(
      manifest.completed_at,
    ), "manifest.completed_at", "completion precedes start");
};

const validateOrdering = (
  capture: ProcessCapture,
  require: RequireInvariant,
): void => {
  for (const [name, values] of [
    ["frames", capture.frames],
    ["rendered_frames", capture.rendered_frames],
    ["interaction_events", capture.interaction_events],
    ["process_events", capture.process_events],
    ["shim_events", capture.shim_events],
    ["protocol_events", capture.protocol_events],
    ["replay_transitions", capture.replay_transitions ?? []],
  ] as const)
    require(values.every(
      ({ sequence }, index) => sequence === index,
    ), name, "sequence values must be contiguous from zero");
  for (const [name, values] of [
    ["frames", capture.frames],
    ["rendered_frames", capture.rendered_frames],
    ["process_samples", capture.process_samples],
    ["process_events", capture.process_events],
    ["filesystem_checkpoints", capture.filesystem_checkpoints],
    ["shim_events", capture.shim_events],
    ["protocol_events", capture.protocol_events],
    ["replay_transitions", capture.replay_transitions ?? []],
  ] as const)
    require(orderedTimestamps(values), name, "timestamps must be ordered");
};

const validateLifecycle = (
  capture: ProcessCapture,
  require: RequireInvariant,
): void => {
  const checkpointNames = capture.filesystem_checkpoints.map(
    ({ name }) => name,
  );
  require(new Set(checkpointNames).size ===
    checkpointNames.length, "filesystem_checkpoints", "checkpoint names must be unique");
  require(checkpointNames[0] ===
    "before", "filesystem_checkpoints", "first checkpoint must be before");
  require(checkpointNames.at(-1) ===
    "after_settlement", "filesystem_checkpoints", "last checkpoint must be after_settlement");
  require(!capture.filesystem_checkpoints.some(({ truncated }) => truncated) ||
    capture.truncated, "truncated", "checkpoint truncation must propagate to the capture");
  require(capture.exit.reason === "exited" ||
    capture.exit.code ===
      null, "exit", "deadline termination cannot declare a normal exit code");
  require(capture.settlement.state !== "quiesced" ||
    capture.settlement.cleanup_outcome ===
      "not_required", "settlement.cleanup_outcome", "quiesced settlement cannot require cleanup");
  require(capture.settlement.state === "quiesced" ||
    capture.settlement.cleanup_outcome !==
      "not_required", "settlement.cleanup_outcome", "non-quiesced settlement must report cleanup");
};

const shimPlans = (capture: ProcessCapture) =>
  capture.manifest.shim_plan.flatMap((shim) =>
    typeof shim === "object" &&
    shim !== null &&
    "name" in shim &&
    "routes" in shim &&
    typeof shim.name === "string" &&
    Array.isArray(shim.routes)
      ? shim.routes.map((route, routeIndex) => ({
          command: shim.name as string,
          route,
          routeIndex,
        }))
      : [],
  );

const validateShimEvents = (
  capture: ProcessCapture,
  require: RequireInvariant,
): void => {
  const plans = shimPlans(capture);
  for (const event of capture.shim_events) {
    const declared = plans.some(
      ({ command, routeIndex }) =>
        command === event.command && routeIndex === event.route_index,
    );
    require(event.outcome === "unmatched"
      ? event.route_index === null
      : declared, "shim_events", "shim event has no declared route");
  }
  for (const plan of plans) {
    const maximum =
      typeof plan.route === "object" &&
      plan.route !== null &&
      "max_calls" in plan.route &&
      typeof plan.route.max_calls === "number"
        ? plan.route.max_calls
        : 0;
    const matches = capture.shim_events.filter(
      (event) =>
        event.command === plan.command &&
        event.route_index === plan.routeIndex &&
        event.outcome === "matched",
    ).length;
    require(matches <=
      maximum, "shim_events", "matched shim events exceed the declared route max_calls");
  }
};

const machineTriggerMatches = (
  transition: ReplayMachine["transitions"][number],
  event: ProcessCapture["protocol_events"][number],
): boolean =>
  transition.trigger.path === event.path &&
  (transition.trigger.protocol === "http"
    ? event.protocol === "http" &&
      event.direction === "request" &&
      transition.trigger.method === event.method
    : event.protocol === "websocket" &&
      ((transition.trigger.protocol === "websocket_connect" &&
        event.direction === "request") ||
        (transition.trigger.protocol === "websocket_message" &&
          event.direction === "received")));

const validateMachineTimeline = (
  machine: ReplayMachine,
  capture: ProcessCapture,
  require: RequireInvariant,
): void => {
  const timeline = capture.replay_transitions;
  require(timeline !==
    undefined, "replay_transitions", "machine replay capture has no transition timeline");
  if (timeline === undefined) return;
  let expectedState = machine.initial_state;
  for (const entry of timeline) {
    const event = capture.protocol_events[entry.protocol_event_sequence];
    const declared = machine.transitions.find(
      ({ id }) => id === entry.transition_id,
    );
    require(event?.transition_id ===
      entry.transition_id, "replay_transitions", "transition does not link to its triggering protocol event");
    require(declared?.from === entry.state_before &&
      declared.to ===
        entry.state_after, "replay_transitions", "transition timeline entry is not declared by the replay machine");
    require(expectedState ===
      entry.state_before, "replay_transitions", "transition timeline state chain is discontinuous");
    require(event !== undefined &&
      declared !== undefined &&
      machineTriggerMatches(
        declared,
        event,
      ), "replay_transitions", "transition trigger does not match its protocol event");
    const aliases =
      declared?.captures
        .filter(({ sensitive }) => sensitive)
        .map(({ variable }) => variable)
        .sort() ?? [];
    require(JSON.stringify(aliases) ===
      JSON.stringify(
        [...entry.sensitive_aliases].sort(),
      ), "replay_transitions", "transition secret aliases disagree with declared captures");
    expectedState = entry.state_after;
  }
  for (const event of capture.protocol_events) {
    const triggeringDirection =
      event.direction === "request" || event.direction === "received";
    if (event.outcome !== "matched" || !triggeringDirection) continue;
    require(timeline.some(
      ({ protocol_event_sequence, transition_id }) =>
        protocol_event_sequence === event.sequence &&
        transition_id === event.transition_id,
    ), "protocol_events", "matched machine event has no transition timeline entry");
  }
};

const validateQueueReplayEvents = (
  capture: ProcessCapture,
  require: RequireInvariant,
): void => {
  const replayPlan = capture.manifest.replay_plan;
  const routes =
    "http" in replayPlan && Array.isArray(replayPlan.http)
      ? replayPlan.http
      : [];
  for (const event of capture.protocol_events) {
    if (
      event.protocol !== "http" ||
      event.direction !== "request" ||
      event.outcome !== "matched"
    )
      continue;
    require(routes.some(
      (route) =>
        typeof route === "object" &&
        route !== null &&
        "method" in route &&
        route.method === event.method &&
        "path" in route &&
        route.path === event.path,
    ), "protocol_events", "matched HTTP event has no declared replay route");
  }
};

const validateReplayEvents = (
  capture: ProcessCapture,
  require: RequireInvariant,
): void => {
  const replayPlan = capture.manifest.replay_plan;
  const hasMachine = "machine" in replayPlan && replayPlan.machine !== null;
  if (!hasMachine) {
    validateQueueReplayEvents(capture, require);
    return;
  }
  const parsed = replayMachineSchema.safeParse(replayPlan.machine);
  require(parsed.success, "manifest.replay_plan.machine", "replay machine commitment is not a valid machine contract");
  if (parsed.success) validateMachineTimeline(parsed.data, capture, require);
};

/** Recompute v4 commitments and cross-field invariants without side effects. */
export const validateProcessCapture = (
  capture: ProcessCapture,
): readonly ProcessCaptureValidationIssue[] => {
  const issues: ProcessCaptureValidationIssue[] = [];
  const require: RequireInvariant = (condition, path, message) => {
    if (!condition) issues.push({ path, message });
  };
  validateCommitments(capture, require);
  validateOrdering(capture, require);
  validateLifecycle(capture, require);
  validateShimEvents(capture, require);
  validateReplayEvents(capture, require);
  return issues;
};
