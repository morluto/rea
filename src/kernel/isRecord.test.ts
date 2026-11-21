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
  const json: JsonValue = JSON.parse('{"a":1}');
  if (!isRecord(json)) throw new Error("Expected a JSON object");
  expect(json.a).toBe(1);
  expectTypeOf(json.a).toEqualTypeOf<JsonValue | undefined>();

  const withoutPrototype: unknown = Object.create(null);
  if (!isRecord(withoutPrototype))
    throw new Error("Expected an object without a prototype");
  expectTypeOf(withoutPrototype).toEqualTypeOf<Record<string, unknown>>();
  expect(isRecord(new Error("x"))).toBe(true);
  expect(isRecord([])).toBe(false);
  expect(isRecord(null)).toBe(false);
  expect(isRecord(undefined)).toBe(false);
  expect(isRecord("text")).toBe(false);
  expect(isRecord(() => undefined)).toBe(false);
});
