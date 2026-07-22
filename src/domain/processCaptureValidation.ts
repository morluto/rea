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
    ["shim_events", capture.shim_events],
    ["protocol_events", capture.protocol_events],
    ["replay_transitions", capture.replay_transitions],
  ] as const)
    require(values.every(
      ({ sequence }, index) => sequence === index,
    ), name, "sequence values must be contiguous from zero");
  for (const [name, values] of [
    ["frames", capture.frames],
    ["rendered_frames", capture.rendered_frames],
    ["process_samples", capture.process_samples],
    ["filesystem_checkpoints", capture.filesystem_checkpoints],
    ["shim_events", capture.shim_events],
    ["protocol_events", capture.protocol_events],
    ["replay_transitions", capture.replay_transitions],
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const machinePlan = (
  replayPlan: Readonly<Record<string, unknown>>,
): ReplayMachine | undefined => {
  const parsed = replayMachineSchema.safeParse(replayPlan["machine"]);
  return parsed.success ? parsed.data : undefined;
};

const matchesHttpPlan = (
  value: unknown,
  event: ProcessCapture["protocol_events"][number],
): boolean => {
  if (!isRecord(value)) return false;
  const route = isRecord(value["trigger"]) ? value["trigger"] : value;
  return (
    (route["protocol"] === undefined || route["protocol"] === "http") &&
    route["method"] === event.method &&
    route["path"] === event.path
  );
};

const validateMatchedHttpEvents = (
  capture: ProcessCapture,
  plans: readonly unknown[],
  require: RequireInvariant,
): void => {
  for (const event of capture.protocol_events) {
    if (
      event.protocol !== "http" ||
      event.direction !== "request" ||
      event.outcome !== "matched"
    )
      continue;
    require(plans.some((plan) =>
      matchesHttpPlan(plan, event),
    ), "protocol_events", "matched HTTP event has no declared replay route");
  }
};

const validateReplayEvents = (
  capture: ProcessCapture,
  require: RequireInvariant,
): void => {
  const replayPlan = capture.manifest.replay_plan;
  const routes = Array.isArray(replayPlan["http"]) ? replayPlan["http"] : [];
  const machine = machinePlan(replayPlan);
  require(replayPlan["machine"] === undefined ||
    replayPlan["machine"] === null ||
    machine !==
      undefined, "manifest.replay_plan.machine", "replay machine does not satisfy its declared schema");
  validateMatchedHttpEvents(
    capture,
    [...routes, ...(machine?.transitions ?? [])],
    require,
  );
  const plans = new Map(
    (machine?.transitions ?? []).map((transition) => [
      transition.id,
      transition,
    ]),
  );
  const transitionUses = new Map<string, number>();
  const stateVisits = new Map<string, number>();
  if (machine !== undefined) stateVisits.set(machine.initial_state, 1);
  require(machine === undefined ||
    capture.replay_transitions.length <=
      machine.max_transitions, "replay_transitions", "replay transition journal exceeds the declared machine limit");
  for (const [index, transition] of capture.replay_transitions.entries()) {
    const plan = plans.get(transition.transition_id);
    require(plan !==
      undefined, "replay_transitions", "replay transition has no declared machine transition");
    if (plan === undefined) continue;
    require(transition.state_before === plan.from &&
      transition.state_after ===
        plan.to, "replay_transitions", "replay transition states do not match the declared transition");
    require(JSON.stringify(transition.sensitive_aliases) ===
      JSON.stringify(
        plan.captures
          .filter(({ sensitive }) => sensitive)
          .map(({ variable }) => variable)
          .sort(),
      ), "replay_transitions", "replay transition sensitive aliases do not match the declared captures");
    const uses = (transitionUses.get(plan.id) ?? 0) + 1;
    transitionUses.set(plan.id, uses);
    require(uses <=
      plan.max_uses, "replay_transitions", "replay transition journal exceeds the transition use limit");
    const visits = (stateVisits.get(transition.state_after) ?? 0) + 1;
    stateVisits.set(transition.state_after, visits);
    const state = machine?.states.find(
      ({ name }) => name === transition.state_after,
    );
    require(state === undefined ||
      visits <=
        state.max_visits, "replay_transitions", "replay transition journal exceeds the state visit limit");
    if (index === 0)
      require(transition.state_before ===
        machine?.initial_state, "replay_transitions", "first replay transition does not start at the declared initial state");
    if (index > 0)
      require(capture.replay_transitions[index - 1]!.state_after ===
        transition.state_before, "replay_transitions", "replay transition states are not contiguous");
  }
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
