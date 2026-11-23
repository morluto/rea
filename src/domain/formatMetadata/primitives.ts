import { z } from "zod";

export const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const uint32 = z.number().int().min(0).max(0xffff_ffff);
export const uint8 = z.number().int().min(0).max(0xff);
export const uint16 = z.number().int().min(0).max(0xffff);
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);
export const byteRange = z.strictObject({ offset, length: offset });
