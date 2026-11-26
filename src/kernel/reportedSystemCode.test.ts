import { expect, it } from "vitest";
import {
  reportedSystemCode,
  systemCodeFromError,
} from "./reportedSystemCode.js";

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

it("requires an Error only at Error-specific boundaries", () => {
  const record = { code: "EPIPE" };
  expect(reportedSystemCode(record)).toBe("EPIPE");
  expect(systemCodeFromError(record)).toBeUndefined();
  expect(systemCodeFromError(Object.assign(new Error(), record))).toBe("EPIPE");
});
