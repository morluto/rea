import {
  DEFAULT_FRIDA_CAPTURE_POLICY,
  fridaCapturePolicySchema,
  FRIDA_CAPTURE_MAX_JSON_DEPTH,
  type FridaCapturePolicy,
} from "../domain/fridaCapturePolicy.js";

/** Reserved envelope bytes, independent of the caller's payload allowance. */
export const MAX_MESSAGE_METADATA_BYTES = 128 * 1024;

/** Why a payload or binary field was shortened. Caller payloads cannot set these. */
export const FRIDA_OWNED_CAPTURE_LIMITS = [
  "session_bytes",
  "message_type",
  "message_text",
  "payload_bytes",
  "json_nodes",
  "json_depth",
  "binary_bytes",
  "unrepresentable",
] as const;

export type FridaOwnedCaptureLimit =
  (typeof FRIDA_OWNED_CAPTURE_LIMITS)[number];

const OWNED_CAPTURE_LIMITS = new Set<string>(FRIDA_OWNED_CAPTURE_LIMITS);

const namedLimit = (value: unknown): FridaOwnedCaptureLimit | undefined =>
  typeof value === "string" && OWNED_CAPTURE_LIMITS.has(value)
    ? (value as FridaOwnedCaptureLimit)
    : undefined;

const limitationFor = (
  limit: FridaOwnedCaptureLimit,
  policy: FridaCapturePolicy,
): string => {
  const recover = (field: string, value: number, unit: string): string =>
    `Frida capture reached capture_limits.${field} (${String(value)} ${unit}). Select a larger capture_limits.${field} before starting a new explicitly chosen session or instrument_with_frida experiment; no REA restart is required. Already discarded observations cannot be recovered. Session bytes and MCP/client delivery budgets remain independent.`;
  switch (limit) {
    case "session_bytes":
    case "payload_bytes":
    case "binary_bytes":
      return recover(
        "session_bytes",
        policy.session_bytes,
        "bytes including JSON/base64 expansion and metadata",
      );
    case "message_type":
      return recover("message_type_bytes", policy.message_type_bytes, "bytes");
    case "message_text":
      return recover("message_text_bytes", policy.message_text_bytes, "bytes");
    case "json_nodes":
      return recover("json_nodes", policy.json_nodes, "nodes");
    case "json_depth":
      return policy.json_depth < FRIDA_CAPTURE_MAX_JSON_DEPTH
        ? recover("json_depth", policy.json_depth, "levels") +
            ` The maximum is ${String(FRIDA_CAPTURE_MAX_JSON_DEPTH)} levels, reserving the surrounding Evidence envelope.`
        : `Frida capture reached capture_limits.json_depth (${String(policy.json_depth)} levels), the shared JSON representation allowance after reserving the Evidence envelope. No higher depth is supported. Select a script that sends shallower payloads for a new explicitly chosen experiment. Already discarded observations cannot be recovered.`;
    case "unrepresentable":
      return "A Frida value could not be represented as JSON. Increasing capture budgets cannot recover cyclic, non-finite or unsupported values. Already discarded observations cannot be recovered.";
  }
};

/**
 * Read capture caps from REA-owned observation fields. `payload` is caller
 * data, so flags inside it are not REA dropping bytes.
 */
const collectOwnedCaps = (
  value: unknown,
  caps: Set<FridaOwnedCaptureLimit>,
): void => {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectOwnedCaps(item, caps);
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.messages_truncated === true) caps.add("session_bytes");
  if (record.type_truncated === true) caps.add("message_type");
  if (
    record.description_truncated === true ||
    record.stack_truncated === true ||
    record.file_name_truncated === true
  )
    caps.add("message_text");
  if (record.payload_truncated === true)
    caps.add(namedLimit(record.payload_capture_limit) ?? "payload_bytes");
  if (record.data_truncated === true)
    caps.add(namedLimit(record.data_capture_limit) ?? "binary_bytes");
  for (const [key, child] of Object.entries(record)) {
    if (key === "payload") continue;
    collectOwnedCaps(child, caps);
  }
};

/** Name only the caps that REA itself recorded while dropping data. */
export const fridaCaptureLimitations = (result: unknown): readonly string[] => {
  const caps = new Set<FridaOwnedCaptureLimit>();
  const selected =
    typeof result === "object" && result !== null && "capture_limits" in result
      ? fridaCapturePolicySchema.safeParse(result.capture_limits)
      : undefined;
  const policy =
    selected?.success === true ? selected.data : DEFAULT_FRIDA_CAPTURE_POLICY;
  collectOwnedCaps(result, caps);
  return FRIDA_OWNED_CAPTURE_LIMITS.flatMap((limit) =>
    caps.has(limit) ? [limitationFor(limit, policy)] : [],
  );
};
