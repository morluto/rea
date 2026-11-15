import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";

import { BROWSER_SCENARIO_TOOL_CONTRACTS } from "../contracts/browserScenarioToolContracts.js";
import { advertisedInputJsonSchema } from "../contracts/toolSchemaMetadata.js";

const contract = BROWSER_SCENARIO_TOOL_CONTRACTS.find(
  (candidate) => candidate.name === "capture_browser_scenario",
);
if (contract === undefined)
  throw new Error("capture_browser_scenario is not in its family");

it("advertises the environment variable names a secret may not be given", () => {
  // A `.refine` refuses a name only after the caller sends it. `=` and NUL break
  // the launched process's environment before any action runs, so a client that
  // validates a request against `tools/list` must be able to see that too.
  const advertised = advertisedInputJsonSchema(contract);
  const validate = new Ajv2020({
    strict: false,
    logger: false,
    validateFormats: false,
  }).compile(advertised);
  const request = (environment_variable: string) => ({
    browser: { mode: "launch", executable_path: "/opt/chromium/chrome" },
    start_url: { url: "https://app.example.test/" },
    actions: [
      { step_id: "one", action: "wait_for_timeout", duration_ms: 1000 },
    ],
    secrets: [{ secret_id: "s1", environment_variable }],
  });

  for (const name of ["TOKEN", "PATH", "HTTPS_PROXY"]) {
    expect(contract.inputSchema.safeParse(request(name)).success, name).toBe(
      true,
    );
    expect(validate(request(name)), name).toBe(true);
  }
  for (const name of ["A=B", "=A", "A=", "A\0B"]) {
    expect(
      contract.inputSchema.safeParse(request(name)).success,
      JSON.stringify(name),
    ).toBe(false);
    expect(validate(request(name)), JSON.stringify(name)).toBe(false);
  }
});
