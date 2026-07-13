import type {
  ProcessCapture,
  ProcessSample,
  ProcessScenario,
} from "../domain/processCapture.js";

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
    normalized = normalized.replaceAll(String(pid), "<pid>");
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
  const mapping = new Map<number, number>();
  for (const identifier of identifiers)
    if (identifier > 0 && !mapping.has(identifier))
      mapping.set(identifier, mapping.size + 1);
  return samples.map((sample) => ({
    at_ms:
      Math.floor(sample.at_ms / scenario.normalization.time_bucket_ms) *
      scenario.normalization.time_bucket_ms,
    pid: mapping.get(sample.pid) ?? 1,
    parent_pid: mapping.get(sample.parent_pid) ?? 0,
    process_group_id:
      sample.process_group_id === null
        ? null
        : (mapping.get(sample.process_group_id) ?? 0),
    session_id:
      sample.session_id === null ? null : (mapping.get(sample.session_id) ?? 0),
    command: normalizeProcessText(
      sample.command,
      scenario,
      "<no-temporary-root>",
      rootPid,
    ),
  }));
};

export const redactProtocolEvents = (
  events: readonly ProcessCapture["protocol_events"][number][],
  scenario: ProcessScenario,
): readonly ProcessCapture["protocol_events"][number][] =>
  events.map((event) => ({
    ...event,
    data: normalizeProcessText(event.data, scenario, "<no-temporary-root>", -1),
  }));
