import { z } from "zod";
import { addressCoordinate } from "./addressCoordinate.js";
import { AnalysisInputError } from "../analysisErrorCore.js";
import { err, ok, type Result } from "../result.js";

/** Byte pairs, with whole-byte wildcards; explicit masks can select individual bits. */
export const bytePatternFields = {
  pattern: z
    .string()
    .regex(/^([0-9a-fA-F]{2}|\?\?)(\s*([0-9a-fA-F]{2}|\?\?))*$/u),
  mask: z
    .string()
    .regex(/^[0-9a-fA-F]{2}(\s*[0-9a-fA-F]{2})*$/u)
    .optional(),
};

/** Parse once at the input boundary, retaining typed correction issues. */
export const parseBytePattern = (
  pattern: string,
  mask?: string,
): Result<{ bytes: number[]; masks: number[] }, AnalysisInputError> => {
  const invalid = (field: string, message: string) =>
    err(
      new AnalysisInputError("search_bytes", undefined, [
        { path: [field], reason: "invalid_value", message },
      ]),
    );
  if (!bytePatternFields.pattern.safeParse(pattern).success)
    return invalid("pattern", "Use hexadecimal byte pairs or ?? wildcards");
  if (mask !== undefined && !bytePatternFields.mask.safeParse(mask).success)
    return invalid("mask", "Use hexadecimal mask byte pairs");
  const pairs = pattern.replace(/\s/gu, "").match(/../gu) ?? [];
  const maskPairs = mask?.replace(/\s/gu, "").match(/../gu);
  if (maskPairs && maskPairs.length !== pairs.length)
    return invalid("mask", "Mask length must equal pattern length");
  const bytes = pairs.map((pair) =>
    pair === "??" ? 0 : Number.parseInt(pair, 16),
  );
  const masks = pairs.map((pair, index) =>
    pair === "??" ? 0 : Number.parseInt(maskPairs?.[index] ?? "ff", 16),
  );
  if (!masks.some((value) => value !== 0))
    return invalid("pattern", "Pattern must constrain at least one bit");
  return ok({ bytes, masks });
};

/** Shared semantic validation for public and provider inputs. */
export const validateBytePattern = (
  value: { pattern: string; mask?: string | undefined },
  context: z.RefinementCtx,
): void => {
  const parsed = parseBytePattern(value.pattern, value.mask);
  if (!parsed.ok)
    for (const issue of parsed.error.issues)
      context.addIssue({
        code: "custom",
        path: [...issue.path],
        message: issue.message ?? "Invalid byte pattern",
      });
};

const coverageBlock = z
  .strictObject({
    segment: z.string(),
    start: z.string(),
    end: z.string(),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine((value, context) => {
    const start = addressCoordinate(value.start);
    const end = addressCoordinate(value.end);
    if (
      start === null ||
      end === null ||
      start.space !== end.space ||
      start.offset > end.offset ||
      end.offset - start.offset + 1n !== BigInt(value.bytes)
    )
      context.addIssue({
        code: "custom",
        message:
          "Byte coverage must equal its inclusive address range in one space",
      });
  });

/** Inclusive page coverage; matches never span memory blocks. */
export const byteSearchResultSchema = z
  .strictObject({
    matches: z
      .array(
        z.strictObject({
          address: z.string(),
          segment: z.string(),
          file_offset: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER)
            .nullable(),
          procedure: z
            .strictObject({ address: z.string(), name: z.string() })
            .nullable(),
        }),
      )
      .max(1000),
    searched: z.strictObject({
      blocks: z.array(coverageBlock),
      bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      skipped_uninitialized: z.array(coverageBlock),
      skipped_not_loaded: z.array(coverageBlock),
    }),
    complete: z.boolean(),
    next_cursor: z.string().min(1).nullable(),
  })
  .superRefine((value, context) => {
    if (
      value.complete !== (value.next_cursor === null) ||
      value.searched.bytes !==
        value.searched.blocks.reduce((sum, block) => sum + block.bytes, 0)
    )
      context.addIssue({
        code: "custom",
        message: "Byte search coverage and continuation disagree",
      });
  });
