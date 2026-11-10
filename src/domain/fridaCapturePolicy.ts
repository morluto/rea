import { z } from "zod";
import { MAX_JSON_DEPTH } from "./jsonValue.js";

/** Payload nesting reserves the enclosing message, status and Evidence containers. */
export const FRIDA_CAPTURE_MAX_JSON_DEPTH = MAX_JSON_DEPTH - 8;

const CAPTURE_POLICY_DESCRIPTION =
  "Retention budgets selected before attaching or spawning, fixed for this session. Defaults: 16 MiB session, 4 KiB type, 32 KiB error text, 250000 JSON nodes and depth64. Session bytes include JSON/base64 expansion and capture metadata; a budget too small for one event retains no event. Raising these cannot recover already discarded observations or raise MCP/client delivery limits. Select larger budgets before a new explicitly chosen experiment; no REA restart is required.";

/** Capture policy is accepted before attachment and remains fixed for that session. */
export const fridaCapturePolicySchema = z
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

/** Request fields preserve omission; defaults are resolved only by the session owner. */
export const fridaCapturePolicyInputSchema = z
  .strictObject({
    session_bytes: fridaCapturePolicySchema.shape.session_bytes
      .removeDefault()
      .optional(),
    message_type_bytes: fridaCapturePolicySchema.shape.message_type_bytes
      .removeDefault()
      .optional(),
    message_text_bytes: fridaCapturePolicySchema.shape.message_text_bytes
      .removeDefault()
      .optional(),
    json_nodes: fridaCapturePolicySchema.shape.json_nodes
      .removeDefault()
      .optional(),
    json_depth: fridaCapturePolicySchema.shape.json_depth
      .removeDefault()
      .optional(),
  })
  .describe(CAPTURE_POLICY_DESCRIPTION);

export type FridaCapturePolicy = z.output<typeof fridaCapturePolicySchema>;
export type FridaCapturePolicyInput = z.input<
  typeof fridaCapturePolicyInputSchema
>;
export const DEFAULT_FRIDA_CAPTURE_POLICY = Object.freeze(
  fridaCapturePolicySchema.parse({}),
);
