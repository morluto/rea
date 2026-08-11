import { z } from "zod";

import { jsonValueSchema } from "./jsonValue.js";

/** Supported transport types for custom protocol capture. */
export const transportTypeSchema = z.enum([
  "tcp",
  "udp",
  "ipc",
  "unix-socket",
  "named-pipe",
  "xpc",
]);
export type TransportType = z.infer<typeof transportTypeSchema>;

/** Direction of a protocol frame. */
export const frameDirectionSchema = z.enum(["sent", "received", "intercepted"]);

/** A captured protocol frame. */
export const protocolFrameSchema = z.strictObject({
  /** Monotonic sequence number. */
  sequence: z.number().int().nonnegative(),
  /** Timestamp in milliseconds. */
  at_ms: z.number().int().nonnegative(),
  /** Transport type. */
  transport: transportTypeSchema,
  /** Direction of the frame. */
  direction: frameDirectionSchema,
  /** Source process identity. */
  source_pid: z.number().int().nullable(),
  /** Destination process identity. */
  dest_pid: z.number().int().nullable(),
  /** Endpoint address (IP:port, socket path, pipe name). */
  source_endpoint: z.string().nullable(),
  /** Destination endpoint. */
  dest_endpoint: z.string().nullable(),
  /** Raw frame data as base64. */
  raw_data: z.string().nullable(),
  /** Decoded/parsed frame content if known. */
  decoded_content: jsonValueSchema.nullable(),
  /** Frame size in bytes. */
  size: z.number().int().nonnegative(),
  /** Whether the frame was truncated. */
  truncated: z.boolean().default(false),
});
export type ProtocolFrame = z.infer<typeof protocolFrameSchema>;

/** Authentication flow stage. */
export const authStageSchema = z.enum([
  "init",
  "challenge",
  "response",
  "token_exchange",
  "renewal",
  "revocation",
  "failure",
  "success",
]);

/** Token lifecycle event. */
export const tokenLifecycleEventSchema = z.enum([
  "issued",
  "refreshed",
  "expired",
  "revoked",
  "renewed",
]);

/** A captured authentication flow event. */
export const authFlowEventSchema = z.strictObject({
  /** Monotonic sequence number. */
  sequence: z.number().int().nonnegative(),
  /** Timestamp in milliseconds. */
  at_ms: z.number().int().nonnegative(),
  /** Authentication stage. */
  stage: authStageSchema,
  /** Protocol used. */
  protocol: z.string().min(1),
  /** Token type if applicable. */
  token_type: z.string().nullable(),
  /** Token lifecycle event. */
  token_lifecycle: tokenLifecycleEventSchema.nullable(),
  /** Correlation ID linking challenge-response pairs. */
  correlation_id: z.string().nullable(),
  /** Whether credentials were detected and redacted. */
  credentials_redacted: z.boolean().default(false),
  /** Whether the authentication succeeded. */
  succeeded: z.boolean().default(false),
  /** Error message if authentication failed. */
  error: z.string().nullable(),
});
export type AuthFlowEvent = z.infer<typeof authFlowEventSchema>;

/** A captured protocol session. */
export const customProtocolCaptureSchema = z.strictObject({
  /** Transport type for this session. */
  transport: transportTypeSchema,
  /** Captured frames in order. */
  frames: z.array(protocolFrameSchema).min(0).max(100_000),
  /** Authentication flow events. */
  auth_events: z.array(authFlowEventSchema).default([]),
  /** Whether any frame was truncated. */
  has_truncated: z.boolean().default(false),
  /** Whether credentials were detected. */
  credentials_detected: z.boolean().default(false),
});

/** Correlate a frame with process identity. */
export function correlateProcessIdentity(
  frame: ProtocolFrame,
  pid: number,
): boolean {
  return frame.source_pid === pid || frame.dest_pid === pid;
}

/** Check if a frame contains credential-like content. */
export function looksLikeCredentialFrame(frame: ProtocolFrame): boolean {
  const patterns = [
    "password",
    "token",
    "secret",
    "api_key",
    "apikey",
    "authorization",
    "credential",
  ];
  const content = JSON.stringify(frame.decoded_content ?? "").toLowerCase();
  return patterns.some((p) => content.includes(p));
}

/** Filter frames by transport type. */
export function framesByTransport(
  frames: readonly ProtocolFrame[],
  transport: TransportType,
): ProtocolFrame[] {
  return frames.filter((f) => f.transport === transport);
}

/** Get all authentication flow events for a specific protocol. */
export function authEventsByProtocol(
  events: readonly AuthFlowEvent[],
  protocol: string,
): AuthFlowEvent[] {
  return events.filter((e) => e.protocol === protocol);
}

/** Get successful authentication events. */
export function successfulAuthEvents(
  events: readonly AuthFlowEvent[],
): AuthFlowEvent[] {
  return events.filter((e) => e.succeeded);
}

/** Get failed authentication events. */
export function failedAuthEvents(
  events: readonly AuthFlowEvent[],
): AuthFlowEvent[] {
  return events.filter((e) => !e.succeeded);
}

/** Compute the duration of an authentication flow in milliseconds. */
export function authFlowDuration(
  events: readonly AuthFlowEvent[],
): number | null {
  const first = events.at(0);
  const last = events.at(-1);
  if (first === undefined || last === undefined) return null;
  return last.at_ms - first.at_ms;
}
