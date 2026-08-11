import { describe, expect, it } from "vitest";

import {
  authEventsByProtocol,
  authFlowDuration,
  customProtocolCaptureSchema,
  correlateProcessIdentity,
  failedAuthEvents,
  framesByTransport,
  looksLikeCredentialFrame,
  successfulAuthEvents,
  type AuthFlowEvent,
  type ProtocolFrame,
} from "./customProtocolCapture.js";

const sampleFrames: ProtocolFrame[] = [
  {
    sequence: 0,
    at_ms: 100,
    transport: "tcp",
    direction: "sent",
    source_pid: 100,
    dest_pid: 200,
    source_endpoint: "127.0.0.1:8080",
    dest_endpoint: "127.0.0.1:9090",
    raw_data: "hello",
    decoded_content: "hello",
    size: 5,
    truncated: false,
  },
  {
    sequence: 1,
    at_ms: 200,
    transport: "udp",
    direction: "received",
    source_pid: 200,
    dest_pid: 100,
    source_endpoint: "127.0.0.1:9090",
    dest_endpoint: "127.0.0.1:8080",
    raw_data: "world",
    decoded_content: "world",
    size: 5,
    truncated: false,
  },
];

const sampleAuthEvents: AuthFlowEvent[] = [
  {
    sequence: 0,
    at_ms: 100,
    stage: "init",
    protocol: "OAuth2",
    token_type: "Bearer",
    token_lifecycle: "issued",
    correlation_id: "abc-123",
    credentials_redacted: true,
    succeeded: false,
    error: null,
  },
  {
    sequence: 1,
    at_ms: 500,
    stage: "success",
    protocol: "OAuth2",
    token_type: "Bearer",
    token_lifecycle: "issued",
    correlation_id: "abc-123",
    credentials_redacted: true,
    succeeded: true,
    error: null,
  },
];

describe("custom protocol capture", () => {
  it("validates a well-formed capture", () => {
    const capture = {
      transport: "tcp" as const,
      frames: sampleFrames,
      auth_events: sampleAuthEvents,
      has_truncated: false,
      credentials_detected: false,
    };
    const result = customProtocolCaptureSchema.safeParse(capture);
    expect(result.success).toBe(true);
  });

  it("correlates process identity", () => {
    expect(correlateProcessIdentity(sampleFrames[0]!, 100)).toBe(true);
    expect(correlateProcessIdentity(sampleFrames[0]!, 200)).toBe(true);
    expect(correlateProcessIdentity(sampleFrames[0]!, 999)).toBe(false);
  });

  it("filters frames by transport", () => {
    const tcpFrames = framesByTransport(sampleFrames, "tcp");
    expect(tcpFrames).toHaveLength(1);
    const udpFrames = framesByTransport(sampleFrames, "udp");
    expect(udpFrames).toHaveLength(1);
  });

  it("detects credential-like frames", () => {
    const credFrame: ProtocolFrame = {
      ...sampleFrames[0]!,
      decoded_content: { password: "secret" },
    };
    expect(looksLikeCredentialFrame(credFrame)).toBe(true);
    expect(looksLikeCredentialFrame(sampleFrames[0]!)).toBe(false);
  });

  it("filters auth events by protocol", () => {
    const oauthEvents = authEventsByProtocol(sampleAuthEvents, "OAuth2");
    expect(oauthEvents).toHaveLength(2);
    const otherEvents = authEventsByProtocol(sampleAuthEvents, "SAML");
    expect(otherEvents).toHaveLength(0);
  });

  it("gets successful auth events", () => {
    const success = successfulAuthEvents(sampleAuthEvents);
    expect(success).toHaveLength(1);
    expect(success[0]!.succeeded).toBe(true);
  });

  it("gets failed auth events", () => {
    const failed = failedAuthEvents(sampleAuthEvents);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.succeeded).toBe(false);
  });

  it("computes auth flow duration", () => {
    const duration = authFlowDuration(sampleAuthEvents);
    expect(duration).toBe(400);
  });

  it("returns null for empty auth events", () => {
    expect(authFlowDuration([])).toBeNull();
  });
});
