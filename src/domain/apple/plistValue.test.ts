import { expect, it } from "vitest";

import { projectPlistValue } from "./plistValue.js";

it("rejects excessive plist nesting without exhausting the stack", () => {
  const deep: unknown[] = [];
  let cursor = deep;
  for (let depth = 0; depth < 200; depth += 1) {
    const next: unknown[] = [];
    cursor.push(next);
    cursor = next;
  }
  expect(() => projectPlistValue(deep)).toThrow(RangeError);
});
