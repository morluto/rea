import { expect, it } from "vitest";

import {
  electronActiveObservationInputSchema,
  electronActiveObservationResultSchema,
} from "../../../src/domain/electronActiveObservation.js";
import { runElectronActions } from "../../../src/browser/PlaywrightElectronActiveActions.js";
import { createElectronActiveObservationFixtureResult } from "../../fixtures/electronActiveObservationResult.js";

it("parses bounded window, renderer, and deep-link actions for agents", () => {
  const input = electronActiveObservationInputSchema.parse({
    schema_version: 1,
    executable_path: "/opt/electron",
    application_path: "/opt/app/main.js",
    application_root: "/opt/app",
    actions: [
      { step_id: "first-window", kind: "click", selector: "#run" },
      { step_id: "second-window", kind: "renderer-reload", window_index: 1 },
      { step_id: "restart", kind: "renderer-crash", window_index: 1 },
      {
        step_id: "deep-link",
        kind: "deep-link",
        delivery: "second-instance",
        url: "rea-fixture://open/item",
      },
    ],
    approved: true,
  });

  expect(input.actions).toEqual([
    {
      step_id: "first-window",
      kind: "click",
      selector: "#run",
      window_index: 0,
    },
    { step_id: "second-window", kind: "renderer-reload", window_index: 1 },
    { step_id: "restart", kind: "renderer-crash", window_index: 1 },
    {
      step_id: "deep-link",
      kind: "deep-link",
      delivery: "second-instance",
      url: "rea-fixture://open/item",
    },
  ]);
});

it("rejects non-absolute deep-link values", () => {
  const result = electronActiveObservationInputSchema.safeParse({
    schema_version: 1,
    executable_path: "/opt/electron",
    application_path: "/opt/app/main.js",
    application_root: "/opt/app",
    actions: [
      {
        step_id: "bad-link",
        kind: "deep-link",
        delivery: "open-url",
        url: "not a URL",
      },
    ],
    approved: true,
  });

  expect(result.success).toBe(false);
});

it("redacts action inputs from Playwright failures", async () => {
  const selector = "#secret-selector";
  const input = electronActiveObservationInputSchema.parse({
    schema_version: 1,
    executable_path: "/opt/electron",
    application_path: "/opt/app/main.js",
    application_root: "/opt/app",
    actions: [{ step_id: "click-step", kind: "click", selector }],
    approved: true,
  });
  const page = {
    locator: () => ({
      click: async () => {
        throw new Error(`locator ${selector} failed with token=raw-secret`);
      },
    }),
  };
  const application = {
    windows: () => [page],
  };

  const result = await runElectronActions(
    application as never,
    input,
    {},
    Date.now() + 1_000,
  );

  expect(result[0]).toMatchObject({
    status: "failed",
    error: "locator <redacted-input> failed with token=[REDACTED]",
  });
  expect(result[0]?.error).not.toContain(selector);
  expect(result[0]?.error).not.toContain("raw-secret");
});

it("runs an untargeted deep-link without requiring a BrowserWindow", async () => {
  const input = electronActiveObservationInputSchema.parse({
    schema_version: 1,
    executable_path: "/opt/electron",
    application_path: "/opt/app/main.js",
    application_root: "/opt/app",
    actions: [
      {
        step_id: "open-deep-link",
        kind: "deep-link",
        delivery: "second-instance",
        url: "rea-fixture://open/item",
      },
    ],
    approved: true,
  });
  const application = {
    windows: () => [],
    evaluate: async () => true,
  };

  const result = await runElectronActions(
    application as never,
    input,
    {},
    Date.now() + 1_000,
  );

  expect(result).toMatchObject([
    {
      step_id: "open-deep-link",
      status: "completed",
      error: null,
    },
  ]);
});

it("rejects action outcomes that disagree with their error state", () => {
  const result = createElectronActiveObservationFixtureResult("/opt/app");
  const action = result.actions[0];
  expect(action).toBeDefined();
  if (action === undefined) return;

  expect(
    electronActiveObservationResultSchema.safeParse({
      ...result,
      actions: [{ ...action, error: "unexpected failure" }],
    }).success,
  ).toBe(false);
  expect(
    electronActiveObservationResultSchema.safeParse({
      ...result,
      actions: [{ ...action, status: "failed", error: null }],
    }).success,
  ).toBe(false);
});
