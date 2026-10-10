import { createHash } from "node:crypto";

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

it("redacts DOM and accessibility spellings before computing artifact identity", async () => {
  const scenarioSecrets = BrowserScenarioSecrets.resolve(
    browserScenarioSchema.parse({
      ...scenario,
      secrets: [
        { secret_id: "text_token", environment_variable: "REA_TEXT_TOKEN" },
        { secret_id: "link_token", environment_variable: "REA_LINK_TOKEN" },
        { secret_id: "field_token", environment_variable: "REA_FIELD_TOKEN" },
      ],
    }),
    {
      REA_TEXT_TOKEN: "SECRET-a&b-7f3a",
      REA_LINK_TOKEN: "SECRET c8 7f3a",
      REA_FIELD_TOKEN: 'SECRET-"field"-7f3a',
    },
  );
  if (scenarioSecrets === undefined)
    throw new Error("Expected resolved secrets");
  const dom =
    '<p>seen SECRET-a&amp;b-7f3a</p><a href="/next?t=SECRET%20c8%207f3a&amp;plain=kept">go</a><input value="SECRET-&quot;field&quot;-7f3a">';
  const accessibility =
    '- paragraph: seen SECRET-a&b-7f3a\n- link "go":\n  - /url: /next?t=SECRET%20c8%207f3a&plain=kept';
  const page = {
    url: () => "https://app.example.test/",
    content: async () => dom,
    locator: () => ({ ariaSnapshot: async () => accessibility }),
  } as unknown as Page;
  const input = {
    context: {} as BrowserContext,
    page,
    requested: new Set(["dom", "accessibility"] as const),
  };
  const result = await capturePlaywrightStepArtifacts({
    ...input,
    secrets: scenarioSecrets,
  });
  const expected = {
    dom: '<p>seen [REDACTED:text_token]</p><a href="/next?t=[REDACTED:link_token]&amp;plain=kept">go</a><input value="[REDACTED:field_token]">',
    accessibility:
      '- paragraph: seen [REDACTED:text_token]\n- link "go":\n  - /url: /next?t=[REDACTED:link_token]&plain=kept',
  };
  for (const kind of ["dom", "accessibility"] as const) {
    expect(result[kind]).toEqual({
      state: "captured",
      value: {
        text: expected[kind],
        bytes: Buffer.byteLength(expected[kind]),
        sha256: createHash("sha256").update(expected[kind]).digest("hex"),
      },
    });
  }
  const control = await capturePlaywrightStepArtifacts({ ...input, secrets });
  expect(control.dom).toMatchObject({
    state: "captured",
    value: { text: dom },
  });
  expect(control.accessibility).toMatchObject({
    state: "captured",
    value: { text: accessibility },
  });
});

it("records empty artifact identity if replacement reconstructs a secret", async () => {
  const scenarioSecrets = BrowserScenarioSecrets.resolve(
    browserScenarioSchema.parse({
      ...scenario,
      secrets: [
        { secret_id: "foo", environment_variable: "REA_FOO" },
        { secret_id: "collision", environment_variable: "REA_COLLISION" },
      ],
    }),
    { REA_FOO: "X", REA_COLLISION: "a[REDACTED:foo]b" },
  );
  if (scenarioSecrets === undefined)
    throw new Error("Expected resolved secrets");
  const page = {
    url: () => "https://app.example.test/",
    content: async () => "aXb",
    locator: () => ({ ariaSnapshot: async () => "aXb" }),
  } as unknown as Page;
  const result = await capturePlaywrightStepArtifacts({
    context: {} as BrowserContext,
    page,
    secrets: scenarioSecrets,
    requested: new Set(["dom", "accessibility"]),
  });
  for (const kind of ["dom", "accessibility"] as const)
    expect(result[kind]).toEqual({
      state: "captured",
      value: {
        text: "",
        bytes: 0,
        sha256: createHash("sha256").update("").digest("hex"),
      },
    });
});
