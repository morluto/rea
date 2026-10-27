import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";

/** Borrow the dictionary shape; selected payloads receive JSON validation in the adapter. */
const structuredContentSchema = z.custom<Record<string, unknown>>((value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
});

/** IDA/JEB's object-structured envelope; each adapter owns selection and error policy. */
export const mcpToolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: structuredContentSchema.optional(),
  content: z.array(
    z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
  ),
});

export const mcpTextBlocks = (
  content: z.infer<typeof mcpToolResultSchema>["content"],
): string[] =>
  content.flatMap((block) =>
    block.type === "text" && block.text !== undefined ? [block.text] : [],
  );

/** Preserve ordinary text when the selected upstream payload is not valid JSON. */
export const parseMcpJsonOrText = (text: string): JsonValue => {
  try {
    return jsonValueSchema.parse(JSON.parse(text));
  } catch {
    return text;
  }
};
