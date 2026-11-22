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

const immutableValidation = new WeakMap<object, string | undefined>();

/** Validate JSON meaning and nesting without cloning a trusted immutable value. */
export const jsonValueValidationIssue = (root: unknown): string | undefined => {
  const steps = jsonValueValidationSteps(root);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
};

/** Check a validated value's nesting without queuing whole containers. */
export const jsonValueExceedsDepth = (
  root: JsonValue,
  limit: number,
): boolean => {
  type DepthFrame =
    | {
        readonly kind: "array";
        readonly value: readonly JsonValue[];
        index: number;
      }
    | {
        readonly kind: "object";
        readonly value: Record<string, JsonValue>;
        readonly keys: readonly string[];
        index: number;
      };
  const frames: DepthFrame[] = [];
  let value: JsonValue = root;
  let depth = 0;
  let inspect = true;
  for (;;) {
    if (inspect) {
      if (depth > limit) return true;
      if (Array.isArray(value)) {
        if (value.length > 0)
          frames.push({ kind: "array", value, index: 0 });
      } else if (isRecord(value)) {
        const keys = Object.keys(value);
        if (keys.length > 0)
          frames.push({ kind: "object", value, keys, index: 0 });
      }
      inspect = false;
      continue;
    }
    const frame = frames[frames.length - 1];
    if (frame === undefined) return false;
    if (frame.kind === "array") {
      if (frame.index >= frame.value.length) {
        frames.pop();
        continue;
      }
      value = frame.value[frame.index++]!;
      depth = frames.length;
      inspect = true;
      continue;
    }
    if (frame.index >= frame.keys.length) {
      frames.pop();
      continue;
    }
    value = frame.value[frame.keys[frame.index++]!]!;
    depth = frames.length;
    inspect = true;
  }
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
        readonly keys: readonly string[];
        index: number;
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
          keys: Object.keys(value),
          index: 0,
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

    if (frame.index >= frame.keys.length) {
      pending.pop();
      continue;
    }
    const key = frame.keys[frame.index++]!;
    const descriptor = Object.getOwnPropertyDescriptor(frame.value, key);
    if (descriptor?.enumerable !== true) continue;
    if (!Object.hasOwn(descriptor, "value"))
      return finish("JSON objects cannot contain accessors");
    value = descriptor.value;
    depth = frame.depth + 1;
    inspect = true;
  }
}

const copyJsonValue = (
  value: JsonValue,
  borrowImmutable: boolean,
): JsonValue => {
  const immutableCandidate: unknown = value;
  if (borrowImmutable && isImmutableJsonSnapshot(immutableCandidate))
    return value;
  if (Array.isArray(value)) {
    const length = value.length;
    const copy = new Array<JsonValue>(length);
    for (let index = 0; index < length; index += 1)
      copy[index] = copyJsonValue(value[index]!, borrowImmutable);
    return copy;
  }
  if (value !== null && typeof value === "object") {
    const copy: Record<string, JsonValue> = {};
    const keys = Object.keys(value);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      const copied = copyJsonValue(value[key]!, borrowImmutable);
      if (key === "__proto__")
        Object.defineProperty(copy, key, {
          value: copied,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      else copy[key] = copied;
    }
    return copy;
  }
  return value;
};

const preserveJsonValue = (value: JsonValue): JsonValue =>
  copyJsonValue(value, true);

const detachJsonValue = (value: JsonValue): JsonValue =>
  copyJsonValue(value, false);

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

/** Parse bounded JSON into detached mutable copies, cloning sealed subtrees. */
export const detachedJsonValueSchema = z
  .unknown()
  .nonoptional()
  .pipe(validatedJsonValue)
  .transform(detachJsonValue);
detachedJsonValueSchema._zod.toJSONSchema = () => ({});

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

/** Detached JSON object boundary for mutable caller exports. */
export const detachedJsonObjectSchema =
  detachedJsonValueSchema.pipe(objectValidation);
detachedJsonObjectSchema._zod.toJSONSchema = objectProjection;

/** Validate an exclusively owned JSON object while retaining its existing tree. */
export const ownedJsonObjectSchema =
  ownedJsonValueSchema.pipe(objectValidation);
ownedJsonObjectSchema._zod.toJSONSchema = objectProjection;
