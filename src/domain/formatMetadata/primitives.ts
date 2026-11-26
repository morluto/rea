import { z } from "zod";

export const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const uint32 = z.number().int().min(0).max(0xffff_ffff);
export const uint8 = z.number().int().min(0).max(0xff);
export const uint16 = z.number().int().min(0).max(0xffff);
/** An unsigned 64-bit value as a decimal string; JSON numbers cannot hold it exactly. */
export const uint64Decimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);
export const byteRange = z.strictObject({ offset, length: offset });
