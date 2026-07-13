import type { ProcessCapture } from "./processCapture.js";
import { canonicalProcessSha256 } from "./processScenario.js";

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
      canonicalProcessSha256(
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

const validateReplayEvents = (
  capture: ProcessCapture,
  require: RequireInvariant,
): void => {
  const { replay_plan: replayPlan } = capture.manifest;
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
    const declared = routes.some(
      (route) =>
        typeof route === "object" &&
        route !== null &&
        "method" in route &&
        route.method === event.method &&
        "path" in route &&
        route.path === event.path,
    );
    require(declared, "protocol_events", "matched HTTP event has no declared replay route");
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
