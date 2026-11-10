import type { Locator, Page } from "playwright-core";

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

type RoleLocator = Extract<ScenarioLocator, { kind: "role" }>;

const MAX_CLOSEST_NAMES = 3;
const MAX_CLOSEST_NAME_LENGTH = 120;
const MAX_ACCESSIBILITY_NODES = 10_000;

/**
 * A role locator that matched no element while elements of that role exist
 * on the page. Thrown before the action's timeout is spent, so a mistyped
 * or prefix-only accessible name is reported as a locator failure instead
 * of a generic step timeout.
 */
export class BrowserScenarioLocatorError extends Error {
  readonly kind = "locator_no_match" as const;
  constructor(
    readonly role: RoleLocator["role"],
    readonly locatorName: string,
    readonly closestNames: readonly string[],
  ) {
    super(
      `Role locator matched 0 elements: role="${role}" name="${locatorName}".` +
        (closestNames.length > 0
          ? ` Closest "${role}" names: ${closestNames.map((candidate) => `"${candidate}"`).join(", ")}. Use the full accessible name from the page's accessibility tree.`
          : ""),
    );
    this.name = "BrowserScenarioLocatorError";
  }
}

/** Small edit distance over truncated, case-insensitive names. */
const nameDistance = (left: string, right: string): number => {
  const a = left.toLowerCase().slice(0, 200);
  const b = right.toLowerCase().slice(0, 200);
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min(
        above + 1,
        previous[j - 1]! + 1,
        diagonal + cost,
      );
      diagonal = above;
    }
  }
  return previous[b.length]!;
};

/** Accessible names of elements with the locator's role, closest first. */
const closestRoleNames = async (
  page: Page,
  locator: RoleLocator,
): Promise<string[]> => {
  const accessibility = (
    page as unknown as {
      accessibility?: {
        snapshot: () => Promise<unknown>;
      };
    }
  ).accessibility;
  if (accessibility === undefined) return [];
  const snapshot = await accessibility.snapshot();
  const names: string[] = [];
  const queue: unknown[] = [snapshot];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_ACCESSIBILITY_NODES) {
    const node = queue.shift() as {
      role?: unknown;
      name?: unknown;
      children?: readonly unknown[];
    } | null;
    visited += 1;
    if (node === null || typeof node !== "object") continue;
    if (
      node.role === locator.role &&
      typeof node.name === "string" &&
      node.name.length > 0
    )
      names.push(node.name.slice(0, MAX_CLOSEST_NAME_LENGTH));
    if (Array.isArray(node.children)) queue.push(...node.children);
  }
  const wanted = locator.name;
  const rank = (candidate: string): [number, number] =>
    candidate.startsWith(wanted) || wanted.startsWith(candidate)
      ? [0, nameDistance(candidate, wanted)]
      : candidate.includes(wanted) || wanted.includes(candidate)
        ? [1, nameDistance(candidate, wanted)]
        : [2, nameDistance(candidate, wanted)];
  return [...new Set(names)]
    .sort((a, b) => {
      const [rankA, distanceA] = rank(a);
      const [rankB, distanceB] = rank(b);
      return rankA - rankB || distanceA - distanceB;
    })
    .slice(0, MAX_CLOSEST_NAMES);
};

/**
 * Fail a role locator fast when it matches nothing while the page already
 * has elements of that role: the name is wrong (often a prefix of the full
 * accessible name), not merely slow. When the page has no element of that
 * role at all, the target may still be rendering, so the caller falls
 * through to the normal action and its full timeout. A probe that itself
 * fails also falls through, so the action reports its own failure.
 */
const ensureRoleLocatorMatches = async (
  page: Page,
  locator: RoleLocator,
): Promise<void> => {
  let count: number;
  try {
    count = await resolveLocator(page, locator).count();
  } catch {
    return;
  }
  if (count > 0) return;
  let closest: string[];
  try {
    closest = await closestRoleNames(page, locator);
  } catch {
    return;
  }
  if (closest.length === 0) return;
  throw new BrowserScenarioLocatorError(locator.role, locator.name, closest);
};

const ensureLocatorMatches = async (
  page: Page,
  locator: ScenarioLocator,
): Promise<void> => {
  if (locator.kind === "role") await ensureRoleLocatorMatches(page, locator);
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
      await ensureLocatorMatches(page, action.locator);
      const saving = savingResponse(input, action, timeout);
      try {
        await resolveLocator(page, action.locator).click({
          ...options,
          button: action.button,
          clickCount: action.click_count,
        });
        await saving?.saved();
      } finally {
        saving?.stop();
      }
      return;
    }
    case "fill":
      await ensureLocatorMatches(page, action.locator);
      await resolveLocator(page, action.locator).fill(
        resolveValue(action.value, secrets),
        options,
      );
      return;
    case "press": {
      await ensureLocatorMatches(page, action.locator);
      const saving = savingResponse(input, action, timeout);
      try {
        await resolveLocator(page, action.locator).press(action.key, options);
        await saving?.saved();
      } finally {
        saving?.stop();
      }
      return;
    }
    case "select_option":
      await ensureLocatorMatches(page, action.locator);
      await resolveLocator(page, action.locator).selectOption(
        resolveValue(action.value, secrets),
        options,
      );
      return;
    case "check":
      await ensureLocatorMatches(page, action.locator);
      await resolveLocator(page, action.locator).check(options);
      return;
    case "uncheck":
      await ensureLocatorMatches(page, action.locator);
      await resolveLocator(page, action.locator).uncheck(options);
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
