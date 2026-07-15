import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "./fixtures/fakeCdpBrowser.js";
import { writeElectronBoundaryFixture } from "./fixtures/electronBoundaryApplication.js";

const execute = promisify(execFile);
const INTEGRATION_TEST_TIMEOUT_MS = 20_000;

describe("Electron CLI parity", () => {
  const browsers: FakeCdpBrowser[] = [];
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(
      browsers.splice(0).map(async (browser) => browser.close()),
    );
    await Promise.all(
      temporary
        .splice(0)
        .map(async (path) => rm(path, { recursive: true, force: true })),
    );
  });

  it(
    "returns the same root-confined Electron Evidence contracts",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "rea-electron-cli-"));
      temporary.push(root);
      await writeFile(
        join(root, "index.html"),
        "<script src='app.js'></script>",
      );
      await writeFile(join(root, "app.js"), "export const app = true;");
      const browser = await startFakeCdpBrowser({
        electronFileUrl: pathToFileURL(join(root, "index.html")).href,
      });
      browsers.push(browser);
      const environment = {
        ...process.env,
        REA_ELECTRON_OBSERVE_ENABLED: "true",
        REA_ELECTRON_CDP_ENDPOINTS_JSON: JSON.stringify([browser.endpoint]),
        REA_ELECTRON_FILE_ROOTS_JSON: JSON.stringify([root]),
      };
      const listed = await runCli(
        ["list-electron-targets", browser.endpoint, "--approved", "--json"],
        environment,
      );
      expect(listed).toMatchObject({
        operation: "list_electron_targets",
        normalized_result: {
          targets: { items: [{ target_id: "electron-page" }] },
        },
      });
      const inspected = await runCli(
        [
          "inspect-electron-page",
          browser.endpoint,
          "electron-page",
          "--approved",
          "--observation-ms",
          "0",
          "--json",
        ],
        environment,
      );
      expect(inspected).toMatchObject({
        operation: "inspect_electron_page",
        provider: { id: "rea-cdp-electron" },
        normalized_result: {
          target: { file_path: join(root, "index.html") },
        },
      });
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "returns the static JavaScript application Evidence contract",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "rea-electron-static-cli-"));
      temporary.push(root);
      await writeElectronBoundaryFixture(root);
      const environment = {
        ...process.env,
        REA_INVESTIGATION_INPUT_ROOTS_JSON: JSON.stringify([root]),
      };

      const analyzed = await runCli(
        ["analyze-javascript-application", root, "--approved", "--json"],
        environment,
      );

      expect(analyzed).toMatchObject({
        operation: "analyze_javascript_application",
        provider: { id: "rea-javascript-application" },
        normalized_result: {
          input_path: root,
          summary: {
            browser_windows: 3,
            context_bridge_apis: 2,
            ipc: { paired_renderer_transmissions: 4 },
          },
        },
      });
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});

const runCli = async (
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<unknown> => {
  try {
    const { stdout } = await execute(
      process.execPath,
      ["scripts/rea.mjs", ...arguments_],
      { cwd: process.cwd(), env: environment, maxBuffer: 16 * 1_024 * 1_024 },
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
