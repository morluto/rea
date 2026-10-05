import { z } from "zod";

import {
  browserScenarioActionSchema,
  browserScenarioAllowedOriginsSchema,
  browserScenarioBrowserSchema,
  browserScenarioCaptureSchema,
  browserScenarioEnvironmentSchema,
  browserScenarioRequestReplaySchema,
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
  allowed_origins: browserScenarioAllowedOriginsSchema
    .default([])
    .describe(
      "Optional exact HTTP(S) origins for later navigation, storage seed, and replay routes. Defaults to the start URL origin.",
    ),
  environment: browserScenarioEnvironmentSchema,
  actions: z
    .array(browserScenarioActionSchema)
    .min(1)
    .describe("Required sequence of explicit browser actions."),
  storage: browserScenarioStorageSchema,
  request_replay: browserScenarioRequestReplaySchema,
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

const originFor = (destination: BrowserScenarioUrl): string =>
  new URL(destination.url).origin;

const assertAllowedDestination = (
  destination: BrowserScenarioUrl,
  allowedOrigins: ReadonlySet<string>,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void => {
  if (!allowedOrigins.has(originFor(destination)))
    addIssue(
      context,
      path,
      `URL origin ${originFor(destination)} is not declared in allowed_origins`,
    );
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

const validateStorage = (
  scenario: ScenarioShape,
  allowedOrigins: ReadonlySet<string>,
  context: z.RefinementCtx,
): readonly string[] => {
  const references: string[] = [];
  scenario.storage.cookies.forEach((cookie, index) => {
    assertAllowedDestination(
      cookie.destination,
      allowedOrigins,
      ["storage", "cookies", index, "destination"],
      context,
    );
    references.push(...secretReferencesInValue(cookie.value));
    references.push(...destinationSecretReferences(cookie.destination));
  });
  for (const collection of ["local_storage", "session_storage"] as const)
    scenario.storage[collection].forEach((storage, index) => {
      if (!allowedOrigins.has(storage.origin))
        addIssue(
          context,
          ["storage", collection, index, "origin"],
          `Storage origin ${storage.origin} is not declared in allowed_origins`,
        );
      for (const entry of storage.entries)
        references.push(...secretReferencesInValue(entry.value));
    });
  return references;
};

const FORBIDDEN_REPLAY_HEADERS = new Set([
  "content-length",
  "location",
  "transfer-encoding",
]);

const validateRequestReplay = (
  scenario: ScenarioShape,
  allowedOrigins: ReadonlySet<string>,
  context: z.RefinementCtx,
): readonly string[] => {
  if (scenario.request_replay.mode === "disabled") return [];
  assertUnique(
    scenario.request_replay.routes.map(({ route_id: id }) => id),
    ["request_replay", "routes"],
    "Replay route IDs",
    context,
  );
  assertUnique(
    scenario.request_replay.routes.map(
      ({ method, request }) =>
        `${method} ${request.url}?${request.query
          .map(({ name, value }) =>
            value.source === "secret"
              ? `${name}=\${secret:${value.secret_id}}`
              : `${name}=${value.value}`,
          )
          .join("&")}`,
    ),
    ["request_replay", "routes"],
    "Replay request matchers",
    context,
  );
  const references: string[] = [];
  scenario.request_replay.routes.forEach((route, routeIndex) => {
    assertAllowedDestination(
      route.request,
      allowedOrigins,
      ["request_replay", "routes", routeIndex, "request"],
      context,
    );
    references.push(...destinationSecretReferences(route.request));
    if (route.response.kind === "redirect") {
      assertAllowedDestination(
        route.response.destination,
        allowedOrigins,
        ["request_replay", "routes", routeIndex, "response", "destination"],
        context,
      );
      references.push(
        ...destinationSecretReferences(route.response.destination),
      );
      return;
    }
    assertUnique(
      route.response.headers.map(({ name }) => name.toLowerCase()),
      ["request_replay", "routes", routeIndex, "response", "headers"],
      "Replay response header names",
      context,
    );
    route.response.headers.forEach((header, headerIndex) => {
      if (FORBIDDEN_REPLAY_HEADERS.has(header.name))
        addIssue(
          context,
          [
            "request_replay",
            "routes",
            routeIndex,
            "response",
            "headers",
            headerIndex,
          ],
          `Replay header ${header.name} must be modeled by the provider`,
        );
      references.push(...secretReferencesInValue(header.value));
    });
    references.push(...secretReferencesInValue(route.response.body));
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
  const allowedOrigins = new Set(
    scenario.allowed_origins.length > 0
      ? scenario.allowed_origins
      : [originFor(scenario.start_url)],
  );
  assertAllowedDestination(
    scenario.start_url,
    allowedOrigins,
    ["start_url"],
    context,
  );
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
  for (const [index, action] of scenario.actions.entries())
    if (action.action === "goto")
      assertAllowedDestination(
        action.destination,
        allowedOrigins,
        ["actions", index, "destination"],
        context,
      );
  references.push(...destinationSecretReferences(scenario.start_url));
  references.push(...validateStorage(scenario, allowedOrigins, context));
  references.push(...validateRequestReplay(scenario, allowedOrigins, context));
  validateSecretReferences(scenario, references, context);
};

/** Strict provider-neutral contract for one controlled browser scenario. */
export const browserScenarioSchema = browserScenarioInputSchema
  .superRefine(validateBrowserScenario)
  .transform((scenario) => ({
    ...scenario,
    allowed_origins:
      scenario.allowed_origins.length > 0
        ? scenario.allowed_origins
        : [originFor(scenario.start_url)],
  }));
export type BrowserScenario = z.infer<typeof browserScenarioSchema>;
