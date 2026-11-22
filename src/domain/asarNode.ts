import { z } from "zod";
import { isExactJsonNumber } from "./exactJsonNumber.js";
import { quotedExcerpt } from "./excerpt.js";

/** A declared ASAR member size that can bound a packed content range. */
export const asarDeclaredSizeSchema = z.number().nonnegative().safe();

/** The original spelling of a size that native JSON rounded to an admitted integer. */
export class RoundedAsarSize {
  readonly excerpt: string;

  constructor(source: string) {
    this.excerpt = quotedExcerpt(source, 256);
  }
}

/** Preserve source numbers that would otherwise invent an exact member extent. */
export const retainRoundedAsarSize = (
  owner: Record<string, unknown>,
  value: number,
  source: string,
): void => {
  if (
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !isExactJsonNumber(value === 0 ? 0 : value, source)
  )
    owner.size = new RoundedAsarSize(source);
};

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
