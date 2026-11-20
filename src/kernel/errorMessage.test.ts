import { expect, it } from "vitest";

import { errorMessage } from "./errorMessage.js";

it("uses an Error's message and stringifies any other caught value", () => {
  expect(errorMessage(new TypeError("bad input"))).toBe("bad input");
  expect(errorMessage("plain text")).toBe("plain text");
  expect(errorMessage(42)).toBe("42");
  expect(errorMessage(undefined)).toBe("undefined");
});
