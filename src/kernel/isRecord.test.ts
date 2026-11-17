import { expect, expectTypeOf, it } from "vitest";

import { isRecord } from "./isRecord.js";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

it("accepts non-null objects other than arrays", () => {
  expect(isRecord({})).toBe(true);
  expect(isRecord(Object.create(null))).toBe(true);
  expect(isRecord(new Error("x"))).toBe(true);
  expect(isRecord([])).toBe(false);
  expect(isRecord(null)).toBe(false);
  expect(isRecord(undefined)).toBe(false);
  expect(isRecord("text")).toBe(false);
  expect(isRecord(() => undefined)).toBe(false);
});

it("narrows a JSON value to its object member and unknown to a string-keyed record", () => {
  const json = JSON.parse('{"a":1}') as JsonValue;
  if (isRecord(json))
    expectTypeOf(json.a).toEqualTypeOf<JsonValue | undefined>();
  const value: unknown = json;
  if (isRecord(value))
    expectTypeOf(value).toEqualTypeOf<Record<string, unknown>>();
});
