import { types } from "node:util";
import { z } from "zod";
import { isImmutableJsonSnapshot } from "./immutableJson.js";
import { isRecord } from "../kernel/isRecord.js";

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

/**
 * Structural equality for admitted JSON. Object keys are unordered, array
 * elements are ordered, and undefined is the sentinel for an absent root.
 */
export const equalJsonValues = (
  left: JsonValue | undefined,
  right: JsonValue | undefined,
): boolean => {
  if (left === right) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++)
      if (!equalJsonValues(left[index], right[index])) return false;
    return true;
  }
  if (Array.isArray(right)) return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys)
    if (
      !Object.prototype.propertyIsEnumerable.call(right, key) ||
      !equalJsonValues(left[key], right[key])
    )
      return false;
  return true;
};

/** Whether a UTF-16 code unit can continue a JSON number or literal token. */
const jsonTokenUnit = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) || // 0-9
  (code >= 0x41 && code <= 0x5a) || // A-Z
  (code >= 0x61 && code <= 0x7a) || // a-z
  code === 0x2b || // +
  code === 0x2d || // -
  code === 0x2e; // .

/**
 * How many values `JSON.parse(source)` would allocate (objects, arrays,
 * strings including member names, numbers, booleans and nulls), counted in
 * one scan without building them. Counting stops at `limit + 1`, so a caller
 * can refuse a document whose decoded tree would outgrow its text before
 * parsing it. Ill-formed text returns an approximate count; `JSON.parse`
 * still reports the syntax failure.
 */
export const countJsonValues = (source: string, limit: number): number => {
  let values = 0;
  let inString = false;
  let inToken = false;
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (inString) {
      if (code === 0x5c) index++;
      else if (code === 0x22) inString = false;
      continue;
    }
    if (jsonTokenUnit(code)) {
      if (inToken) continue;
      inToken = true;
    } else {
      inToken = false;
      if (code === 0x22) inString = true;
      else if (code !== 0x7b && code !== 0x5b) continue;
    }
    values++;
    if (values > limit) return values;
  }
  return values;
};

const immutableValidation = new WeakMap<object, string | undefined>();

/** Validate JSON meaning and nesting without cloning a trusted immutable value. */
export const jsonValueValidationIssue = (root: unknown): string | undefined => {
  const steps = jsonValueValidationSteps(root);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
};

function* ownEnumerableKeys(value: Record<string, unknown>): Generator<string> {
  for (const key in value) if (Object.hasOwn(value, key)) yield key;
}

function* jsonObjectValues(
  record: Record<string, JsonValue>,
): Generator<JsonValue> {
  for (const key of ownEnumerableKeys(record)) yield record[key]!;
}

/** Check a validated value's nesting without queuing whole containers. */
export const jsonValueExceedsDepth = (
  root: JsonValue,
  limit: number,
): boolean => {
  const levels: Iterator<JsonValue>[] = [[root].values()];
  for (let level = levels.at(-1); level !== undefined; level = levels.at(-1)) {
    const next = level.next();
    if (next.done === true) levels.pop();
    else if (levels.length - 1 > limit) return true;
    else if (Array.isArray(next.value)) levels.push(next.value.values());
    else if (isRecord(next.value)) levels.push(jsonObjectValues(next.value));
  }
  return false;
};

