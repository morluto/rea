import type { Locator, Page } from "playwright-core";

import { BrowserObservationError } from "../domain/browserObservationError.js";

import {
  SAVED_URL_PLACEHOLDER,
  type BrowserScenarioAction,
  type BrowserScenarioValue,
} from "../domain/browserScenarioValues.js";
import type { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import {
  awaitSavedResponse,
  performScenarioRequest,
  withSavedPlaceholders,
  type SavedResponseWait,
} from "./PlaywrightScenarioRequest.js";

type ScenarioLocator = Extract<
  BrowserScenarioAction,
  { readonly locator: unknown }
>["locator"];

const OPERATION = "capture_browser_scenario" as const;

const describeScenarioLocator = (locator: ScenarioLocator): string => {
  switch (locator.kind) {
    case "test_id":
      return `test_id ${JSON.stringify(locator.value)}`;
    case "role":
      return `role ${JSON.stringify(locator.role)} with accessible name ${JSON.stringify(locator.name)}`;
    case "css":
      return `css ${JSON.stringify(locator.selector)}`;
  }
};

const probeLocatorMatchCount = async (
  page: Page,
  locator: ScenarioLocator,
): Promise<number | undefined> => {
  try {
    return await resolveLocator(page, locator).count();
  } catch {
    return undefined;
  }
};

const locatorFailure = (
  locator: ScenarioLocator,
  cause: unknown,
): BrowserObservationError =>
  new BrowserObservationError(OPERATION, "locator_zero_match", {
    cause,
    detail: `The step's locator ${describeScenarioLocator(locator)} matched 0 elements.`,
    remediationAction:
      "Verify the locator matches at least one visible element in the current page; accessibility capture lists the accessible name to match, and the name must match exactly when role is used.",
  });

/** Surface a typed zero-match failure instead of a generic deadline when the locator verifies empty. */
const withLocatorZeroMatchFallback = async <T>(
  input: PerformActionInput,
  run: () => Promise<T>,
): Promise<T> => {
  const locator = (input.action as { readonly locator?: ScenarioLocator })
    .locator;
  try {
    return await run();
  } catch (cause: unknown) {
    if (locator === undefined) throw cause;
    const count = await probeLocatorMatchCount(input.page, locator);
    if (count === 0) throw locatorFailure(locator, cause);
    throw cause;
  }
};

const resolveLocator = (page: Page, locator: ScenarioLocator): Locator => {
  switch (locator.kind) {
    case "test_id":
      return page.getByTestId(locator.value);
    case "role":
      return page.getByRole(locator.role, {
        name: locator.name,
        exact: true,
      });
    case "css":
      return page.locator(locator.selector);
  }
};

const resolveValue = (
  value: BrowserScenarioValue,
  secrets: BrowserScenarioSecrets,
): string => secrets.value(value);

interface PerformActionInput {
  readonly page: Page;
  readonly action: BrowserScenarioAction;
  readonly secrets: BrowserScenarioSecrets;
  /** Origin of the scenario's start URL, the only origin a request step may address. */
  readonly startOrigin: string;
  /** Cancellation of the step; a request step that sees it before sending sends nothing. */
  readonly signal?: AbortSignal | undefined;
  readonly onOpaqueRedirect?: () => void;
}

/** Watch the response selector before the UI action; matching does not prove action causality. */
const savingResponse = (
  input: PerformActionInput,
  action: Extract<BrowserScenarioAction, { action: "click" | "press" }>,
  timeout: number | undefined,
): SavedResponseWait | undefined =>
  action.save_response === undefined
    ? undefined
    : awaitSavedResponse(input.page, {
        stepId: action.step_id,
        spec: action.save_response,
        startOrigin: input.startOrigin,
        timeout,
        secrets: input.secrets,
        signal: input.signal,
      });

/** Execute one admitted declarative action; a request step sends one declared request through the page's own fetch, and no action runs caller-supplied code. */
export const performPlaywrightScenarioAction = async (
  input: PerformActionInput,
): Promise<void> => {
  const { page, action, secrets, startOrigin, signal } = input;
  const timeout = "timeout_ms" in action ? action.timeout_ms : undefined;
  const options = timeout === undefined ? {} : { timeout };
  switch (action.action) {
    case "goto":
      // Placeholders fill the URL as written, before structured query values join it.
      await page.goto(
        secrets.url({
          ...action.destination,
          url: withSavedPlaceholders(
            action.destination.url,
            secrets,
            SAVED_URL_PLACEHOLDER,
          ),
        }),
        { ...options, waitUntil: action.wait_until },
      );
      return;
    case "click": {
      const saving = savingResponse(input, action, timeout);
      try {
        await withLocatorZeroMatchFallback(input, () =>
          resolveLocator(page, action.locator).click({
            ...options,
            button: action.button,
            clickCount: action.click_count,
          }),
        );
        await saving?.saved();
      } finally {
        saving?.stop();
      }
      return;
    }
    case "fill":
      await withLocatorZeroMatchFallback(input, () =>
        resolveLocator(page, action.locator).fill(
          resolveValue(action.value, secrets),
          options,
        ),
      );
      return;
    case "press": {
      const saving = savingResponse(input, action, timeout);
      try {
        await withLocatorZeroMatchFallback(input, () =>
          resolveLocator(page, action.locator).press(action.key, options),
        );
        await saving?.saved();
      } finally {
        saving?.stop();
      }
      return;
    }
    case "select_option":
      await withLocatorZeroMatchFallback(input, () =>
        resolveLocator(page, action.locator).selectOption(
          resolveValue(action.value, secrets),
          options,
        ),
      );
      return;
    case "check":
      await withLocatorZeroMatchFallback(input, () =>
        resolveLocator(page, action.locator).check(options),
      );
      return;
    case "uncheck":
      await withLocatorZeroMatchFallback(input, () =>
        resolveLocator(page, action.locator).uncheck(options),
      );
      return;
    case "wait_for":
      await resolveLocator(page, action.locator).waitFor({
        ...options,
        state: action.state,
      });
      return;
    case "wait_for_timeout":
      await page.waitForTimeout(action.duration_ms);
      return;
    case "request":
      await performScenarioRequest({
        page,
        action,
        secrets,
        startOrigin,
        signal,
        onOpaqueRedirect: input.onOpaqueRedirect,
      });
      return;
    default: {
      const unhandled: never = action;
      throw new Error(`Unhandled browser scenario action ${String(unhandled)}`);
    }
  }
};
