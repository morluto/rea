import { z } from "zod";

import {
  browserScenarioActionSchema,
  browserScenarioBrowserSchema,
  browserScenarioCaptureSchema,
  browserScenarioEnvironmentSchema,
  browserScenarioSecretSchema,
  browserScenarioStorageSchema,
  browserScenarioUrlSchema,
  type BrowserScenarioAction,
  type BrowserScenarioUrl,
  type BrowserScenarioValue,
} from "./browserScenarioValues.js";

export {
  browserScenarioActionSchema,
  browserScenarioUrlSchema,
  browserScenarioValueSchema,
  type BrowserScenarioAction,
  type BrowserScenarioUrl,
  type BrowserScenarioValue,
} from "./browserScenarioValues.js";

export const browserScenarioInputSchema = z.strictObject({
  browser: browserScenarioBrowserSchema.describe(
    "Required launch/connect selection. Launch uses the selected executable and an owned temporary profile; connect uses one loopback CDP endpoint and target.",
  ),
  start_url: browserScenarioUrlSchema.describe(
    "Required initial HTTP(S) URL. Query values must be declared separately as public literals or secret references.",
  ),
  environment: browserScenarioEnvironmentSchema,
  actions: z
    .array(browserScenarioActionSchema)
    .min(1)
    .describe("Required sequence of explicit browser actions."),
  storage: browserScenarioStorageSchema,
  secrets: z
    .array(browserScenarioSecretSchema)
    .default([])
    .describe(
      "Optional environment-variable references for values used in actions, URLs, storage, or replay, and for redacting matching observed text. Secret values are never supplied inline.",
    ),
  capture: browserScenarioCaptureSchema,
});

type ScenarioShape = z.infer<typeof browserScenarioInputSchema>;

const addIssue = (
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void => context.addIssue({ code: "custom", path, message });

const assertUnique = (
  values: readonly string[],
  path: PropertyKey[],
  label: string,
  context: z.RefinementCtx,
): void => {
  if (new Set(values).size !== values.length)
    addIssue(context, path, `${label} must be unique`);
};

const secretReferencesInValue = (
  value: BrowserScenarioValue | undefined,
): readonly string[] => (value?.source === "secret" ? [value.secret_id] : []);

const destinationSecretReferences = (
  destination: BrowserScenarioUrl,
): readonly string[] =>
  destination.query.flatMap(({ value }) => secretReferencesInValue(value));

const actionSecretReferences = (
  action: BrowserScenarioAction,
): readonly string[] => {
  if (action.action === "fill" || action.action === "select_option")
    return secretReferencesInValue(action.value);
  if (action.action === "goto")
    return destinationSecretReferences(action.destination);
  return [];
};

const validateStorage = (scenario: ScenarioShape): readonly string[] => {
  const references: string[] = [];
  scenario.storage.cookies.forEach((cookie) => {
    references.push(...secretReferencesInValue(cookie.value));
    references.push(...destinationSecretReferences(cookie.destination));
  });
  for (const collection of ["local_storage", "session_storage"] as const)
    scenario.storage[collection].forEach((storage) => {
      for (const entry of storage.entries)
        references.push(...secretReferencesInValue(entry.value));
    });
  return references;
};

const validateSecretReferences = (
  scenario: ScenarioShape,
  references: readonly string[],
  context: z.RefinementCtx,
): void => {
  const declared = new Set(scenario.secrets.map(({ secret_id: id }) => id));
  for (const reference of references)
    if (!declared.has(reference))
      addIssue(
        context,
        ["secrets"],
        `Secret reference ${reference} is not declared`,
      );
};

const validateBrowserScenario = (
  scenario: ScenarioShape,
  context: z.RefinementCtx,
): void => {
  assertUnique(
    scenario.actions.map(({ step_id: id }) => id),
    ["actions"],
    "Action step IDs",
    context,
  );
  assertUnique(
    scenario.secrets.map(({ secret_id: id }) => id),
    ["secrets"],
    "Secret IDs",
    context,
  );
  assertUnique(
    scenario.secrets.map(({ environment_variable: name }) => name),
    ["secrets"],
    "Secret environment variables",
    context,
  );

  const references = scenario.actions.flatMap(actionSecretReferences);
  references.push(...destinationSecretReferences(scenario.start_url));
  references.push(...validateStorage(scenario));
  validateSecretReferences(scenario, references, context);
};

/** Strict provider-neutral contract for one controlled browser scenario. */
export const browserScenarioSchema = browserScenarioInputSchema.superRefine(
  validateBrowserScenario,
);
export type BrowserScenario = z.infer<typeof browserScenarioSchema>;
