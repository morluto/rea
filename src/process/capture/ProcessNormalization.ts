import { isIP } from "node:net";

import type { ProcessScenario } from "../../domain/process/processScenario.js";

import type { ProcessSample } from "../../domain/process/processCapture.js";
/** Bucket one elapsed process-capture timestamp under scenario normalization. */
export const normalizeProcessElapsedTime = (
  elapsedMs: number,
  timeBucketMs: number,
): number => Math.floor(elapsedMs / timeBucketMs) * timeBucketMs;

/** Normalize one terminal/protocol payload under explicitly selected scenario rules. */
export const normalizeProcessText = (
  value: string,
  scenario: ProcessScenario,
  temporaryRoot: string,
  pid: number,
): string => {
  let normalized = value;
  if (scenario.normalization.paths) {
    normalized = normalized.replaceAll(temporaryRoot, "<temporary-root>");
    normalized = normalized.replaceAll(
      scenario.working_directory,
      "<working-directory>",
    );
    normalized = normalized.replaceAll(scenario.executable, "<executable>");
    for (const [index, root] of scenario.filesystem_observation_paths.entries())
      normalized = normalized.replaceAll(
        root,
        `<filesystem-root-${String(index)}>`,
      );
  }
  if (scenario.normalization.ports)
    normalized = normalizePortTokens(normalized);
  if (scenario.normalization.pids)
    normalized = normalizePidTokens(normalized, [pid]);
  // A callback keeps replacement text literal while preserving replaceAll's
  // empty-pattern boundaries, which the process scenario contract permits.
  for (const pattern of scenario.normalization.patterns)
    normalized = normalized.replaceAll(
      pattern.pattern,
      () => pattern.replacement,
    );
  return normalized;
};

// A port may end a sentence, but a period followed by a letter, digit, or
// underscore in any script continues a decimal, version, or host name and is
// not a port boundary.
// PTY chunks are normalized independently, so a period that ends the chunk
// stays unnormalized: its continuation may arrive in the next chunk.
const normalizePortTokens = (value: string): string => {
  const endpointNormalized = value.replaceAll(
    /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#"'<>]+|\blocalhost|\b(?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:.%]+\]):(\d{1,5})(?![\p{L}\p{N}_@:]|\.(?:[\p{L}\p{N}_]|$))/giu,
    (match: string, endpoint: string, port: string) => {
      if (Number(port) > 65_535) return match;
      const isEndpoint = endpoint.includes("://")
        ? URL.canParse(`${endpoint}:${port}`)
        : endpoint.toLowerCase() === "localhost" ||
          isIP(endpoint.replace(/^\[|\]$/gu, "")) !== 0;
      return isEndpoint ? `${endpoint}:<port>` : match;
    },
  );
  return endpointNormalized.replaceAll(
    /(\b(?:port|tcp_port|udp_port|listen)\b["']?\s*[:=]\s*)(\d{1,5})(?![\p{L}\p{N}_]|\.(?:[\p{L}\p{N}_]|$))/giu,
    (match: string, prefix: string, port: string) =>
      Number(port) <= 65_535 ? `${prefix}<port>` : match,
  );
};

/** Project sampled observations under the caller-selected normalization rules. */
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
  const normalizeCommand = (command: string): string => {
    const normalized = normalizeProcessText(
      command,
      scenario,
      "<no-temporary-root>",
      rootPid,
    );
    const withNormalizedPids = scenario.normalization.pids
      ? normalizePidTokens(normalized, identifiers)
      : normalized;
    return withNormalizedPids.trim();
  };
  return samples.map((sample) => ({
    at_ms: normalizeProcessElapsedTime(
      sample.at_ms,
      scenario.normalization.time_bucket_ms,
    ),
    pid: scenario.normalization.pids
      ? (mapping.get(sample.pid) ?? 1)
      : sample.pid,
    parent_pid: scenario.normalization.pids
      ? (mapping.get(sample.parent_pid) ?? 0)
      : sample.parent_pid,
    process_group_id:
      !scenario.normalization.pids || sample.process_group_id === null
        ? sample.process_group_id
        : (mapping.get(sample.process_group_id) ?? 0),
    session_id:
      !scenario.normalization.pids || sample.session_id === null
        ? sample.session_id
        : (mapping.get(sample.session_id) ?? 0),
    command: normalizeCommand(sample.command),
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
