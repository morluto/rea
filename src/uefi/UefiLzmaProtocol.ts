import { Buffer } from "node:buffer";
import { z } from "zod";

import { digestSchema } from "../domain/digests.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";

const decodeFailureReasonSchema = z.enum(["format", "decoder", "output-limit"]);
export type UefiDecodeFailureReason = z.infer<typeof decodeFailureReasonSchema>;

export const LZMA_FRAME_HEADER_BYTES = 8;

export const lzmaStreamRequestSchema = z.strictObject({
  format: z.enum(["lzma", "lzmaf86"]),
  max_output_bytes: z
    .number()
    .int()
    .min(1)
    .max(UEFI_FIRMWARE_LIMITS.lzmaOutputBytes),
});

export type UefiLzmaStreamRequest = z.infer<typeof lzmaStreamRequestSchema>;

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

/** Encode `[u32BE jsonBytes][u32BE bodyBytes][jsonUtf8][body]` for framed stdio IPC. */
export const encodeLzmaFrame = (
  headerJson: string,
  body: Buffer = Buffer.alloc(0),
): Buffer => {
  const jsonBuf = Buffer.from(headerJson, "utf8");
  const frame = Buffer.allocUnsafe(
    LZMA_FRAME_HEADER_BYTES + jsonBuf.length + body.length,
  );
  frame.writeUInt32BE(jsonBuf.length, 0);
  frame.writeUInt32BE(body.length, 4);
  jsonBuf.copy(frame, LZMA_FRAME_HEADER_BYTES);
  if (body.length > 0) {
    body.copy(frame, LZMA_FRAME_HEADER_BYTES + jsonBuf.length);
  }
  return frame;
};
