import { z } from "zod";

/**
 * PE locations name their space in the field: `rva` (relative to the image
 * base), `va` (image base plus RVA, the address providers accept) and
 * `file_offset` or a `location` range (bytes in the file).
 */
export const peVaSchema = z.string().regex(/^0x[0-9a-f]+$/u);

/** Optional so that Evidence saved before the field existed still parses. */
export const peImageBaseSchema = peVaSchema
  .optional()
  .describe(
    "Optional-header ImageBase as a hex VA; a VA field is this plus the matching RVA",
  );

/** Lowercase hex VA of `rva` in an image loaded at `imageBase`. */
export const peVa = (imageBase: bigint, rva: number): string =>
  `0x${(imageBase + BigInt(rva)).toString(16)}`;

export const peImageBaseHex = (imageBase: bigint): string =>
  `0x${imageBase.toString(16)}`;
