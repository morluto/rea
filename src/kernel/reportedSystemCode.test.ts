import { expect, it } from "vitest";
import { reportedSystemCode } from "./reportedSystemCode.js";

it("reads a reported code once and preserves an empty string", () => {
  let reads = 0;
  const cause = {
    get code() {
      return ++reads === 1 ? "" : undefined;
    },
  };
  expect(reportedSystemCode(cause)).toBe("");
  expect(reads).toBe(1);
});
