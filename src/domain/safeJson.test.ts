import { expect, it } from "vitest";

import { safeParseJson } from "./safeJson.js";

it("keeps the original JSON parse failure as the cause", () => {
  const parsed = safeParseJson("{");

  if (parsed.ok) throw new Error("expected invalid JSON to fail");
  expect(parsed.error).toContain("JSON");
  expect(parsed.cause).toBeInstanceOf(SyntaxError);
});
