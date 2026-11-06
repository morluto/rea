import { access, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, posix } from "node:path";

import { appendCallerPath } from "../filesystem/callerPath.js";

export const nonemptyEnvironmentValue = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined => {
  const value = environment[name];
  return value === undefined || value.length === 0 ? undefined : value;
};

/**
 * Android's `/tmp` belongs to the shell user, so a Termux process cannot create
 * a Chromium profile there. A caller-selected temp directory wins; otherwise
 * the Termux prefix temp directory is the writable location.
 */
export const androidScenarioTempDirectory = (
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  if (process.platform !== "android") return undefined;
  const explicit = ["TMPDIR", "TMP", "TEMP"]
    .map((name) => nonemptyEnvironmentValue(environment, name))
    .find((value) => value !== undefined);
  if (explicit !== undefined) return explicit;
  const prefix = nonemptyEnvironmentValue(environment, "PREFIX");
  return prefix === undefined ? undefined : appendCallerPath(prefix, "tmp");
};

/**
 * Playwright 1.58.2 throws `Unsupported platform: android` while resolving
 * its browser cache unless `PLAYWRIGHT_BROWSERS_PATH` is already set. The
 * path is process-wide, so it is published once from the first writable
 * Android temp directory and left for later launches.
 */
export const publishAndroidPlaywrightBrowsersPath = async (
  directory: string | undefined,
): Promise<void> => {
  if (
    process.platform !== "android" ||
    directory === undefined ||
    nonemptyEnvironmentValue(process.env, "PLAYWRIGHT_BROWSERS_PATH") !==
      undefined
  )
    return;
  const browsersPath = appendCallerPath(directory, "ms-playwright");
  await mkdir(browsersPath, { recursive: true });
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
};

/** Publish the Android browser cache path, then load Playwright. */
export const loadPlaywrightCore = async (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<typeof import("playwright-core")> => {
  await publishAndroidPlaywrightBrowsersPath(
    androidScenarioTempDirectory(environment),
  );
  return import("playwright-core");
};

const callerDirectory = (path: string): string =>
  posix.isAbsolute(path) ? posix.dirname(path) : dirname(path);

/**
 * Termux Chromium still SIGTRAPs when ICU is found only by adjacency to the
 * executable. Point Chromium at `icudtl.dat` when that file is present.
 */
export const androidChromiumLaunchArgs = async (
  executablePath: string,
): Promise<readonly string[]> => {
  if (process.platform !== "android") return [];
  const args = ["--disable-dev-shm-usage", "--single-process"];
  const directory = callerDirectory(executablePath);
  try {
    await access(appendCallerPath(directory, "icudtl.dat"), fsConstants.F_OK);
    args.push(`--icu-data-dir=${directory}`);
  } catch {
    // Generic Android flags still apply when the ICU bundle is absent.
  }
  return args;
};
