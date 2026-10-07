import { expect, it } from "vitest";
import type { Page } from "playwright-core";

import { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import { performPlaywrightScenarioAction } from "./PlaywrightScenarioActions.js";
import { browserScenarioSchema } from "../domain/browserScenario.js";

it("uses exact accessible-name matching without a caller confirmation field", async () => {
  const scenario = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "/opt/chromium/chrome" },
    start_url: { url: "https://app.example.test/" },
    actions: [
      {
        step_id: "submit",
        action: "click",
        locator: { kind: "role", role: "button", name: "Submit" },
      },
    ],
  });
  const calls: unknown[][] = [];
  const page = {
    getByRole: (...args: unknown[]) => {
      calls.push(args);
      return { click: async () => undefined };
    },
  } as unknown as Page;
  const secrets = BrowserScenarioSecrets.resolve(scenario, {});
  if (secrets === undefined) throw new Error("No secret declarations expected");
  const action = scenario.actions.at(0);
  if (action === undefined) throw new Error("Expected one scenario action");

  await performPlaywrightScenarioAction({
    page,
    action,
    secrets,
  });

  expect(calls).toEqual([["button", { name: "Submit", exact: true }]]);
});
