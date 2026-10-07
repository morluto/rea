import type { UnverifiedProcessCapture } from "./processCapture.js";
import { digestProcessCommitment } from "./processScenario.js";

/** One pure semantic validation failure in a shaped process capture. */
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
  values.every((value, index) => {
    const previous = values[index - 1];
    return previous === undefined || value.at_ms >= previous.at_ms;
  });

const validateCommitments = (
  capture: UnverifiedProcessCapture,
  require: RequireInvariant,
): void => {
  const { manifest } = capture;
  require(manifest.scenario.executable_sha256 ===
    manifest.executable_sha256, "manifest.executable_sha256", "executable commitment does not match the scenario projection");
  for (const [field, value] of [
    ["full_scenario_sha256", manifest.scenario],
    ["comparison_contract_sha256", manifest.comparison_contract],
    ["normalization_sha256", capture.normalization],
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
  capture: UnverifiedProcessCapture,
  require: RequireInvariant,
): void => {
  for (const [name, values] of [
    ["frames", capture.frames],
    ["rendered_frames", capture.rendered_frames],
    ["interaction_events", capture.interaction_events],
  ] as const)
    require(values.every(
      ({ sequence }, index) => sequence === index,
    ), name, "sequence values must be contiguous from zero");
  for (const [name, values] of [
    ["frames", capture.frames],
    ["rendered_frames", capture.rendered_frames],
    ["process_samples", capture.process_samples],
  ] as const)
    require(orderedTimestamps(values), name, "timestamps must be ordered");
};

const validateEventJournal = (
  capture: UnverifiedProcessCapture,
  require: RequireInvariant,
): void => {
  const journal = capture.event_journal ?? [];
  if (journal.length === 0) return;
  const sizes = {
    frames: capture.frames.length,
    rendered_frames: capture.rendered_frames.length,
    interaction_events: capture.interaction_events.length,
    lifecycle: 2,
    process_samples: capture.process_samples.length,
    filesystem_checkpoints: capture.filesystem_checkpoints.length,
  };
  const references = new Set<string>();
  for (const [position, entry] of journal.entries()) {
    require(entry.capture_order ===
      position, `event_journal.${String(position)}.capture_order`, "capture order must be contiguous from zero");
    require(entry.index <
      sizes[
        entry.collection
      ], `event_journal.${String(position)}.index`, "journal reference is outside its capture collection");
    const reference = `${entry.collection}:${String(entry.index)}`;
    require(!references.has(
      reference,
    ), `event_journal.${String(position)}`, "journal references must be unique");
    references.add(reference);
  }
  const expectedSize = Object.values(sizes).reduce(
    (total, size) => total + size,
    0,
  );
  require(journal.length ===
    expectedSize, "event_journal", "nonempty journal must reference every captured observation");
};

const validateLifecycle = (
  capture: UnverifiedProcessCapture,
  require: RequireInvariant,
): void => {
  require(capture.filesystem_checkpoints.map(({ name }) => name).join(",") ===
    "before,after_settlement", "filesystem_checkpoints", "capture must include initial and final filesystem snapshots");
  require(orderedTimestamps(
    capture.filesystem_checkpoints,
  ), "filesystem_checkpoints", "filesystem snapshot times must be ordered");
  require(!capture.filesystem_checkpoints.some(({ truncated }) => truncated) ||
    capture.truncated, "truncated", "filesystem snapshot truncation must propagate to the capture");
  require(capture.exit.reason === "exited" ||
    capture.exit.code ===
      null, "exit", "deadline termination cannot declare a normal exit code");
};

/** Recompute commitments and cross-field invariants without side effects. */
export const collectProcessCaptureIssues = (
  capture: UnverifiedProcessCapture,
): readonly ProcessCaptureValidationIssue[] => {
  const issues: ProcessCaptureValidationIssue[] = [];
  const require: RequireInvariant = (condition, path, message) => {
    if (!condition) issues.push({ path, message });
  };
  validateCommitments(capture, require);
  validateOrdering(capture, require);
  validateEventJournal(capture, require);
  validateLifecycle(capture, require);
  return issues;
};
