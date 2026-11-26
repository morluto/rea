import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";

import { BROWSER_SCENARIO_TOOL_CONTRACTS } from "../contracts/browserScenarioToolContracts.js";
import { advertisedInputJsonSchema } from "../contracts/toolSchemaMetadata.js";

const contract = BROWSER_SCENARIO_TOOL_CONTRACTS.find(
  (candidate) => candidate.name === "capture_browser_scenario",
);
if (contract === undefined)
  throw new Error("capture_browser_scenario is not in its family");

it("advertises the request header names a page's fetch cannot set", () => {
  // The refinement refuses these only after a request is sent; a client that
  // validates against `tools/list` sees the same rule through `not.pattern`.
  const validate = new Ajv2020({
    strict: false,
    logger: false,
    validateFormats: false,
  }).compile(advertisedInputJsonSchema(contract));
  const request = (name: string) => ({
    browser: { mode: "launch", executable_path: "/opt/chromium/chrome" },
    start_url: { url: "https://app.example.test/" },
    actions: [
      {
        step_id: "one",
        action: "request",
        method: "GET",
        path: "/api/items",
        headers: [{ name, value: { source: "literal", value: "v" } }],
      },
    ],
  });

  for (const name of ["Accept", "X-Requested-With", "cookies", "X-Sec-Id"]) {
    expect(contract.inputSchema.safeParse(request(name)).success, name).toBe(
      true,
    );
    expect(validate(request(name)), name).toBe(true);
  }
  for (const name of [
    "Cookie",
    "HOST",
    "te",
    "Proxy-Authorization",
    "sec-ch-ua",
  ]) {
    expect(contract.inputSchema.safeParse(request(name)).success, name).toBe(
      false,
    );
    expect(validate(request(name)), name).toBe(false);
  }
});
