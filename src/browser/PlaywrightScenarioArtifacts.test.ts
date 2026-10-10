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

it.each([
  ["SECRET: 'token'", "SECRET: ''token''"],
  ['SECRET-"token', String.raw`SECRET-\"token`],
  [String.raw`SECRET-\token`, String.raw`SECRET-\\token`],
  ["SECRET-\u0001-token", String.raw`SECRET-\x01-token`],
  ["SECRET-\u0085-token", String.raw`SECRET-\x85-token`],
  ["SECRET-\u00a0-token", "SECRET- -token"],
  ["SECRET-\u200b-token", "SECRET--token"],
  ["SECRET-\u00ad-token", "SECRET--token"],
  [" SECRET-\t-token ", "SECRET- -token"],
] as const)(
  "redacts %j serialized as %j in accessibility text",
  async (secretValue, serializedValue) => {
    const declaredSecrets = BrowserScenarioSecrets.resolve(
      browserScenarioSchema.parse({
        ...scenario,
        secrets: [{ secret_id: "token", environment_variable: "REA_TOKEN" }],
      }),
      { REA_TOKEN: secretValue },
    );
    if (declaredSecrets === undefined)
      throw new Error("Expected resolved secret");
    const input = `before ${serializedValue} after`;
    const expected = "before [REDACTED] after";
    const page = {
      locator: () => ({ ariaSnapshot: async () => input }),
    } as unknown as Page;

    const result = await capturePlaywrightStepArtifacts({
      context: {} as BrowserContext,
      page,
      secrets: declaredSecrets,
      requested: new Set(["accessibility"]),
    });

    expect(result.accessibility).toEqual({
      state: "captured",
      value: {
        text: expected,
        bytes: Buffer.byteLength(expected),
        sha256: createHash("sha256").update(expected).digest("hex"),
      },
    });
  },
);

it("preserves unrelated snapshot text and ignores empty normalized secrets", async () => {
  const declaredSecrets = BrowserScenarioSecrets.resolve(
    browserScenarioSchema.parse({
      ...scenario,
      secrets: [
        { secret_id: "long", environment_variable: "REA_LONG" },
        { secret_id: "short", environment_variable: "REA_SHORT" },
        { secret_id: "empty", environment_variable: "REA_EMPTY" },
        { secret_id: "invisible", environment_variable: "REA_INVISIBLE" },
      ],
    }),
    {
      REA_LONG: 'SECRET-"token',
      REA_SHORT: "SECRET",
      REA_EMPTY: "",
      REA_INVISIBLE: "\u200b",
    },
  );
  if (declaredSecrets === undefined)
    throw new Error("Expected resolved secrets");
  const input = String.raw`- button "SECRET-\"token"
- link "Ordinary destination":
  - /url: /ordinary?mode=selected`;
  const expected = `- button "[REDACTED]"
- link "Ordinary destination":
  - /url: /ordinary?mode=selected`;
  const page = {
    locator: () => ({ ariaSnapshot: async () => input }),
  } as unknown as Page;
  const result = await capturePlaywrightStepArtifacts({
    context: {} as BrowserContext,
    page,
    secrets: declaredSecrets,
    requested: new Set(["accessibility"]),
  });
  expect(result.accessibility).toMatchObject({
    state: "captured",
    value: { text: expected },
  });
});

it("keeps accessibility whitespace normalization out of DOM redaction", async () => {
  const declaredSecrets = BrowserScenarioSecrets.resolve(
    browserScenarioSchema.parse({
      ...scenario,
      secrets: [
        { secret_id: "space", environment_variable: "REA_SPACE" },
        { secret_id: "invisible", environment_variable: "REA_INVISIBLE" },
      ],
    }),
    { REA_SPACE: "SECRET\u00a0TOKEN", REA_INVISIBLE: "\u200b" },
  );
  if (declaredSecrets === undefined)
    throw new Error("Expected resolved secrets");
  const input = "SECRET TOKEN ordinary evidence";
  const page = { content: async () => input } as unknown as Page;
  const result = await capturePlaywrightStepArtifacts({
    context: {} as BrowserContext,
    page,
    secrets: declaredSecrets,
    requested: new Set(["dom"]),
  });
  expect(result.dom).toMatchObject({
    state: "captured",
    value: { text: input },
  });
});

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
