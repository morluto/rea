import { expect, it } from "vitest";

import { SESSION_TOOL_CONTRACTS } from "../../../src/contracts/sessionToolContracts.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";

it("borrows SDK Evidence inputs while leaving ordinary request constraints active", async () => {
  const contract = SESSION_TOOL_CONTRACTS.find(
    ({ name }) => name === "build_call_path",
  );
  if (contract?.name !== "build_call_path")
    throw new Error("Expected the build_call_path contract");
  const registration = toolRegistrationOptions(contract);
  const source = Object.defineProperty({}, "normalized_result", {
    enumerable: true,
    get: () => {
      throw new Error("SDK must not clone the unadmitted payload");
    },
  });
  const input = {
    functions: [source],
    start: { address: "0x1000" },
    goal: { address: "0x1001" },
  };
  const validated = await registration.inputSchema["~standard"].validate(input);
  if (validated.issues !== undefined) throw new Error("valid frame rejected");
  expect(validated.value.functions[0]).toBe(source);
  const invalid = await registration.inputSchema["~standard"].validate({
    ...input,
    start: { address: 1 },
  });
  expect(invalid.issues).toEqual([
    expect.objectContaining({ path: ["start", "address"] }),
  ]);
});
