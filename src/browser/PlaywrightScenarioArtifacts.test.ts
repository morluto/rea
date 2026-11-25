import { expect, it, vi } from "vitest";
import type { BrowserContext, Page } from "playwright-core";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import { resolveScenarioSecrets } from "../../tests/fixtures/browserScenarioSecrets.js";
import { capturePlaywrightStepArtifacts } from "./PlaywrightScenarioArtifacts.js";

const scenario = browserScenarioSchema.parse({
  browser: {
    mode: "launch",
    executable_path: "/opt/chromium",
  },
  start_url: { url: "https://app.example.test/" },
  actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
});
const secrets = resolveScenarioSecrets(scenario, {});

// Text artifacts have no inline size ceiling; the content is returned whole.
it("returns a large requested text artifact complete", async () => {
  const text = `${"x".repeat(16 * 1_024 * 1_024)}!`;
  const page = { content: async () => text } as unknown as Page;

  const result = await capturePlaywrightStepArtifacts({
    context: {} as BrowserContext,
    page,
    secrets,
    requested: new Set(["dom"]),
  });
  if (result.dom.state !== "captured") throw new Error("Expected captured DOM");
  expect(result.dom.value.bytes).toBe(16 * 1_024 * 1_024 + 1);
  expect(result.dom.value.text.length).toBe(text.length);
  expect(result.dom.value.text.at(-1)).toBe("!");
});

it("redacts declared secrets from current and historical URL artifacts", async () => {
  const secretValue = "rea browser+verifier";
  const scenarioWithSecretUrl = browserScenarioSchema.parse({
    ...scenario,
    start_url: {
      url: "https://app.example.test/",
      query: [
        {
          name: "token",
          value: { source: "secret", secret_id: "url_token" },
        },
      ],
    },
    secrets: [
      {
        secret_id: "url_token",
        environment_variable: "REA_URL_TOKEN",
      },
    ],
    capture: { at_end: ["url", "history"] },
  });
  const scenarioSecrets = resolveScenarioSecrets(scenarioWithSecretUrl, {
    REA_URL_TOKEN: secretValue,
  });
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
  const sanitizedUrl = {
    redacted: true,
    url: "https://app.example.test/?token=[REDACTED:url_token]#[REDACTED:url_token]",
  };
  expect(result.url).toMatchObject({ state: "captured", value: sanitizedUrl });
  expect(result.history).toMatchObject({
    state: "captured",
    value: {
      length: 1,
      current_url: sanitizedUrl,
      navigation_entries: [{ type: "navigate", name: sanitizedUrl }],
    },
  });
});

it("redacts a declared secret used as a cookie or storage name", async () => {
  const secretValue = "session-token";
  const scenarioWithSecret = browserScenarioSchema.parse({
    ...scenario,
    secrets: [
      { secret_id: "storage_key", environment_variable: "REA_STORAGE_KEY" },
    ],
  });
  const scenarioSecrets = resolveScenarioSecrets(scenarioWithSecret, {
    REA_STORAGE_KEY: secretValue,
  });
  const page = {
    url: () => "https://app.example.test/",
    evaluate: async () => ({
      local_storage: [[secretValue, "kept-value"]],
      session_storage: [["theme", secretValue]],
    }),
  } as unknown as Page;
  const context = {
    cookies: async () => [
      {
        name: secretValue,
        value: "ordinary",
        domain: "app.example.test",
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "Lax" as const,
      },
    ],
  } as unknown as BrowserContext;

  const result = await capturePlaywrightStepArtifacts({
    context,
    page,
    secrets: scenarioSecrets,
    requested: new Set(["storage"]),
  });

  expect(JSON.stringify(result.storage)).not.toContain(secretValue);
  expect(result.storage).toMatchObject({
    state: "captured",
    value: {
      cookies: [{ name: "[REDACTED:storage_key]", value_state: "hashed" }],
      local_storage: [
        { name: "[REDACTED:storage_key]", value_state: "hashed" },
      ],
      session_storage: [
        { name: "theme", value_state: "redacted-secret", value_sha256: null },
      ],
    },
  });
});

const request = {
  step_id: "request",
  action: "request",
  method: "POST",
  path: "/api/items",
};
const savedToken = [{ name: "token", json_pointer: "/token", secret: true }];
const ui = {
  step_id: "ui",
  locator: { kind: "css", selector: "#save" },
  save_response: { method: "POST", path: "/api/items", save: savedToken },
};
const screenshotPrivacyCases: readonly {
  readonly source: string;
  readonly action?: unknown;
  readonly supplied?: "declared" | "saved";
}[] = [
  { source: "a declared value", supplied: "declared" },
  { source: "a saved value", supplied: "saved" },
  {
    source: "a planned request response",
    action: { ...request, save: savedToken },
  },
  { source: "a planned click response", action: { ...ui, action: "click" } },
  {
    source: "a planned press response",
    action: { ...ui, action: "press", key: "Enter" },
  },
  ...[
    { source: "cookie", name: "session" },
    { source: "local_storage", key: "session" },
    {
      source: "basic_credentials",
      parts: [
        { source: "literal", value: "user" },
        { source: "cookie", name: "password" },
      ],
    },
  ].map((value) => ({
    source: `planned ${value.source} authentication`,
    action: { ...request, headers: [{ name: "Authorization", value }] },
  })),
];

it.each(screenshotPrivacyCases)(
  "withholds requested pixels for $source",
  async ({ action, supplied }) => {
    const selected = browserScenarioSchema.parse({
      ...scenario,
      actions: action === undefined ? scenario.actions : [action],
      secrets:
        supplied === "declared"
          ? [{ secret_id: "token", environment_variable: "TOKEN" }]
          : [],
    });
    const value = "pixel-token-729a";
    const protectedSecrets = resolveScenarioSecrets(
      selected,
      supplied === "declared" ? { TOKEN: value } : {},
    );
    if (supplied === "saved")
      protectedSecrets.save("response.token", "token", value, true);
    const screenshot = vi.fn<Page["screenshot"]>();
    const result = await capturePlaywrightStepArtifacts({
      page: { screenshot } as unknown as Page,
      context: {} as BrowserContext,
      secrets: protectedSecrets,
      requested: new Set(["screenshot"]),
    });
    expect(result.screenshot).toMatchObject({
      state: "missing",
      reason: expect.stringContaining("sensitive"),
    });
    expect(screenshot).not.toHaveBeenCalled();
  },
);

it("preserves requested pixels when saved response values are not marked sensitive", async () => {
  const selected = browserScenarioSchema.parse({
    ...scenario,
    actions: [
      {
        ...request,
        save: [{ name: "id", json_pointer: "/id", secret: false }],
      },
    ],
  });
  const pixels = Buffer.from("public pixels");
  const screenshot = vi.fn(async () => pixels);
  const result = await capturePlaywrightStepArtifacts({
    page: { screenshot } as unknown as Page,
    context: {} as BrowserContext,
    secrets: resolveScenarioSecrets(selected, {}),
    requested: new Set(["screenshot"]),
  });
  expect(result.screenshot).toMatchObject({
    state: "captured",
    value: { data_base64: pixels.toString("base64") },
  });
  expect(screenshot).toHaveBeenCalledTimes(1);
});
