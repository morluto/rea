import { z } from "zod";
import { isAbsolute } from "node:path";

import { IDENTIFIER_PATTERN } from "./stringPatterns.js";

import { localPathStringSchema } from "./localPath.js";
import { browserNetworkContentSelectionSchema } from "./browserNetworkEvidence.js";

import {
  browserEndpointSchema,
  browserOriginSchema,
} from "./browserObservation.js";

export const scenarioIdentifierSchema = z.string().regex(IDENTIFIER_PATTERN);

const browserExecutablePathSchema = localPathStringSchema.refine(isAbsolute, {
  message:
    "executable_path must be an absolute local filesystem path (for example /opt/chromium/chrome or C:\\chromium\\chrome.exe)",
});

const browserScenarioBaseUrlSchema = z
  .string()
  .min(1)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch (cause: unknown) {
      // Invalid input is reported through the zod issue.
      void cause;
      context.addIssue({ code: "custom", message: "Invalid browser URL" });
      return z.NEVER;
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      context.addIssue({
        code: "custom",
        message: "Browser URLs must be HTTP(S) and omit credentials",
      });
      return z.NEVER;
    }
    return url.toString();
  });

export const browserScenarioValueSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("literal"),
    value: z.string(),
  }),
  z.strictObject({
    source: z.literal("secret"),
    secret_id: scenarioIdentifierSchema,
  }),
]);
export type BrowserScenarioValue = z.infer<typeof browserScenarioValueSchema>;

const queryEntrySchema = z.strictObject({
  name: z.string().min(1),
  value: browserScenarioValueSchema,
});

/** URL with ordinary inline details and optional structured secret query references. */
export const browserScenarioUrlSchema = z.strictObject({
  url: browserScenarioBaseUrlSchema,
  query: z.array(queryEntrySchema).default([]),
});
export type BrowserScenarioUrl = z.infer<typeof browserScenarioUrlSchema>;

export const browserScenarioBrowserSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("launch"),
    executable_path: browserExecutablePathSchema.describe(
      "Absolute local filesystem path for the browser executable; relative paths are rejected.",
    ),
    headless: z
      .boolean()
      .default(true)
      .describe(
        "Run without a visible browser window; defaults to true and can be disabled when the host supports a display.",
      ),
  }),
  z.strictObject({
    mode: z.literal("connect"),
    cdp_endpoint: browserEndpointSchema,
    target_id: z.string().trim().min(1),
  }),
]);

export const browserScenarioEnvironmentSchema = z
  .strictObject({
    viewport: z
      .strictObject({
        width: z.number().int().positive().default(1_280),
        height: z.number().int().positive().default(720),
        device_scale_factor: z.number().positive().default(1),
      })
      .default({ width: 1_280, height: 720, device_scale_factor: 1 }),
    locale: z
      .string()
      .min(2)
      .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u)
      .default("en-US"),
    timezone: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_+\x2d]+(?:\x2f[A-Za-z0-9_+\x2d]+)*$/u)
      .default("UTC"),
    color_scheme: z.enum(["light", "dark", "no-preference"]).default("light"),
    reduced_motion: z.enum(["reduce", "no-preference"]).default("reduce"),
    service_workers: z.enum(["allow", "block"]).default("block"),
  })
  .default({
    viewport: { width: 1_280, height: 720, device_scale_factor: 1 },
    locale: "en-US",
    timezone: "UTC",
    color_scheme: "light",
    reduced_motion: "reduce",
    service_workers: "block",
  })
  .describe(
    "Optional deterministic browser settings. Defaults to 1280x720, en-US, UTC, light mode, reduced motion, and blocked service workers.",
  );

const locatorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("test_id"),
    value: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("role"),
    role: z.enum([
      "button",
      "checkbox",
      "combobox",
      "dialog",
      "link",
      "listbox",
      "menuitem",
      "option",
      "radio",
      "slider",
      "spinbutton",
      "switch",
      "tab",
      "textbox",
    ]),
    name: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("css"),
    selector: z.string().min(1),
  }),
]);

