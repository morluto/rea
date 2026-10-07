// Fixture-backed action coverage; real Electron verification lives in
// `npm run verify:electron`.
import { expect, it } from "vitest";

import {
  electronActiveObservationInputSchema,
  electronActiveObservationResultSchema,
} from "../domain/javascript/electronActiveObservation.js";
import { createElectronActiveObservationFixtureResult } from "../domain/javascript/electronActiveObservation.fixture.js";
import { runElectronActions } from "./PlaywrightElectronActiveActions.js";

it("parses window, renderer, and deep-link actions for agents", () => {
  const input = electronActiveObservationInputSchema.parse({
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
  });

  expect(result.success).toBe(false);
});

it("keeps long Electron arguments and deep-link URLs intact", () => {
  const longArgument = "x".repeat(5_000);
  const longUrl = `rea-fixture://open/${"item".repeat(2_000)}`;
  const longStepId = "step".repeat(100);
  const input = electronActiveObservationInputSchema.parse({
    executable_path: "/opt/electron",
    application_path: "/opt/app/main.js",
    application_root: "/opt/app",
    args: [longArgument],
    actions: [
      {
        step_id: longStepId,
        kind: "deep-link",
        delivery: "open-url",
        url: longUrl,
      },
    ],
  });

  expect(input.args).toEqual([longArgument]);
  expect(input.actions[0]).toMatchObject({
    step_id: longStepId,
    url: longUrl,
  });
  expect(
    electronActiveObservationResultSchema.parse({
      ...createElectronActiveObservationFixtureResult("/opt/app"),
      actions: [
        {
          step_id: longStepId,
          kind: "deep-link",
          window_index: null,
          target: null,
          status: "completed",
          elapsed_ms: 0,
          error: null,
        },
      ],
    }).actions[0]?.step_id,
  ).toBe(longStepId);
});

it("preserves local Playwright action diagnostics", async () => {
  const selector = "#secret-selector";
  const input = electronActiveObservationInputSchema.parse({
    executable_path: "/opt/electron",
    application_path: "/opt/app/main.js",
    application_root: "/opt/app",
    actions: [{ step_id: "click-step", kind: "click", selector }],
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

  const result = await runElectronActions(application as never, input, {});

  expect(result[0]).toMatchObject({
    status: "failed",
    error: `locator ${selector} failed with token=raw-secret`,
  });
  expect(result[0]?.error).toContain(selector);
  expect(result[0]?.error).toContain("raw-secret");
});

it("retains complete action errors and Electron window text", async () => {
  const longError = `locator failed ${"detail ".repeat(300)}`;
  const input = electronActiveObservationInputSchema.parse({
    executable_path: "/opt/electron",
    application_path: "/opt/app/main.js",
    application_root: "/opt/app",
    actions: [{ step_id: "click-step", kind: "click", selector: "#run" }],
  });
  const page = {
    locator: () => ({
      click: async () => Promise.reject(new Error(longError)),
    }),
  };
  const actions = await runElectronActions(
    { windows: () => [page] } as never,
    input,
    {},
  );
  const result = createElectronActiveObservationFixtureResult("/opt/app");
  const longUrl = `file://${"/segment".repeat(10_000)}`;
  const longTitle = "title".repeat(4_000);

  expect(actions[0]?.error).toBe(longError);
  expect(
    electronActiveObservationResultSchema.parse({
      ...result,
      windows: [{ ...result.windows[0], url: longUrl, title: longTitle }],
      actions: [
        {
          step_id: "click-step",
          kind: "click",
          window_index: 0,
          target: "window:0",
          status: "failed",
          elapsed_ms: 1,
          error: longError,
        },
      ],
    }).windows[0],
  ).toMatchObject({ url: longUrl, title: longTitle });
});

it("accepts complete Electron input and observation strings", () => {
  const longText = "evidence-".repeat(3_000);
  const longPath = `/opt/${"directory/".repeat(2_000)}app`;
  const input = electronActiveObservationInputSchema.parse({
    executable_path: longPath,
    application_path: `${longPath}/main.js`,
    application_root: longPath,
    actions: [
      { step_id: longText, kind: "click", selector: longText },
      {
        step_id: longText,
        kind: "deep-link",
        delivery: "open-url",
        url: `custom://${longText}`,
      },
    ],
  });
  const fixture = createElectronActiveObservationFixtureResult("/opt/app");
  const event = {
    ...fixture.ipc.events[0],
    correlation_id: longText,
    event: longText,
    channel: longText,
    sender: longText,
    receiver: longText,
    frame: longText,
    target: longText,
    result_shape: longText,
    process_type: longText,
    source: longText,
    artifact_path: longPath,
  };
  const result = electronActiveObservationResultSchema.parse({
    ...fixture,
    application: {
      ...fixture.application,
      application_path: longPath,
      electron_version: longText,
    },
    actions: [
      {
        ...fixture.actions[0],
        step_id: longText,
        target: longText,
        error: longText,
        status: "failed",
      },
    ],
    windows: [
      {
        ...fixture.windows[0],
        window_id: longText,
        web_contents_id: longText,
        url: longText,
        title: longText,
      },
    ],
    ipc: { events: [event], observed: 1 },
    timeline: {
      events: [
        {
          ...event,
          kind: "navigation",
          phase: "observed",
          direction: null,
          capture_method: "event-emitter",
        },
      ],
      observed: 1,
    },
    limitations: [longText],
  });

  expect(input.actions[0]?.step_id).toBe(longText);
  expect(input.actions[0]?.kind === "click" && input.actions[0].selector).toBe(
    longText,
  );
  expect(result.ipc.events[0]?.channel).toBe(longText);
  expect(result.windows[0]?.title).toBe(longText);
  expect(result.limitations[0]).toBe(longText);
});

it("runs an untargeted deep-link without requiring a BrowserWindow", async () => {
  const input = electronActiveObservationInputSchema.parse({
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
  });
  const application = {
    windows: () => [],
    evaluate: async () => true,
  };

  const result = await runElectronActions(application as never, input, {});

  expect(result).toMatchObject([
    {
      step_id: "open-deep-link",
      status: "completed",
      error: null,
    },
  ]);
});

it("honors caller-selected Electron waits beyond the former action timeout", async () => {
  const input = electronActiveObservationInputSchema.parse({
    executable_path: "/opt/electron",
    application_path: "/opt/app/main.js",
    application_root: "/opt/app",
    actions: [{ step_id: "wait-long", kind: "wait", duration_ms: 60_000 }],
  });
  let duration = 0;
  const page = {
    waitForTimeout: async (value: number) => {
      duration = value;
    },
  };
  const application = {
    windows: () => [page],
    firstWindow: async () => page,
  };

  const result = await runElectronActions(application as never, input, {});

  expect(result[0]).toMatchObject({ status: "completed" });
  expect(duration).toBe(60_000);
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
