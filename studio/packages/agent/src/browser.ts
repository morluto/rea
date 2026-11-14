import { existsSync } from "node:fs";

/** Chrome-family executables REA can launch for browser scenarios. */
const CANDIDATES: Record<string, readonly string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
};

export const detectBrowserExecutable = (
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  if (env.STUDIO_BROWSER_PATH && existsSync(env.STUDIO_BROWSER_PATH)) {
    return env.STUDIO_BROWSER_PATH;
  }
  return (CANDIDATES[process.platform] ?? []).find((path) => existsSync(path));
};