const stepBase = {
  step_id: scenarioIdentifierSchema,
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Optional action deadline in milliseconds; omitted means wait until completion or request cancellation.",
    ),
};

export const browserScenarioActionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...stepBase,
    action: z.literal("goto"),
    destination: browserScenarioUrlSchema,
    wait_until: z.enum(["commit", "domcontentloaded", "load"]),
  }),
  z.strictObject({
    ...stepBase,
    action: z.literal("click"),
    locator: locatorSchema,
    button: z.enum(["left", "middle", "right"]).default("left"),
    click_count: z.number().int().positive().default(1),
  }),
  z.strictObject({
    ...stepBase,
    action: z.literal("fill"),
    locator: locatorSchema,
    value: browserScenarioValueSchema,
  }),
  z.strictObject({
    ...stepBase,
    action: z.literal("press"),
    locator: locatorSchema,
    key: z.string().min(1),
  }),
  z.strictObject({
    ...stepBase,
    action: z.literal("select_option"),
    locator: locatorSchema,
    value: browserScenarioValueSchema,
  }),
  z.strictObject({
    ...stepBase,
    action: z.enum(["check", "uncheck"]),
    locator: locatorSchema,
  }),
  z.strictObject({
    ...stepBase,
    action: z.literal("wait_for"),
    locator: locatorSchema,
    state: z.enum(["attached", "detached", "visible", "hidden"]),
  }),
  z.strictObject({
    step_id: scenarioIdentifierSchema,
    action: z.literal("wait_for_timeout"),
    duration_ms: z
      .number()
      .int()
      .min(1)
      .describe(
        "Wait this many milliseconds; the wait ends early on cancellation.",
      ),
  }),
]);
export type BrowserScenarioAction = z.infer<typeof browserScenarioActionSchema>;

const storageEntrySchema = z.strictObject({
  name: z.string().min(1),
  value: browserScenarioValueSchema,
});

export const browserScenarioStorageSchema = z
  .strictObject({
    cookies: z
      .array(
        z.strictObject({
          name: z.string().min(1),
          value: browserScenarioValueSchema,
          destination: browserScenarioUrlSchema,
          http_only: z.boolean(),
          secure: z.boolean(),
          same_site: z.enum(["Strict", "Lax", "None"]),
        }),
      )
      .default([]),
    local_storage: z
      .array(
        z.strictObject({
          origin: browserOriginSchema,
          entries: z.array(storageEntrySchema),
        }),
      )
      .default([]),
    session_storage: z
      .array(
        z.strictObject({
          origin: browserOriginSchema,
          entries: z.array(storageEntrySchema),
        }),
      )
      .default([]),
  })
  .default({ cookies: [], local_storage: [], session_storage: [] })
  .describe(
    "Optional initial cookies, local storage, or session storage. Defaults to empty; every supplied value and origin must be declared and within the allowed origins.",
  );

export const browserScenarioSecretSchema = z.strictObject({
  secret_id: scenarioIdentifierSchema,
  environment_variable: z
    .string()
    .min(1)
    .refine(
      (name) => !name.includes("=") && !name.includes("\0"),
      "Environment variable names cannot contain '=' or NUL",
    ),
});

const snapshotKindSchema = z.enum([
  "screenshot",
  "dom",
  "accessibility",
  "url",
  "history",
  "storage",
]);

export const browserScenarioCaptureSchema = z
  .strictObject({
    after_each_step: z.array(snapshotKindSchema).default([]),
    at_end: z.array(snapshotKindSchema).default(["url"]),
    events: z
      .array(
        z.enum([
          "console",
          "page-errors",
          "network",
          "websockets",
          "frames",
          "workers",
          "popups",
          "downloads",
        ]),
      )
      .default([]),
    network: browserNetworkContentSelectionSchema,
  })
  .default({
    after_each_step: [],
    at_end: ["url"],
    events: [],
    network: {
      request_body: false,
      response_body: false,
      header_values: false,
    },
  })
  .describe(
    "Optional retained artifacts and event families. Defaults to only a final sanitized URL; request screenshots, DOM, accessibility, history, storage, and event capture explicitly.",
  );
