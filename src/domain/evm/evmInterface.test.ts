import { expect, it } from "vitest";
import { evmInterfaceSchema } from "./evmInterface.js";
import { evmInterfaceFixture } from "../../../tests/fixtures/evm/interface.js";

it("preserves original carrier and decoded byte identity as distinct observations", () => {
  const fixture = evmInterfaceFixture();
  expect(evmInterfaceSchema.parse(fixture)).toEqual(fixture);
  expect(fixture.artifact.sha256).not.toBe(fixture.bytecode.sha256);
});
it.each(["byte-count", "body-offset", "selector", "authenticity"])(
  "rejects false interface evidence: %s",
  (problem) => {
    const value = evmInterfaceFixture();
    const raw = {
      ...value,
      ...(problem === "authenticity"
        ? {
            bytecode: {
              ...value.bytecode,
              deployment_authenticity: "verified",
            },
          }
        : {}),
    };
    if (problem === "byte-count") raw.bytecode.bytes++;
    if (problem === "body-offset" || problem === "selector")
      raw.functions.push({
        selector: problem === "selector" ? "bad" : "0xaabbccdd",
        bytecode_offset: problem === "body-offset" ? 5 : 0,
        dispatch: "abi",
        inferred_arguments: null,
        inferred_state_mutability: null,
      });
    expect(evmInterfaceSchema.safeParse(raw).success).toBe(false);
  },
);
