import { z } from "zod";
import { MAX_JSON_DEPTH } from "./jsonValue.js";

/** Payload nesting reserves the enclosing message, status and Evidence containers. */
export const FRIDA_CAPTURE_MAX_JSON_DEPTH = MAX_JSON_DEPTH - 8;

const CAPTURE_POLICY_DESCRIPTION =
  "Retention budgets selected before attaching or spawning, fixed for this session. Defaults: 16 MiB session, 4 KiB type, 32 KiB error text, 250000 JSON nodes and depth64. Session bytes include JSON/base64 expansion and capture metadata; a budget too small for one event retains no event. Raising these cannot recover already discarded observations or raise MCP/client delivery limits. Select larger budgets before a new explicitly chosen experiment; no REA restart is required.";

/** Defaults belong to the session owner, before attachment. */
const sessionCapturePolicySchema = z
  .strictObject({
    session_bytes: z
      .int()
      .positive()
      .default(16 * 1024 * 1024),
    message_type_bytes: z
      .int()
      .positive()
      .default(4 * 1024),
    message_text_bytes: z
      .int()
      .positive()
      .default(32 * 1024),
    json_nodes: z.int().positive().default(250_000),
    json_depth: z.int().min(1).max(FRIDA_CAPTURE_MAX_JSON_DEPTH).default(64),
  })
  .describe(CAPTURE_POLICY_DESCRIPTION);

/** Observations report a full policy or omit it; omitted facts have no defaults. */
export const fridaCapturePolicySchema = z
  .strictObject({
    session_bytes:
      sessionCapturePolicySchema.shape.session_bytes.removeDefault(),
    message_type_bytes:
      sessionCapturePolicySchema.shape.message_type_bytes.removeDefault(),
    message_text_bytes:
      sessionCapturePolicySchema.shape.message_text_bytes.removeDefault(),
    json_nodes: sessionCapturePolicySchema.shape.json_nodes.removeDefault(),
    json_depth: sessionCapturePolicySchema.shape.json_depth.removeDefault(),
  })
  .describe(
    "Retention budgets reported by the session owner. An omitted policy is unknown.",
  );

/** Request fields preserve omission; defaults are resolved only by the session owner. */
export const fridaCapturePolicyInputSchema = fridaCapturePolicySchema
  .partial()
  .describe(CAPTURE_POLICY_DESCRIPTION);

export const resolveFridaCapturePolicy = (input: unknown) =>
  sessionCapturePolicySchema.safeParse(input);

export type FridaCapturePolicy = z.output<typeof fridaCapturePolicySchema>;
export type FridaCapturePolicyInput = z.input<
  typeof fridaCapturePolicyInputSchema
>;
