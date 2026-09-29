import { expect, it } from "vitest";
import type { BrowserContext, Page } from "playwright-core";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import { capturePlaywrightStepArtifacts } from "./PlaywrightScenarioArtifacts.js";

const scenario = browserScenarioSchema.parse({
  browser: {
    mode: "launch",
    executable_path: "/opt/chromium",
    headless: true,
    user_data: "temporary-owned",
    cleanup: "close-and-delete-profile",
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

it("wraps URL, history, and storage snapshots in the capture state contract", async () => {
  const page = {
    url: () => "https://app.example.test/path?token=secret",
    evaluate: async (expression: string) =>
      expression.includes("window.history.length")
        ? {
            length: 2,
            navigation_entries: [
              { type: "navigate", name: "https://app.example.test/path" },
            ],
          }
        : { local_storage: [], session_storage: [] },
  } as unknown as Page;
  const context = { cookies: async () => [] } as unknown as BrowserContext;

  const result = await capturePlaywrightStepArtifacts({
    context,
    page,
    scenario,
    secrets,
    requested: new Set(["url", "history", "storage"]),
  });

  expect(result.url.state).toBe("captured");
  expect(result.history.state).toBe("captured");
  expect(result.storage.state).toBe("captured");
});
