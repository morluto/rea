import { z } from "zod";

import { jsonValueSchema } from "./jsonValue.js";

/** Supported protocol families for structured protocol capture. */
export const protocolFamilySchema = z.enum([
  "grpc",
  "protobuf",
  "json-rpc",
  "messagepack",
]);
export type ProtocolFamily = z.infer<typeof protocolFamilySchema>;

/** A decoded field from a protocol message. */
export const decodedFieldSchema = z.strictObject({
  /** Field name or path within the message structure. */
  path: z.string().min(1),
  /** Wire type or encoding hint. */
  wire_type: z.string().nullable(),
  /** Decoded field value. */
  value: jsonValueSchema.nullable(),
  /** Whether this field value was inferred rather than decoded. */
  inferred: z.boolean().default(false),
});
export type DecodedField = z.infer<typeof decodedFieldSchema>;

/** Schema inference hypothesis for a repeated message pattern. */
export const schemaHypothesisSchema = z.strictObject({
  /** Hypothesized field name. */
  field_name: z.string().min(1),
  /** Inferred type. */
  inferred_type: z.string().min(1),
  /** Confidence: 0-1 */
  confidence: z.number().min(0).max(1),
  /** Supporting evidence count. */
  evidence_count: z.number().int().nonnegative(),
});
export type SchemaHypothesis = z.infer<typeof schemaHypothesisSchema>;

/** Result of decoding a single protocol message. */
export const protocolMessageSchema = z.strictObject({
  /** Monotonic sequence number. */
  sequence: z.number().int().nonnegative(),
  /** Timestamp in milliseconds. */
  at_ms: z.number().int().nonnegative(),
  /** Protocol family. */
  family: protocolFamilySchema,
  /** Direction of the message. */
  direction: z.enum(["request", "response"]),
  /** Transport endpoint or path (e.g. gRPC method path). */
  endpoint: z.string().nullable(),
  /** Content type of the raw payload. */
  content_type: z.string().nullable(),
  /** Raw payload bytes as base64. */
  raw_payload: z.string().nullable(),
  /** Decoded fields from the payload. */
  decoded_fields: z.array(decodedFieldSchema).default([]),
  /** Inferred schema hypotheses. */
  schema_hypotheses: z.array(schemaHypothesisSchema).default([]),
  /** Whether decoding was truncated. */
  truncated: z.boolean().default(false),
  /** Whether credentials were detected and redacted. */
  credentials_redacted: z.boolean().default(false),
});
export type ProtocolMessage = z.infer<typeof protocolMessageSchema>;

/** A captured protocol session with messages and inferred schemas. */
export const protocolCaptureSchema = z.strictObject({
  /** Protocol family for this capture. */
  family: protocolFamilySchema,
  /** Captured messages in order. */
  messages: z.array(protocolMessageSchema).min(0).max(10_000),
  /** Aggregated schema hypotheses across all messages. */
  inferred_schema: z.array(schemaHypothesisSchema).default([]),
  /** Whether any message was truncated. */
  has_truncated: z.boolean().default(false),
  /** Whether credentials were detected and redacted. */
  credentials_detected: z.boolean().default(false),
});
export type ProtocolCapture = z.infer<typeof protocolCaptureSchema>;

/** Classification of a byte sequence as a known protocol family. */
export function classifyProtocolFamily(
  contentType: string | null,
  path: string | null,
): ProtocolFamily | null {
  if (contentType) {
    if (contentType.includes("application/grpc")) return "grpc";
    if (contentType.includes("application/x-protobuf")) return "protobuf";
    if (contentType.includes("application/json-rpc")) return "json-rpc";
    if (
      contentType.includes("application/msgpack") ||
      contentType.includes("application/x-msgpack")
    )
      return "messagepack";
  }
  if (path) {
    if (path.startsWith("/grpc.") || path.includes("/grpc/")) return "grpc";
    if (path.includes("/json-rpc") || path.includes("/jsonrpc"))
      return "json-rpc";
  }
  return null;
}

/** Credential-like field names that should be redacted. */
const CREDENTIAL_PATTERNS = [
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "authorization",
  "auth",
  "credential",
  "private_key",
];

/** Check if a field path looks like it may contain credentials. */
export function looksLikeCredential(path: string): boolean {
  const lower = path.toLowerCase();
  return CREDENTIAL_PATTERNS.some((p) => lower.includes(p));
}

