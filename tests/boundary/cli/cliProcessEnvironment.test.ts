import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const helperUrl = pathToFileURL(
  resolve("scripts/lib/cli-process-environment.mjs"),
).href;

const preparedEnvironment = async (
  environment: Record<string, string>,
  platform = "android",
): Promise<Record<string, string>> => {
  const { stdout } = await execute(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { prepareCliProcessEnvironment } from ${JSON.stringify(helperUrl)};
const environment = ${JSON.stringify(environment)};
prepareCliProcessEnvironment(environment, ${JSON.stringify(platform)}, "test-version");
console.log(JSON.stringify(environment));`,
  ]);
  return JSON.parse(stdout) as Record<string, string>;
};

describe("CLI process environment preparation", () => {
  const home = resolve("termux-home");

  it.each([undefined, ""])(
    "uses the home cache when XDG_CACHE_HOME is %s",
    async (cache) => {
      const environment = await preparedEnvironment({
        HOME: home,
        ...(cache === undefined ? {} : { XDG_CACHE_HOME: cache }),
      });
      expect(environment.PLAYWRIGHT_BROWSERS_PATH).toBe(
        join(home, ".cache", "ms-playwright"),
      );
      expect(environment.REA_PACKAGE_VERSION).toBe("test-version");
    },
  );

  it("preserves a nonempty selected XDG cache", async () => {
    const cache = resolve("selected-cache");
    const environment = await preparedEnvironment({
      HOME: home,
      XDG_CACHE_HOME: cache,
    });
    expect(environment.PLAYWRIGHT_BROWSERS_PATH).toBe(
      join(cache, "ms-playwright"),
    );
  });

  it("uses the existing relative fallback when both cache and home are absent", async () => {
    const environment = await preparedEnvironment({ XDG_CACHE_HOME: "" });
    expect(environment.PLAYWRIGHT_BROWSERS_PATH).toBe(
      join(".", ".cache", "ms-playwright"),
    );
  });

  it.each(["selected-browser-cache", ""])(
    "preserves the explicit Playwright cache %s",
    async (cache) => {
      const environment = await preparedEnvironment({
        HOME: home,
        XDG_CACHE_HOME: "",
        PLAYWRIGHT_BROWSERS_PATH: cache,
      });
      expect(environment.PLAYWRIGHT_BROWSERS_PATH).toBe(cache);
    },
  );

  it("does not select a browser cache on Linux", async () => {
    const environment = await preparedEnvironment(
      { HOME: home, XDG_CACHE_HOME: "" },
      "linux",
    );
    expect(environment.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
  });

  it("retains the empty Windows home fallback", async () => {
    const environment = await preparedEnvironment({ USERPROFILE: "" }, "win32");
    expect(environment.USERPROFILE).toBeUndefined();
    expect(environment.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
  });
});
