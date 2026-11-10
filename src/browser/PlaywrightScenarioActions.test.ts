import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import type { BrowserScenarioAction } from "../domain/browserScenarioValues.js";
import { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import {
  BrowserScenarioLocatorError,
  performPlaywrightScenarioAction,
} from "./PlaywrightScenarioActions.js";

const ORIGIN = "https://app.example.test";
const FULL_NAME =
  "Learn AI with me 90+ courses and a weekly live call, or start free";

const scenario = (actions: readonly unknown[]) =>
  browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "/opt/chromium/chrome" },
    start_url: { url: `${ORIGIN}/` },
    actions,
    storage: { cookies: [], local_storage: [], session_storage: [] },
    secrets: [],
    capture: {},
  });

const resolved = (parsed: ReturnType<typeof scenario>) => {
  const secrets = BrowserScenarioSecrets.resolve(parsed, {});
  if (!secrets.ok) throw secrets.error;
  return secrets.value;
};

const perform = (
  page: Page,
  action: BrowserScenarioAction,
  secrets: ReturnType<typeof resolved>,
) =>
  performPlaywrightScenarioAction({
    page,
    action,
    secrets,
    startOrigin: ORIGIN,
  });

const clickStep = (name: string, timeout_ms = 20_000) => ({
  step_id: "learn",
  action: "click",
  timeout_ms,
  locator: { kind: "role", role: "button", name },
});

/** A page whose role locator reports `count` matches and records actions. */
const stubPage = (options: {
  readonly count: number;
  readonly snapshot?: unknown;
  readonly clickFails?: Error;
}) => {
  let actions = 0;
  const page = {
    getByRole: () => ({
      count: async () => options.count,
      click: async () => {
        actions += 1;
        if (options.clickFails !== undefined) throw options.clickFails;
      },
      press: async () => {
        actions += 1;
        if (options.clickFails !== undefined) throw options.clickFails;
      },
      waitFor: async () => {
        actions += 1;
      },
    }),
    ...(options.snapshot === undefined
      ? {}
      : {
          accessibility: {
            snapshot: async () => options.snapshot,
          },
        }),
  } as unknown as Page;
  return { page, actions: () => actions };
};

const snapshotWith = (...names: string[]) => ({
  role: "root",
  name: "",
  children: names.map((name) => ({ role: "button", name })),
});

describe("unmatched role locators", () => {
  it("fails a click fast with the typed 0-match error and the closest name", async () => {
    const parsed = scenario([clickStep("Learn AI with me")]);
    const { page, actions } = stubPage({
      count: 0,
      snapshot: snapshotWith(FULL_NAME, "Start free"),
    });
    const startedAt = performance.now();
    const failure = await perform(
      page,
      parsed.actions[0]!,
      resolved(parsed),
    ).catch((cause: unknown) => cause);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(failure).toBeInstanceOf(BrowserScenarioLocatorError);
    if (!(failure instanceof BrowserScenarioLocatorError)) throw failure;
    expect(failure.kind).toBe("locator_no_match");
    expect(failure.message).toContain("matched 0 elements");
    expect(failure.message).toContain('role="button"');
    expect(failure.message).toContain('name="Learn AI with me"');
    expect(failure.message).toContain(FULL_NAME);
    expect(failure.closestNames).toEqual([FULL_NAME, "Start free"]);
    expect(actions()).toBe(0);
  });

  it("fails a press fast the same way", async () => {
    const parsed = scenario([
      {
        step_id: "learn",
        action: "press",
        timeout_ms: 10_000,
        locator: { kind: "role", role: "button", name: "Learn AI with me" },
        key: "Enter",
      },
    ]);
    const { page, actions } = stubPage({
      count: 0,
      snapshot: snapshotWith(FULL_NAME),
    });
    const failure = await perform(
      page,
      parsed.actions[0]!,
      resolved(parsed),
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(BrowserScenarioLocatorError);
    expect(actions()).toBe(0);
  });

  it("runs the action when the role locator matches", async () => {
    const parsed = scenario([clickStep(FULL_NAME)]);
    const { page, actions } = stubPage({
      count: 1,
      snapshot: snapshotWith(FULL_NAME),
    });
    await perform(page, parsed.actions[0]!, resolved(parsed));
    expect(actions()).toBe(1);
  });

  it("waits the full timeout when the page has no element of that role yet", async () => {
    const parsed = scenario([clickStep("Learn AI with me")]);
    const timeout = new Error("Timeout 20000ms exceeded");
    // The snapshot names a link, not a button: no button exists yet, so the
    // step must fall through to the action instead of failing fast.
    const noButtonPage = stubPage({
      count: 0,
      snapshot: {
        role: "root",
        name: "",
        children: [{ role: "link", name: "Something else" }],
      },
      clickFails: timeout,
    });
    const failure = await perform(
      noButtonPage.page,
      parsed.actions[0]!,
      resolved(parsed),
    ).catch((cause: unknown) => cause);
    expect(failure).toBe(timeout);
    expect(noButtonPage.actions()).toBe(1);
  });

  it("does not fail a wait_for step fast for a not-yet-present role locator", async () => {
    const parsed = scenario([
      {
        step_id: "wait-learn",
        action: "wait_for",
        timeout_ms: 20_000,
        locator: { kind: "role", role: "button", name: "Learn AI with me" },
        state: "visible",
      },
    ]);
    const { page, actions } = stubPage({
      count: 0,
      snapshot: snapshotWith(FULL_NAME),
    });
    await perform(page, parsed.actions[0]!, resolved(parsed));
    expect(actions()).toBe(1);
  });
});
