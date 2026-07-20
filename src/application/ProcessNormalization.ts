import type {
  ProcessCapture,
  ProcessLifecycleEvent,
  ProcessSample,
  ProcessScenario,
} from "../domain/processCapture.js";

const localProcessIdentifiers = (
  identifiers: readonly number[],
): ReadonlyMap<number, number> => {
  const mapping = new Map<number, number>();
  for (const identifier of identifiers)
    if (identifier > 0 && !mapping.has(identifier))
      mapping.set(identifier, mapping.size + 1);
  return mapping;
};

const bucketProcessTime = (atMs: number, bucketMs: number): number =>
  Math.floor(atMs / bucketMs) * bucketMs;

/** Normalize and redact one terminal/protocol payload under scenario rules. */
export const normalizeProcessText = (
  value: string,
  scenario: ProcessScenario,
  temporaryRoot: string,
  pid: number,
): string => {
  let normalized = value;
  for (const alias of scenario.secret_aliases) {
    const secret = scenario.environment[alias];
    if (secret !== undefined && secret.length > 0)
      normalized = normalized.replaceAll(secret, "<redacted>");
  }
  if (scenario.normalization.paths) {
    normalized = normalized.replaceAll(temporaryRoot, "<temporary-root>");
    normalized = normalized.replaceAll(
      scenario.working_directory,
      "<working-directory>",
    );
    normalized = normalized.replaceAll(scenario.executable, "<executable>");
    for (const [index, root] of scenario.filesystem_roots.entries())
      normalized = normalized.replaceAll(
        root,
        `<filesystem-root-${String(index)}>`,
      );
  }
  if (scenario.normalization.pids)
    normalized = normalizePidTokens(normalized, [pid]);
  if (scenario.normalization.ports)
    normalized = normalized.replaceAll(/(?<=[:=])\d{2,5}\b/g, "<port>");
  for (const pattern of scenario.normalization.patterns)
    normalized = normalized.replaceAll(pattern.pattern, pattern.replacement);
  return normalized;
};

export const normalizeProcessSamples = (
  samples: readonly ProcessSample[],
  scenario: ProcessScenario,
  rootPid: number,
): readonly ProcessSample[] => {
  const identifiers = [
    rootPid,
    ...samples.flatMap((sample) => [
      sample.pid,
      sample.parent_pid,
      sample.process_group_id ?? 0,
      sample.session_id ?? 0,
    ]),
  ];
  const mapping = localProcessIdentifiers(identifiers);
  const normalizeCommand = (command: string): string => {
    const normalized = normalizeProcessText(
      command,
      scenario,
      "<no-temporary-root>",
      rootPid,
    );
    return scenario.normalization.pids
      ? normalizePidTokens(normalized, identifiers)
      : normalized;
  };
  return samples.map((sample) => ({
    at_ms: bucketProcessTime(
      sample.at_ms,
      scenario.normalization.time_bucket_ms,
    ),
    pid: mapping.get(sample.pid) ?? 1,
    parent_pid: mapping.get(sample.parent_pid) ?? 0,
    process_group_id:
      sample.process_group_id === null
        ? null
        : (mapping.get(sample.process_group_id) ?? 0),
    session_id:
      sample.session_id === null ? null : (mapping.get(sample.session_id) ?? 0),
    command: normalizeCommand(sample.command),
  }));
};

/** Normalize lifecycle coordinates with stable capture-local PID identities. */
export const normalizeProcessEvents = (
  events: readonly ProcessLifecycleEvent[],
  samples: readonly ProcessSample[],
  scenario: ProcessScenario,
  rootPid: number,
): readonly ProcessLifecycleEvent[] => {
  const identifiers = [
    rootPid,
    ...samples.flatMap(({ pid, parent_pid }) => [pid, parent_pid]),
    ...events.flatMap(({ pid, parent_pid, previous_parent_pid }) => [
      pid,
      parent_pid ?? 0,
      previous_parent_pid ?? 0,
    ]),
  ];
  const mapping = localProcessIdentifiers(identifiers);
  return events.map((event, sequence) => ({
    ...event,
    sequence,
    at_ms: bucketProcessTime(
      event.at_ms,
      scenario.normalization.time_bucket_ms,
    ),
    pid: mapping.get(event.pid) ?? 1,
    parent_pid:
      event.parent_pid === null ? null : (mapping.get(event.parent_pid) ?? 0),
    previous_parent_pid:
      event.previous_parent_pid === null
        ? null
        : (mapping.get(event.previous_parent_pid) ?? 0),
  }));
};

const normalizePidTokens = (
  value: string,
  identifiers: readonly number[],
): string => {
  const tokens = [...new Set(identifiers)]
    .filter((identifier) => Number.isSafeInteger(identifier) && identifier > 0)
    .sort((left, right) => right - left)
    .map(String);
  if (tokens.length === 0) return value;
  return value.replace(
    new RegExp(`(?<!\\d)(?:${tokens.join("|")})(?!\\d)`, "gu"),
    "<pid>",
  );
};

export const redactProtocolEvents = (
  events: readonly ProcessCapture["protocol_events"][number][],
  scenario: ProcessScenario,
): readonly ProcessCapture["protocol_events"][number][] =>
  events.map((event) => ({
    ...event,
    data: normalizeProcessText(event.data, scenario, "<no-temporary-root>", -1),
  }));
