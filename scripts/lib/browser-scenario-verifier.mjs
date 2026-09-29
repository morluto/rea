import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { browserScenarioSchema } from "../../dist/domain/browserScenario.js";

const execute = promisify(execFile);

const duplicateOriginStorage = (origin) => ({
  local_storage: [
    {
      origin,
      entries: [
        {
          name: "rea-first-seed",
          value: {
            source: "literal",
            value: "first",
            classification: "public",
          },
        },
      ],
    },
    {
      origin,
      entries: [
        {
          name: "rea-second-seed",
          value: {
            source: "literal",
            value: "second",
            classification: "public",
          },
        },
      ],
    },
  ],
});

/** Build the source-owned full-capture browser scenario. */
export function browserScenario(browser, origin) {
  return browserScenarioSchema.parse({
    browser,
    start_url: { url: `${origin}/app`, query: [] },
    allowed_origins: [origin],
    environment: {
      viewport: { width: 1_280, height: 720, device_scale_factor: 1.25 },
      locale: "en-US",
      timezone: "UTC",
      color_scheme: "light",
      reduced_motion: "reduce",
      service_workers: "block",
    },
    actions: [
      {
        step_id: "ready",
        action: "wait_for",
        locator: {
          kind: "role",
          role: "button",
          name: "ax-private-label-value",
          exact: true,
        },
        state: "visible",
      },
      {
        step_id: "verify",
        action: "click",
        locator: {
          kind: "role",
          role: "button",
          name: "ax-private-label-value",
          exact: true,
        },
      },
    ],
    storage: duplicateOriginStorage(origin),
    request_replay: { mode: "disabled" },
    secrets: [],
    redaction: {
      secret_values: "replace-with-secret-reference",
      query_parameter_names: ["token"],
    },
    capture: {
      after_each_step: [
        "screenshot",
        "dom",
        "accessibility",
        "url",
        "history",
        "storage",
      ],
      at_end: [
        "screenshot",
        "dom",
        "accessibility",
        "url",
        "history",
        "storage",
      ],
      events: [
        "console",
        "page-errors",
        "network",
        "websockets",
        "frames",
        "workers",
        "popups",
        "downloads",
      ],
    },
  });
}

/** Run scenario capture through the public one-shot CLI. */
export async function runScenarioCli(scenario, configuration) {
  const { stdout } = await execute(
    process.execPath,
    [
      "scripts/rea.mjs",
      "capture-browser-scenario",
      JSON.stringify(scenario),
      "--json",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REA_BROWSER_SCENARIO_ENABLED: "true",
        REA_BROWSER_SCENARIO_AUTO_GRANT: "true",
        REA_BROWSER_SCENARIO_EXECUTABLE_ROOTS_JSON: JSON.stringify([
          dirname(scenario.browser.executable_path ?? process.execPath),
        ]),
        REA_BROWSER_SCENARIO_ALLOWED_ENV_JSON: "[]",
        ...configuration,
      },
      maxBuffer: 64 * 1_024 * 1_024,
    },
  );
  return JSON.parse(stdout);
}

/** Snapshot provider-owned profile names for cleanup comparison. */
export async function scenarioProfiles() {
  return new Set(
    (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith("rea-browser-scenario-"),
    ),
  );
}

/** Assert full real-browser scenario evidence and cleanup prerequisites. */
export function assertScenarioCapture(capture) {
  if (
    capture.steps.length !== 3 ||
    capture.steps.some(({ status }) => status !== "completed")
  )
    throw new Error("Scenario launch did not complete every declared step");
  const final = capture.steps.at(-1);
  if (
    final === undefined ||
    Object.values(final.artifacts).some(({ state }) => state !== "captured")
  )
    throw new Error(
      `Scenario launch did not capture every requested artifact: ${JSON.stringify(final?.artifacts ?? null)}`,
    );
  const storageNames =
    final.artifacts.storage.state === "captured"
      ? final.artifacts.storage.value.local_storage.map(({ name }) => name)
      : [];
  if (
    !storageNames.includes("rea-first-seed") ||
    !storageNames.includes("rea-second-seed")
  )
    throw new Error("Scenario launch did not retain duplicate-origin seeds");
  if (
    capture.events.items.length === 0 ||
    capture.completeness.equality_eligible !== true
  )
    throw new Error(
      "Scenario launch did not produce complete runtime evidence",
    );
}
