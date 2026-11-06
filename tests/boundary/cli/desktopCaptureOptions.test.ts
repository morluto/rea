import { Cli } from "incur";
import pino from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import * as capture from "../../../src/application/desktop/DesktopApplicationCapture.js";
import { registerDesktopCaptureCommands } from "../../../src/cli/desktopCaptureCommands.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { DESKTOP_CAPTURE_DEFAULTS } from "../../../src/domain/desktop/desktopCapture.js";

let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  originalExitCode = process.exitCode;
  vi.spyOn(capture, "captureDesktopApplication").mockResolvedValue({
    error: "Desktop capture failed",
    ...projectAnalysisError(
      new AnalysisCapabilityUnavailableError(
        "rea-desktop",
        "capture_desktop_application",
        "Test capture backend is unavailable",
      ),
    ),
  });
});
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

const serve = async (options: string[]) => {
  const cli = Cli.create("desktop-options-test", { sync: false });
  registerDesktopCaptureCommands(cli, pino({ level: "silent" }), {});
  let stdout = "";
  await cli.serve(
    [
      "capture-desktop-application",
      "--executable",
      "notes",
      "--output",
      "capture",
      ...options,
      "--json",
    ],
    {
      env: {},
      exit: () => {},
      stdout: (text) => {
        stdout += text;
      },
    },
  );
  return JSON.parse(stdout) as unknown;
};

it.each([
  [
    "--max-duration-seconds",
    "60",
    "--max-entries",
    "100",
    "--max-file-bytes",
    "1024",
    "--max-content-bytes",
    "4096",
  ],
  [
    "--maxDurationSeconds=60",
    "--maxEntries=100",
    "--maxFileBytes=1024",
    "--maxContentBytes=4096",
  ],
])("passes explicit decimal limits to capture: %j", async (...options) => {
  await serve(options);
  expect(capture.captureDesktopApplication).toHaveBeenCalledOnce();
  expect(
    vi.mocked(capture.captureDesktopApplication).mock.calls[0]?.[0],
  ).toMatchObject({
    maxDurationSeconds: 60,
    maxEntries: 100,
    maxFileBytes: 1024,
    maxContentBytes: 4096,
  });
});

it("keeps omitted capture limits at their existing defaults", async () => {
  await serve([]);
  expect(
    vi.mocked(capture.captureDesktopApplication).mock.calls[0]?.[0],
  ).toMatchObject(DESKTOP_CAPTURE_DEFAULTS);
});

it.each(["0", "-1", "1.5", "0x10", "1e3", "", "9007199254740992"])(
  "refuses invalid capture limit %j before invoking capture",
  async (value) => {
    expect(await serve([`--max-duration-seconds=${value}`])).toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(capture.captureDesktopApplication).not.toHaveBeenCalled();
  },
);
