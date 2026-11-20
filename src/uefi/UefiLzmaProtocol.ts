import { z } from "zod";

import { digestSchema } from "../domain/digests.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";

const decodeFailureReasonSchema = z.enum(["format", "decoder", "output-limit"]);
export type UefiDecodeFailureReason = z.infer<typeof decodeFailureReasonSchema>;

export const lzmaRequestSchema = z.strictObject({
  format: z.enum(["lzma", "lzmaf86"]),
  payload_path: z.string(),
  output_path: z.string(),
  reply_path: z.string(),
  max_output_bytes: z
    .number()
    .int()
    .min(1)
    .max(UEFI_FIRMWARE_LIMITS.lzmaOutputBytes),
});

export const lzmaReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    lzma_version: z.string(),
    input_bytes_consumed: z
      .number()
      .int()
      .min(1)
      .max(UEFI_FIRMWARE_LIMITS.inputBytes),
    output: z.strictObject({
      sha256: digestSchema,
      bytes: z.number().int().min(0),
    }),
  }),
  z.strictObject({
    ok: z.literal(false),
    reason: decodeFailureReasonSchema,
    message: z.string(),
  }),
]);

export type UefiLzmaReply = z.infer<typeof lzmaReplySchema>;
