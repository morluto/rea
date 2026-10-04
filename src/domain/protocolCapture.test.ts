import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  classifyProtocolFamily,
  decodeGrpcFrame,
  decodeJsonRpc,
  decodeMessagePack,
  inferMessageSchema,
  looksLikeCredential,
  protocolCaptureSchema,
  type ProtocolMessage,
} from "./protocolCapture.js";

describe("protocol capture", () => {
  it("accepts every captured message", () => {
    const message: ProtocolMessage = {
      sequence: 0,
      at_ms: 0,
      family: "json-rpc",
      direction: "request",
      endpoint: null,
      content_type: null,
      raw_payload: null,
      decoded_fields: [],
      schema_hypotheses: [],
      truncated: false,
      credentials_redacted: false,
    };

    expect(
      protocolCaptureSchema.parse({
        family: "json-rpc",
        messages: Array.from({ length: 10_001 }, (_, sequence) => ({
          ...message,
          sequence,
        })),
      }).messages,
    ).toHaveLength(10_001);
  });

  it("classifies gRPC from content type", () => {
    expect(classifyProtocolFamily("application/grpc+proto", null)).toBe("grpc");
  });

  it("classifies protobuf from content type", () => {
    expect(classifyProtocolFamily("application/x-protobuf", null)).toBe(
      "protobuf",
    );
  });

  it("classifies json-rpc from content type", () => {
    expect(classifyProtocolFamily("application/json-rpc", null)).toBe(
      "json-rpc",
    );
  });

  it("classifies msgpack from content type", () => {
    expect(classifyProtocolFamily("application/msgpack", null)).toBe(
      "messagepack",
    );
  });

  it("classifies from path when content type is null", () => {
    expect(classifyProtocolFamily(null, "/some/grpc/method")).toBe("grpc");
    expect(classifyProtocolFamily(null, "/api/json-rpc/2.0")).toBe("json-rpc");
  });

  it("returns null for unknown protocols", () => {
    expect(classifyProtocolFamily("text/plain", null)).toBeNull();
    expect(classifyProtocolFamily(null, null)).toBeNull();
  });

  it("detects credential-like field names", () => {
    expect(looksLikeCredential("password")).toBe(true);
    expect(looksLikeCredential("api_key")).toBe(true);
    expect(looksLikeCredential("authorization")).toBe(true);
    expect(looksLikeCredential("username")).toBe(false);
  });
});

describe("JSON-RPC decoding", () => {
  it("decodes the captured MCP SDK initialize request with exact field values", async () => {
    const payload = await readFile(
      new URL(
        "../../tests/fixtures/golden/mcp-initialize.json",
        import.meta.url,
      ),
    );
    expect(decodeJsonRpc(payload)).toEqual({
      decoded_fields: [
        {
          path: "method",
          wire_type: "json",
          value: "initialize",
          inferred: false,
        },
        {
          path: "params",
          wire_type: "json",
          inferred: false,
          value: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "rea-protocol-golden", version: "1" },
          },
        },
        { path: "jsonrpc", wire_type: "json", value: "2.0", inferred: false },
        { path: "id", wire_type: "json", value: 0, inferred: false },
      ],
      truncated: false,
    });
  });

  it("redacts credential-like fields", () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({
        password: "secret123",
        username: "admin",
      }),
    );
    const result = decodeJsonRpc(payload);
    const passwordField = result.decoded_fields.find(
      (f) => f.path === "password",
    );
    expect(passwordField?.value).toBe("[REDACTED]");
    const usernameField = result.decoded_fields.find(
      (f) => f.path === "username",
    );
    expect(usernameField?.value).toBe("admin");
  });
});

describe("MessagePack decoding", () => {
  it("does not report unobserved payload bytes as truncation", () => {
    const result = decodeMessagePack(new Uint8Array(10_001).fill(0x82));

    expect(result.truncated).toBe(false);
  });

  it("detects map type", () => {
    const payload = new Uint8Array([0x82]);
    const result = decodeMessagePack(payload);
    expect(result.decoded_fields[0]?.value).toBe("map");
  });

  it("detects array type", () => {
    const payload = new Uint8Array([0x92]);
    const result = decodeMessagePack(payload);
    expect(result.decoded_fields[0]?.value).toBe("array");
  });

  it("reports unknown type for other tags", () => {
    const payload = new Uint8Array([0xff]);
    const result = decodeMessagePack(payload);
    expect(result.decoded_fields[0]?.value).toBe("unknown");
    expect(result.decoded_fields[0]?.inferred).toBe(true);
  });
});

describe("gRPC frame decoding", () => {
  it("decodes a valid gRPC frame header", () => {
    const payload = new Uint8Array([
      0x00, 0x00, 0x00, 0x00, 0x05, 1, 2, 3, 4, 5,
    ]);
    const result = decodeGrpcFrame(payload);
    expect(result.decoded_fields).toHaveLength(2);
    expect(result.decoded_fields[0]?.path).toBe("compressed");
    expect(result.decoded_fields[0]?.value).toBe(false);
    expect(result.decoded_fields[1]?.path).toBe("message_length");
    expect(result.decoded_fields[1]?.value).toBe(5);
  });

  it("detects compressed flag", () => {
    const payload = new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x0a]);
    const result = decodeGrpcFrame(payload);
    expect(result.decoded_fields[0]?.value).toBe(true);
  });

  it("handles too-short frames", () => {
    const payload = new Uint8Array([0x00, 0x01]);
    const result = decodeGrpcFrame(payload);
    expect(result.decoded_fields[0]?.path).toBe("error");
  });
});

describe("schema inference", () => {
  it("infers schema from repeated messages", () => {
    const messages: ProtocolMessage[] = [
      {
        sequence: 0,
        at_ms: 0,
        family: "json-rpc",
        direction: "request",
        endpoint: "/api",
        content_type: "application/json",
        raw_payload: null,
        decoded_fields: [
          { path: "method", wire_type: "json", value: "add", inferred: false },
          { path: "id", wire_type: "json", value: 1, inferred: false },
        ],
        schema_hypotheses: [],
        truncated: false,
        credentials_redacted: false,
      },
      {
        sequence: 1,
        at_ms: 10,
        family: "json-rpc",
        direction: "response",
        endpoint: "/api",
        content_type: "application/json",
        raw_payload: null,
        decoded_fields: [
          { path: "result", wire_type: "json", value: 3, inferred: false },
          { path: "id", wire_type: "json", value: 1, inferred: false },
        ],
        schema_hypotheses: [],
        truncated: false,
        credentials_redacted: false,
      },
    ];
    const hypotheses = inferMessageSchema(messages);
    expect(hypotheses).toHaveLength(3);
    const idHypothesis = hypotheses.find((h) => h.field_name === "id");
    expect(idHypothesis).toBeDefined();
    expect(idHypothesis!.evidence_count).toBe(2);
    expect(idHypothesis!.confidence).toBe(1);
  });
});

describe("protocol capture schema validation", () => {
  it("rejects a capture with an unknown protocol family", () => {
    const result = protocolCaptureSchema.safeParse({
      family: "smtp",
      messages: [],
      inferred_schema: [],
      has_truncated: false,
      credentials_detected: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a capture that declares a non-boolean truncation flag", () => {
    const result = protocolCaptureSchema.safeParse({
      family: "grpc",
      messages: [],
      inferred_schema: [],
      has_truncated: "no",
      credentials_detected: false,
    });
    expect(result.success).toBe(false);
  });
});
