import { expect, it } from "vitest";
import {
  TOOL_REGISTRATION_OWNERS,
  toolRegistrationCount,
} from "../../scripts/verify/tool-registration-guard.mjs";

it.each([
  ["a plain registration", "server.registerTool(contract.name, options, run);"],
  [
    "a typed registration",
    "server.registerTool<typeof output, typeof input>(name, options, run);",
  ],
  ["a spaced typed registration", "super.registerTool <Out, In> (name, o, r);"],
  [
    "a multi-line registration",
    "server\n  .registerTool(\n    contract.name,\n    options,\n    run,\n  );",
  ],
])("counts %s", (_name, content) => {
  expect(toolRegistrationCount(content)).toBe(1);
});

it.each([
  ["a declaration", "override registerTool<Out, In>(name: string) {}"],
  ["a mention in text", 'const name = "registerTool";'],
  ["another method", "server.registerTools(bindings);"],
])("ignores %s", (_name, content) => {
  expect(toolRegistrationCount(content)).toBe(0);
});

it("states why each owner may register tools", () => {
  for (const reason of TOOL_REGISTRATION_OWNERS.values())
    expect(reason).not.toBe("");
});
