import { describe, expect, it } from "vitest";
import {
  freezeOwnedJsonSnapshotSteps,
  isImmutableJsonSnapshot,
} from "./immutableJson.js";
import { jsonValueValidationIssue, type JsonValue } from "./jsonValue.js";

const complete = <Value>(steps: Iterator<void, Value>): Value => {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
};

describe("cooperative owned snapshot sealing", () => {
  it("locks reachable edges before yielding and authenticates only completion", () => {
    const deferred: { [key: string]: JsonValue } = { value: 1 };
    const value = {
      deferred,
      many: Array.from({ length: 10_000 }, () => ({ value: 1 })),
    };
    const steps = freezeOwnedJsonSnapshotSteps(value);
    expect(steps.next().done).toBe(false);
    expect(Object.isFrozen(value)).toBe(true);
    expect(isImmutableJsonSnapshot(value)).toBe(false);
    const introduced = { value: 2 };
    deferred.child = introduced;
    expect(complete(steps)).toBe(value);
    expect(Object.isFrozen(introduced)).toBe(true);
    expect(isImmutableJsonSnapshot(value)).toBe(true);
    expect(jsonValueValidationIssue(value)).toBeUndefined();
  });

  it("never authenticates abandoned or invalid provisional roots", () => {
    const deferred: { [key: string]: JsonValue } = { value: 1 };
    const value = {
      deferred,
      many: Array.from({ length: 10_000 }, () => ({ value: 1 })),
    };
    const steps = freezeOwnedJsonSnapshotSteps(value);
    expect(steps.next().done).toBe(false);
    deferred.value = Number.NaN;
    expect(() => complete(steps)).toThrow();
    expect(isImmutableJsonSnapshot(value)).toBe(false);
    const cancelled = {
      values: Array.from({ length: 10_000 }, () => ({ value: 1 })),
    };
    const interrupted = freezeOwnedJsonSnapshotSteps(cancelled);
    expect(interrupted.next().done).toBe(false);
    interrupted.return(cancelled);
    expect(isImmutableJsonSnapshot(cancelled)).toBe(false);
  });

  it("preserves aliases and rejects accessors, sparse values and cycles", () => {
    const shared = { value: 1 };
    const value = { a: shared, b: shared };
    complete(freezeOwnedJsonSnapshotSteps(value));
    expect(Object.isFrozen(shared)).toBe(true);
    const sparse: JsonValue[] = [];
    sparse.length = 2;
    const cycle: { [key: string]: JsonValue } = {};
    cycle.self = cycle;
    let accessed = false;
    const accessor = {
      get value() {
        accessed = true;
        return 1;
      },
    };
    for (const malformed of [sparse, cycle, accessor]) {
      expect(() => complete(freezeOwnedJsonSnapshotSteps(malformed))).toThrow();
      expect(isImmutableJsonSnapshot(malformed)).toBe(false);
    }
    expect(accessed).toBe(false);
  });

  it("does not cache validation of a caller's shallow freeze", () => {
    const value = Object.freeze({ child: { value: 1 } });
    expect(jsonValueValidationIssue(value)).toBeUndefined();
    value.child.value = Number.NaN;
    expect(jsonValueValidationIssue(value)).toBe("JSON numbers must be finite");
  });
});
