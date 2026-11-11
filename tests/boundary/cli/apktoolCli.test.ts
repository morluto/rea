import { expect, it } from "vitest";

import {
  expectConfigurationRefusal,
  serveCli as serve,
} from "./cliServeHarness.js";

it.each([
  [
    ["inspect-apktool-client", "--json"],
    "/nonexistent/apktool",
    "The selected apktool launcher was not found: /nonexistent/apktool. Set REA_APKTOOL_COMMAND",
  ],
  [
    ["decode-android-resources", "/targets/app.apk", "--json"],
    "/nonexistent/apktool",
    "The selected apktool launcher was not found: /nonexistent/apktool. Set REA_APKTOOL_COMMAND",
  ],
  [
    ["decode-android-resources", "/targets/app.apk", "--json"],
    "relative/apktool",
    "REA_APKTOOL_COMMAND must be an absolute path to the apktool launcher.",
  ],
])(
  "%j with REA_APKTOOL_COMMAND=%s names the host requirement",
  async (argv, command, reason) => {
    const result = await serve(argv, { REA_APKTOOL_COMMAND: command });
    expectConfigurationRefusal(result, reason);
  },
);

it("validates the locale option before launching apktool", async () => {
  const result = await serve([
    "decode-android-resources",
    "/targets/app.apk",
    "--locale",
    "not a locale",
    "--json",
  ]);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    code: "VALIDATION_ERROR",
    fieldErrors: [
      {
        code: "invalid_format",
        path: "locale",
      },
    ],
  });
});

it("reports each invocation's effective exit status and restores the host status", async () => {
  const originalExitCode = process.exitCode;
  process.exitCode = 23;
  try {
    const environment = { REA_APKTOOL_COMMAND: "/nonexistent/apktool" };
    const failed = await serve(
      ["inspect-apktool-client", "--json"],
      environment,
    );
    expect(failed.exitCode).toBe(1);
    expectConfigurationRefusal(
      failed,
      "The selected apktool launcher was not found",
    );
    expect(process.exitCode).toBe(23);

    const success = await serve(
      ["inspect-apktool-client", "--help"],
      environment,
    );
    expect(success.exitCode).toBe(0);
    expect(success.stdout).toContain(
      "Inspect the caller-selected apktool launcher",
    );
    expect(process.exitCode).toBe(23);

    const parserFailure = await serve(
      [
        "decode-android-resources",
        "/targets/app.apk",
        "--locale",
        "not a locale",
        "--json",
      ],
      environment,
    );
    expect(parserFailure.exitCode).toBe(1);
    expect(JSON.parse(parserFailure.stdout)).toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(process.exitCode).toBe(23);
  } finally {
    process.exitCode = originalExitCode;
  }
});
