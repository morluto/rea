import { expect, it } from "vitest";

import { ghidraReplyEnvelope } from "./protocol.js";

const failure = (error: Record<string, unknown>) => {
  const parsed = ghidraReplyEnvelope.parse(
    JSON.stringify({ id: 3, ok: false, error }),
  );
  if (!parsed.ok) throw parsed.error;
  return ghidraReplyEnvelope.remoteFailure(parsed.value);
};

it("keeps every candidate the bridge sends for an ambiguous selector", () => {
  expect(
    failure({
      code: "procedure_ambiguous",
      message: "Ghidra procedure name is ambiguous: work",
      candidates: ["0x1000", "0x1300"],
    }),
  ).toMatchObject({
    code: "procedure_ambiguous",
    candidates: ["0x1000", "0x1300"],
  });
  expect(
    failure({ code: "procedure_not_found", message: "Unknown" })?.candidates,
  ).toBeUndefined();
});

it("refuses a candidate list that cannot describe an ambiguity", () => {
  expect(
    ghidraReplyEnvelope.parse(
      JSON.stringify({
        id: 3,
        ok: false,
        error: {
          code: "procedure_ambiguous",
          message: "Ghidra procedure name is ambiguous: work",
          candidates: ["0x1000"],
        },
      }),
    ).ok,
  ).toBe(false);
});
