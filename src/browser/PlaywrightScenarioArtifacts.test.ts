import { expect, it } from "vitest";
import type { BrowserContext, Page } from "playwright-core";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import { capturePlaywrightStepArtifacts } from "./PlaywrightScenarioArtifacts.js";

const scenario = browserScenarioSchema.parse({
  browser: {
    mode: "launch",
    executable_path: "/opt/chromium",
  },
  start_url: { url: "https://app.example.test/" },
  allowed_origins: ["https://app.example.test"],
  actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
});
const secrets = BrowserScenarioSecrets.resolve(scenario, {});
if (secrets === undefined)
  throw new Error("Expected resolved scenario secrets");

it("returns a complete requested text artifact beyond the former inline ceiling", async () => {
  const page = {
    url: () => "https://app.example.test/",
    content: () => Promise.resolve("x".repeat(16 * 1_024 * 1_024 + 1)),
  } as unknown as Page;

  const result = await capturePlaywrightStepArtifacts({
    context: {} as BrowserContext,
    page,
    scenario,
    secrets,
    requested: new Set(["dom"]),
  });
  expect(result.dom).toMatchObject({
    state: "captured",
    value: { bytes: 16 * 1_024 * 1_024 + 1 },
  });
});

it("redacts declared secrets from current and historical URL artifacts", async () => {
  const secretValue = "rea browser+verifier";
  const scenarioWithSecretUrl = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "/opt/chromium" },
    start_url: {
      url: "https://app.example.test/",
      query: [
        {
          name: "token",
          value: { source: "secret", secret_id: "url_token" },
        },
      ],
    },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
    secrets: [
      {
        secret_id: "url_token",
        environment_variable: "REA_URL_TOKEN",
      },
    ],
    capture: { at_end: ["url", "history"] },
  });
  const scenarioSecrets = BrowserScenarioSecrets.resolve(
    scenarioWithSecretUrl,
    {
      REA_URL_TOKEN: secretValue,
    },
  );
  if (scenarioSecrets === undefined)
    throw new Error("Expected resolved URL secret");
  const query = new URLSearchParams([["token", secretValue]]).toString();
  const url = `https://app.example.test/?${query}#${encodeURIComponent(secretValue)}`;
  const page = {
    url: () => url,
    evaluate: async () => ({
      length: 1,
      navigation_entries: [{ type: "navigate", name: url }],
    }),
  } as unknown as Page;

  const result = await capturePlaywrightStepArtifacts({
    context: {} as BrowserContext,
    page,
    scenario: scenarioWithSecretUrl,
    secrets: scenarioSecrets,
    requested: new Set(["url", "history"]),
  });

  expect(
    JSON.stringify({ url: result.url, history: result.history }),
  ).not.toContain(secretValue);
  expect(result.url).toMatchObject({
    state: "captured",
    value: {
      redacted: true,
      url: "https://app.example.test/?token=[REDACTED:url_token]#[REDACTED:url_token]",
    },
  });
  expect(result.history).toMatchObject({
    state: "captured",
    value: {
      current_url: {
        redacted: true,
        url: "https://app.example.test/?token=[REDACTED:url_token]#[REDACTED:url_token]",
      },
      navigation_entries: [
        {
          name: {
            redacted: true,
            url: "https://app.example.test/?token=[REDACTED:url_token]#[REDACTED:url_token]",
          },
        },
      ],
    },
  });
});
