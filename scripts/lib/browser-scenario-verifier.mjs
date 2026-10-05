import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
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
          },
        },
        {
          name: "rea-secret-seed",
          value: { source: "secret", secret_id: "verifier_storage" },
        },
      ],
    },
  ],
});

/** Build the source-owned full-capture browser scenario. */
export function browserScenario(browser, origin) {
  return browserScenarioSchema.parse({
    browser,
    start_url: {
      url: `${origin}/app`,
      query: [
        {
          name: "scenario_token",
          value: { source: "secret", secret_id: "verifier_url" },
        },
      ],
    },
    environment: {
      viewport: { width: 1_280, height: 720, device_scale_factor: 1.25 },
      locale: "en-US",
      timezone: "UTC",
      color_scheme: "light",
      reduced_motion: "reduce",
    },
    actions: [
      {
        step_id: "ready",
        action: "wait_for",
        locator: {
          kind: "role",
          role: "button",
          name: "ax-private-label-value",
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
        },
      },
    ],
    storage: duplicateOriginStorage(origin),
    secrets: [
      {
        secret_id: "verifier_url",
        environment_variable: "REA_BROWSER_VERIFIER_URL",
      },
      {
        secret_id: "verifier_storage",
        environment_variable: "REA_BROWSER_VERIFIER_SECRET",
      },
    ],
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
export async function runScenarioCli(scenario) {
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
      env: process.env,
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
  const secretSeed =
    final.artifacts.storage.state === "captured"
      ? final.artifacts.storage.value.local_storage.find(
          ({ name }) => name === "rea-secret-seed",
        )
      : undefined;
  if (secretSeed?.value_state !== "redacted-secret")
    throw new Error("Scenario launch did not redact its declared secret seed");
  const finalUrl =
    final.artifacts.url.state === "captured"
      ? final.artifacts.url.value.url
      : "";
  if (!finalUrl.includes("[REDACTED:verifier_url]"))
    throw new Error("Scenario launch did not redact its declared URL secret");
  const stepUrl = capture.steps
    .map(({ after_url }) => after_url)
    .find(({ url }) => url.includes("[REDACTED:verifier_url]"));
  if (stepUrl?.redacted !== true)
    throw new Error(
      "Scenario step URL did not report declared-secret redaction",
    );
  const eventUrl = capture.events.items
    .filter((event) => "url" in event && event.url !== null)
    .map((event) => event.url)
    .find(({ url }) => url.includes("[REDACTED:verifier_url]"));
  if (eventUrl?.redacted !== true)
    throw new Error(
      "Scenario event URL did not report declared-secret redaction",
    );
  if (
    capture.events.items.length === 0 ||
    capture.completeness.equality_eligible !== true
  )
    throw new Error(
      "Scenario launch did not produce complete runtime evidence",
    );
}
