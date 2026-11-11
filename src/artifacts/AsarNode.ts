import { z } from "zod";

/** A declared ASAR member size that can bound a packed content range. */
export const asarDeclaredSizeSchema = z.number().nonnegative().safe();

/** Shared ASAR node declarations; consumers select only the fields they interpret. */
export const asarNodeSchema = z.looseObject({
  files: z
    .custom<Record<string, unknown>>(
      (value) =>
        value !== null && typeof value === "object" && !Array.isArray(value),
    )
    .optional(),
  link: z.string().optional(),
  size: asarDeclaredSizeSchema.optional(),
  offset: z.string().optional(),
  unpacked: z.boolean().optional(),
  executable: z.boolean().optional(),
  integrity: z
    .looseObject({ algorithm: z.string(), hash: z.string() })
    .optional(),
});
