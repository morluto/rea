import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "./fixtures/fakeCdpBrowser.js";

const execute = promisify(execFile);
const browsers: FakeCdpBrowser[] = [];
const INTEGRATION_TEST_TIMEOUT_MS = 20_000;

afterEach(async () => {
  await Promise.all(browsers.splice(0).map(async (browser) => browser.close()));
});

describe("browser CLI parity", () => {
  it(
    "returns the same Evidence v2 discovery and inspection contracts",
    async () => {
      const browser = await startFakeCdpBrowser();
      browsers.push(browser);
      const environment = {
        ...process.env,
        REA_BROWSER_OBSERVE_ENABLED: "true",
        REA_BROWSER_CDP_ENDPOINTS_JSON: JSON.stringify([browser.endpoint]),
        REA_BROWSER_ALLOWED_ORIGINS_JSON: JSON.stringify([
          browser.allowedOrigin,
        ]),
      };
      const listed = await runCli(
        ["list-browser-targets", browser.endpoint, "--approved", "--json"],
        environment,
      );
      expect(listed).toMatchObject({
        operation: "list_browser_targets",
        provider: { id: "rea-cdp-browser" },
        normalized_result: {
          targets: { items: [{ target_id: "allowed-page" }] },
        },
      });
      const inspected = await runCli(
        [
          "inspect-web-page",
          browser.endpoint,
          "allowed-page",
          "--approved",
          "--observation-ms",
          "0",
          "--json",
        ],
        environment,
      );
      expect(inspected).toMatchObject({
        operation: "inspect_web_page",
        provider: { id: "rea-cdp-browser" },
        normalized_result: {
          target: { target_id: "allowed-page" },
          network: { prior_activity_available: false },
        },
      });
      const policy = await runCli(
        [
          "policy",
          "explain",
          "browser_observe",
          "--origins",
          browser.endpoint,
          "--origins",
          browser.allowedOrigin,
          "--network",
          "loopback",
          "--json",
        ],
        environment,
      );
      expect(policy).toEqual({
        allowed: true,
        grant_id: "administrator:browser_observe",
      });
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it("requires explicit approval before opening the CDP endpoint", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const result = await runCli(
      ["list-browser-targets", browser.endpoint, "--json"],
      {
        ...process.env,
        REA_BROWSER_OBSERVE_ENABLED: "true",
        REA_BROWSER_CDP_ENDPOINTS_JSON: JSON.stringify([browser.endpoint]),
        REA_BROWSER_ALLOWED_ORIGINS_JSON: JSON.stringify([
          browser.allowedOrigin,
        ]),
      },
    );
    expect(result).toMatchObject({
      error: "Browser observation failed",
      code: "invalid_request",
      category: "invalid_input",
    });
    expect(browser.commands).toHaveLength(0);
  });
});

const runCli = async (
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<unknown> => {
  try {
    const { stdout } = await execute(
      process.execPath,
      ["scripts/rea.mjs", ...arguments_],
      {
        cwd: process.cwd(),
        env: environment,
        maxBuffer: 16 * 1_024 * 1_024,
      },
    );
    return JSON.parse(stdout);
  } catch (cause: unknown) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "stdout" in cause &&
      typeof cause.stdout === "string"
    )
      return JSON.parse(cause.stdout);
    throw cause;
  }
};
