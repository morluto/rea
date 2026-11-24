import { expect, it } from "vitest";

import { nativeInstructionSchema } from "./nativeInstruction.js";

it("admits only instruction statuses a provider reports", () => {
  const status = nativeInstructionSchema.shape.status;
  expect(status.safeParse("not-in-listing").success).toBe(true);
  expect(status.safeParse("undecodable").success).toBe(false);
});