/** Validate JSON in bounded steps; cache only authenticated immutable roots. */
export function* jsonValueValidationSteps(
  root: unknown,
): Generator<void, string | undefined> {
  const immutable =
    typeof root === "object" && root !== null && isImmutableJsonSnapshot(root)
      ? root
      : undefined;
  if (immutable !== undefined && immutableValidation.has(immutable))
    return immutableValidation.get(immutable);
  const finish = (issue: string | undefined): string | undefined => {
    if (immutable !== undefined) immutableValidation.set(immutable, issue);
    return issue;
  };
  type Frame =
    | {
        readonly kind: "array";
        readonly value: unknown[];
        readonly depth: number;
        index: number;
      }
    | {
        readonly kind: "object";
        readonly value: Record<string, unknown>;
        readonly depth: number;
        readonly keys: Generator<string>;
      };
  const pending: Frame[] = [];
  let value = root;
  let depth = 0;
  let inspect = true;
  let examined = 0;
  for (;;) {
    if (inspect) {
      if (examined++ === 4096) {
        examined = 0;
        yield;
      }
      if (depth > MAX_JSON_DEPTH)
        return finish(
          `JSON value exceeds maximum nesting depth of ${MAX_JSON_DEPTH}. This release has no runtime override.`,
        );
      if (typeof value === "object" && value !== null && types.isProxy(value))
        return finish("JSON values cannot contain proxies");
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean"
      ) {
        inspect = false;
      } else if (typeof value === "number") {
        if (!Number.isFinite(value))
          return finish("JSON numbers must be finite");
        inspect = false;
      } else if (Array.isArray(value)) {
        pending.push({
          kind: "array",
          value,
          depth,
          index: 0,
        });
        inspect = false;
      } else if (isRecord(value)) {
        const prototype: unknown = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
          return finish("JSON objects require ordinary data properties");
        for (const key of Object.getOwnPropertySymbols(value))
          if (Object.getOwnPropertyDescriptor(value, key)?.enumerable === true)
            return finish("JSON object keys must be strings");
        pending.push({
          kind: "object",
          value,
          depth,
          keys: ownEnumerableKeys(value),
        });
        inspect = false;
      } else return finish("Invalid JSON value");
      continue;
    }

    const frame = pending[pending.length - 1];
    if (frame === undefined) return finish(undefined);
    if (frame.kind === "array") {
      if (frame.index >= frame.value.length) {
        pending.pop();
        continue;
      }
      const index = frame.index++;
      const descriptor = Object.getOwnPropertyDescriptor(frame.value, index);
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
        return finish(
          "JSON arrays require dense data properties without accessors",
        );
      value = descriptor.value;
      depth = frame.depth + 1;
      inspect = true;
      continue;
    }

    const next = frame.keys.next();
    if (next.done) {
      pending.pop();
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(frame.value, next.value);
    if (descriptor?.enumerable !== true) continue;
    if (!Object.hasOwn(descriptor, "value"))
      return finish("JSON objects cannot contain accessors");
    value = descriptor.value;
    depth = frame.depth + 1;
    inspect = true;
  }
}

const preserveJsonValue = (value: JsonValue): JsonValue => {
  const immutableCandidate: unknown = value;
  if (isImmutableJsonSnapshot(immutableCandidate)) return value;
  if (Array.isArray(value)) {
    const copy: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1)
      copy.push(preserveJsonValue(value[index]!));
    return copy;
  }
  if (value !== null && typeof value === "object") {
    const copy: Record<string, JsonValue> = {};
    for (const key of ownEnumerableKeys(value))
      Object.defineProperty(copy, key, {
        value: preserveJsonValue(value[key]!),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    return copy;
  }
  return value;
};

const validatedJsonValue = z
  .unknown()
  .superRefine((value, context) => {
    const issue = jsonValueValidationIssue(value);
    if (issue !== undefined)
      context.addIssue({ code: "custom", message: issue, continue: false });
  })
  .transform((value) => value as JsonValue);
// Keep both stages nonrecursive in public and Standard Schema projections.
validatedJsonValue._zod.toJSONSchema = () => ({});

/** Parse bounded JSON and retain all own data members without prototype setters. */
export const jsonValueSchema = z
  .unknown()
  .nonoptional()
  .pipe(validatedJsonValue)
  .transform(preserveJsonValue);
jsonValueSchema._zod.toJSONSchema = () => ({});

/** Validate JSON that the current boundary exclusively owns, without a second full-tree copy. */
export const ownedJsonValueSchema = z
  .unknown()
  .nonoptional()
  .pipe(validatedJsonValue);
ownedJsonValueSchema._zod.toJSONSchema = () => ({});

const objectValidation = z.custom<Record<string, JsonValue>>(
  isRecord,
  "Expected JSON object",
);
const objectProjection = () => ({ type: "object", additionalProperties: {} });
objectValidation._zod.toJSONSchema = objectProjection;

/** JSON object boundary for caller-visible parameter maps. */
export const jsonObjectSchema = jsonValueSchema.pipe(objectValidation);
jsonObjectSchema._zod.toJSONSchema = objectProjection;

/** Validate an exclusively owned JSON object while retaining its existing tree. */
export const ownedJsonObjectSchema =
  ownedJsonValueSchema.pipe(objectValidation);
ownedJsonObjectSchema._zod.toJSONSchema = objectProjection;
