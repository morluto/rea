import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";
import { writeElectronBoundaryFixture } from "../../fixtures/electronBoundaryApplication.js";
import { JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE } from "../../../src/contracts/javascript/javascriptRuntimeReconciliationExample.js";

const execute = promisify(execFile);
const INTEGRATION_TEST_TIMEOUT_MS = 20_000;
const browsers: FakeCdpBrowser[] = [];
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(browsers.splice(0).map(async (browser) => browser.close()));
  await Promise.all(
    temporary
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Electron CLI parity", () => {
  it(
    "returns the same endpoint-scoped Electron Evidence contracts",
    async () => {
      const root = await createTestTempDirectory("rea-electron-cli-");
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
      const environment = { ...process.env };
      const listed = await runCli(
        ["list-electron-targets", browser.endpoint, "--json"],
        environment,
      );
      expect(listed).toMatchObject({
        operation: "list_electron_targets",
        normalized_result: {
          targets: [{ target_id: "electron-page" }],
        },
      });
      const inspected = await runCli(
        [
          "inspect-electron-page",
          browser.endpoint,
          "electron-page",
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
      const root = await createTestTempDirectory("rea-electron-static-cli-");
      temporary.push(root);
      await writeElectronBoundaryFixture(root);
      const environment = {
        ...process.env,
      };

      const analyzed = await runCli(
        ["analyze-javascript-application", root, "--json"],
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

describe("Electron CLI artifact behavior", () => {
  it(
    "keeps artifact format separate from structured output format",
    async () => {
      const root = await createTestTempDirectory("rea-electron-format-cli-");
      temporary.push(root);
      await writeElectronBoundaryFixture(root);
      const environment = {
        ...process.env,
      };

      const analyzed = await runCli(
        [
          "--format",
          "json",
          "analyze-javascript-application",
          root,
          "--artifact-format",
          "directory",
        ],
        environment,
      );

      expect(analyzed).toMatchObject({
        operation: "analyze_javascript_application",
        normalized_result: { input_path: root, format: "directory" },
      });
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "routes generic directory analysis to static JavaScript",
    async () => {
      const root = await createTestTempDirectory("rea-electron-routed-cli-");
      temporary.push(root);
      await writeElectronBoundaryFixture(root);
      const environment = {
        ...process.env,
      };

      const analyzed = await runCli(["analyze", root, "--json"], environment);

      expect(analyzed).toMatchObject({
        operation: "analyze_javascript_application",
        provider: { id: "rea-javascript-application" },
        normalized_result: {
          input_path: root,
          format: "directory",
          summary: { ipc: { paired_renderer_transmissions: 4 } },
        },
      });
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe("Electron CLI runtime reconciliation", () => {
  it(
    "reads a file and returns the derived static/runtime reconciliation contract",
    async () => {
      const root = await createTestTempDirectory("rea-runtime-cli-");
      const inputPath = join(root, "reconciliation.json");
      temporary.push(root);
      await writeFile(
        inputPath,
        JSON.stringify(JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE),
      );
      const reconciled = await runCli(
        ["reconcile-javascript-runtime", inputPath, "--json"],
        process.env,
      );

      expect(reconciled).toMatchObject({
        operation: "reconcile_javascript_runtime",
        provider: { id: "rea-javascript-runtime-reconciliation" },
        normalized_result: {
          summary: { runtime_scripts: 1, matched: 1 },
          source_map_authority: { used_for_primary_matching: false },
        },
      });
      const missingPath = join(root, "missing.json");
      const missing = await runCli(
        ["reconcile-javascript-runtime", missingPath, "--json"],
        process.env,
      );
      expect(missing).toMatchObject({
        input_path: missingPath,
        input_reason: "read-failed",
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
