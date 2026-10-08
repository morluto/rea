import { describe, expect, it } from "vitest";

import type { JsonValue } from "./jsonValue.js";
import {
  freezeJsonSnapshot,
  isImmutableJsonSnapshot,
} from "./immutableJson.js";

describe("owned immutable JSON snapshots", () => {
  it("seals reachable data and preserves repeated references", () => {
    const shared = { values: [1, "observed"] };
    const value = { left: shared, right: shared };
    const encoded = JSON.stringify(value);
    expect(freezeJsonSnapshot(value)).toBe(value);
    expect(value.left).toBe(value.right);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(shared.values)).toBe(true);
    expect(Reflect.set(shared.values, 0, 9)).toBe(false);
    expect(JSON.stringify(value)).toBe(encoded);
    expect(isImmutableJsonSnapshot(value)).toBe(true);
  });

  it("does not mistake a shallow freeze for validated immutable data", () => {
    const value = Object.freeze({ nested: { value: 1 } });
    expect(isImmutableJsonSnapshot(value)).toBe(false);
    freezeJsonSnapshot(value);
    expect(Object.isFrozen(value.nested)).toBe(true);
    expect(isImmutableJsonSnapshot(value)).toBe(true);
  });

  it("composes sealed roots without changing the nested data or authenticating a shallow freeze", () => {
    const nested = freezeJsonSnapshot({ values: [1, "observed"] });
    const outer = freezeJsonSnapshot({ nested });
    expect(outer.nested).toBe(nested);
    expect(Object.isFrozen(outer)).toBe(true);
    expect(Object.isFrozen(nested.values)).toBe(true);
    expect(isImmutableJsonSnapshot(outer)).toBe(true);
    expect(isImmutableJsonSnapshot(nested)).toBe(true);
    const unowned = Object.freeze({ nested: { value: 1 } });
    expect(isImmutableJsonSnapshot(unowned)).toBe(false);
  });

  it("rejects cycles without registering or partially freezing the snapshot", () => {
    const value: Record<string, JsonValue> = {};
    value.self = value;
    expect(() => freezeJsonSnapshot(value)).toThrow("circular");
    expect(isImmutableJsonSnapshot(value)).toBe(false);
    expect(Object.isFrozen(value)).toBe(false);
  });

  it("rejects mutable accessor behavior and sparse arrays", () => {
    const accessor = {
      get value() {
        return 1;
      },
    };
    expect(() => freezeJsonSnapshot(accessor)).toThrow("accessors");
    expect(isImmutableJsonSnapshot(accessor)).toBe(false);
    expect(() => freezeJsonSnapshot(new Array<number>(2))).toThrow("sparse");
    expect(() => freezeJsonSnapshot({ number: Number.NaN })).toThrow(
      "JSON values",
    );
  });
});
