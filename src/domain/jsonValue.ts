import { z } from "zod";

/** Maximum JSON nesting accepted before recursive result cloning. */
export const MAX_JSON_DEPTH = 1000;

/** JSON-safe value shared by domain, application, and adapter boundaries. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const recordShape = z.record(z.string(), z.unknown());

const jsonValidationIssue = (root: unknown): string | undefined => {
  const pending: { value: unknown; depth: number }[] = [
    { value: root, depth: 0 },
  ];
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) break;
    if (item.depth > MAX_JSON_DEPTH)
      return `JSON value exceeds maximum nesting depth of ${MAX_JSON_DEPTH}`;
    const value = item.value;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return "JSON numbers must be finite";
    } else if (Array.isArray(value)) {
      for (const child of value)
        pending.push({ value: child, depth: item.depth + 1 });
    } else if (isRecord(value) && recordShape.safeParse(value).success) {
      // Inspect every own member, including keys Zod's record parser skips.
      for (const child of Object.values(value))
        pending.push({ value: child, depth: item.depth + 1 });
    } else return "Invalid JSON value";
  }
  return undefined;
};

const preserveJsonValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(preserveJsonValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries<JsonValue>(
      Object.entries(value).map(([key, child]) => [
        key,
        preserveJsonValue(child),
      ]),
    );
  return value;
};

const validatedJsonValue = z.custom<JsonValue>(
  (value) => jsonValidationIssue(value) === undefined,
  {
    error: (issue) => jsonValidationIssue(issue.input) ?? "Invalid JSON value",
  },
);
// Keep both stages nonrecursive in public and Standard Schema projections.
validatedJsonValue._zod.toJSONSchema = () => ({});

/** Parse bounded JSON and retain all own data members without prototype setters. */
export const jsonValueSchema = z
  .unknown()
  .nonoptional()
  .pipe(validatedJsonValue)
  .transform(preserveJsonValue);
jsonValueSchema._zod.toJSONSchema = () => ({});

const objectValidation = z.custom<Record<string, JsonValue>>(
  isRecord,
  "Expected JSON object",
);
const objectProjection = () => ({ type: "object", additionalProperties: {} });
objectValidation._zod.toJSONSchema = objectProjection;

/** JSON object boundary for caller-visible parameter maps. */
export const jsonObjectSchema = jsonValueSchema.pipe(objectValidation);
jsonObjectSchema._zod.toJSONSchema = objectProjection;
