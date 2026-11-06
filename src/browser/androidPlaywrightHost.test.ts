import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { appendCallerPath } from "../filesystem/callerPath.js";

const run = promisify(execFile);

it("publishes the Android browsers path before the first Playwright import", async () => {
  const prefix = await createTestTempDirectory("rea-termux-playwright-first-");
  const hostUrl = new URL("./androidPlaywrightHost.ts", import.meta.url).href;
  const env = { ...process.env, REA_TERMUX_PREFIX: prefix };
  delete env.PLAYWRIGHT_BROWSERS_PATH;
  delete env.npm_config_playwright_browsers_path;
  delete env.npm_package_config_playwright_browsers_path;
  const { stdout } = await run(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "-e",
      `Object.defineProperty(process, "platform", { value: "android" });
       delete process.env.PLAYWRIGHT_BROWSERS_PATH;
       delete process.env.npm_config_playwright_browsers_path;
       delete process.env.npm_package_config_playwright_browsers_path;
       const { loadPlaywrightCore } = await import(${JSON.stringify(hostUrl)});
       await loadPlaywrightCore({
         PREFIX: process.env.REA_TERMUX_PREFIX,
         TMPDIR: "",
         TMP: "",
         TEMP: "",
       });
       process.stdout.write(process.env.PLAYWRIGHT_BROWSERS_PATH ?? "");`,
    ],
    { env, encoding: "utf8", timeout: 30_000 },
  );
  expect(stdout).toBe(
    appendCallerPath(
      appendCallerPath(prefix, "tmp", "android"),
      "ms-playwright",
      "android",
    ),
  );
});