/** Decode a JSON-RPC message from raw payload bytes. */
export function decodeJsonRpc(rawPayload: Uint8Array): {
  decoded_fields: DecodedField[];
  truncated: boolean;
} {
  const text = new TextDecoder().decode(rawPayload);
  const parsed = jsonValueSchema.parse(JSON.parse(text));
  const fields: DecodedField[] = [];

  if (typeof parsed === "object" && parsed !== null) {
    for (const [key, value] of Object.entries(parsed)) {
      if (looksLikeCredential(key)) {
        fields.push({
          path: key,
          wire_type: "json",
          value: "[REDACTED]",
          inferred: false,
        });
      } else {
        fields.push({
          path: key,
          wire_type: "json",
          value,
          inferred: false,
        });
      }
    }
  }

  return { decoded_fields: fields, truncated: false };
}

/** Decode a MessagePack message (simplified: only checks basic structure). */
export function decodeMessagePack(rawPayload: Uint8Array): {
  decoded_fields: DecodedField[];
  truncated: boolean;
} {
  const fields: DecodedField[] = [];
  // MessagePack uses a single-byte type tag
  if (rawPayload.length === 0) {
    return { decoded_fields: [], truncated: false };
  }
  const tag = rawPayload[0];
  if (tag === undefined) return { decoded_fields: [], truncated: false };
  // Map type: 0x80-0x8f (fixmap), 0xde (map16), 0xdf (map32)
  if ((tag >= 0x80 && tag <= 0x8f) || tag === 0xde || tag === 0xdf) {
    fields.push({
      path: "type",
      wire_type: "msgpack",
      value: "map",
      inferred: false,
    });
  }
  // Array type: 0x90-0x9f (fixarray), 0xdc (array16), 0xdd (array32)
  else if ((tag >= 0x90 && tag <= 0x9f) || tag === 0xdc || tag === 0xdd) {
    fields.push({
      path: "type",
      wire_type: "msgpack",
      value: "array",
      inferred: false,
    });
  } else {
    fields.push({
      path: "type",
      wire_type: "msgpack",
      value: "unknown",
      inferred: true,
    });
  }
  return {
    decoded_fields: fields,
    truncated: rawPayload.length > 10_000,
  };
}

/** Decode a gRPC frame (5-byte header + protobuf payload). */
export function decodeGrpcFrame(rawPayload: Uint8Array): {
  decoded_fields: DecodedField[];
  truncated: boolean;
} {
  // gRPC uses a 5-byte prefix: 1 byte compressed flag + 4 byte length
  if (rawPayload.length < 5) {
    return {
      decoded_fields: [
        {
          path: "error",
          wire_type: "grpc",
          value: "frame too short",
          inferred: false,
        },
      ],
      truncated: false,
    };
  }
  const compressed = rawPayload[0] !== 0;
  const length =
    ((rawPayload[1] ?? 0) << 24) |
    ((rawPayload[2] ?? 0) << 16) |
    ((rawPayload[3] ?? 0) << 8) |
    (rawPayload[4] ?? 0);
  return {
    decoded_fields: [
      {
        path: "compressed",
        wire_type: "grpc",
        value: compressed,
        inferred: false,
      },
      {
        path: "message_length",
        wire_type: "grpc",
        value: length,
        inferred: false,
      },
    ],
    truncated: length > 10_000,
  };
}

/** Infer schema hypotheses from a set of decoded messages. */
export function inferMessageSchema(
  messages: readonly ProtocolMessage[],
): SchemaHypothesis[] {
  const fieldCounts = new Map<string, { count: number; types: Set<string> }>();
  for (const msg of messages) {
    for (const field of msg.decoded_fields) {
      const existing = fieldCounts.get(field.path);
      if (existing) {
        existing.count++;
        if (field.wire_type) existing.types.add(field.wire_type);
      } else {
        fieldCounts.set(field.path, {
          count: 1,
          types: new Set(field.wire_type ?? "unknown"),
        });
      }
    }
  }
  const hypotheses: SchemaHypothesis[] = [];
  for (const [field_name, data] of fieldCounts) {
    hypotheses.push({
      field_name,
      inferred_type: [...data.types].join("|"),
      confidence: Math.min(1, data.count / messages.length || 0),
      evidence_count: data.count,
    });
  }
  return hypotheses;
}
