import { afterEach, describe, expect, it, vi } from "vitest";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import type { BrowserScenarioAction } from "../domain/browserScenarioValues.js";
import { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import { performPlaywrightScenarioAction } from "./PlaywrightScenarioActions.js";

const ORIGIN = "https://app.example.test";

const clickStep = (name: string) => ({
  step_id: "open",
  action: "click",
  locator: { kind: "role", role: "button", name },
});

const scenario = (actions: readonly unknown[]) =>
  browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "/opt/chromium/chrome" },
    start_url: { url: `${ORIGIN}/` },
    actions,
    storage: { cookies: [], local_storage: [], session_storage: [] },
    secrets: [],
    capture: {},
  });

const fakeSecrets = (actions: readonly unknown[]) => {
  const parsed = scenario(actions);
  const secrets = BrowserScenarioSecrets.resolve(parsed, {});
  if (!secrets.ok) throw secrets.error;
  return secrets.value;
};

const clickLocator = (
  error: Error,
  count: number | (() => Promise<number>),
) => ({
  click: async () => {
    throw error;
  },
  count:
    typeof count === "function"
      ? count
      : async () => count as unknown as number,
});

const fakePage = (behavior: {
  readonly error: Error;
  readonly count: number | (() => Promise<number>);
}) =>
  ({
    getByRole: () => clickLocator(behavior.error, behavior.count),
    getByTestId: () => clickLocator(behavior.error, behavior.count),
    locator: () => clickLocator(behavior.error, behavior.count),
  }) as never;

describe("locator zero-match failure", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a typed zero-match failure when a role locator matches nothing", async () => {
    const page = fakePage({
      error: new Error(
        "TimeoutError: locator waited 5000ms for accessible name",
      ),
      count: 0,
    });
    const secrets = fakeSecrets([clickStep("Learn AI with me")]);
    const action = scenario([clickStep("Learn AI with me")])
      .actions[0]! as BrowserScenarioAction;
    await expect(
      performPlaywrightScenarioAction({
        page,
        action,
        secrets,
        startOrigin: ORIGIN,
      }),
    ).rejects.toSatisfy((cause: unknown): boolean => {
      const reason = (cause as { reason?: string } | undefined)?.reason;
      return reason === "locator_zero_match";
    });
  });

  it("preserves the original error when the locator still has matches", async () => {
    const error = new Error("click intercepted by another element");
    const page = fakePage({ error, count: 1 });
    const secrets = fakeSecrets([clickStep("Learn AI with me")]);
    const action = scenario([clickStep("Learn AI with me")])
      .actions[0]! as BrowserScenarioAction;
    await expect(
      performPlaywrightScenarioAction({
        page,
        action,
        secrets,
        startOrigin: ORIGIN,
      }),
    ).rejects.toBe(error);
  });
});
