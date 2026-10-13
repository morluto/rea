import { expect, it } from "vitest";
import { Cli } from "incur";
import pino from "pino";

import type { ApktoolResourceAnalysisPort } from "../../../src/application/apktool/ApktoolResourceAnalysisPort.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { registerApktoolCommands } from "../../../src/cli/apktoolCommands.js";
import { presentOmittableDefaults } from "../../../src/cli/omittableDefaults.js";
import type { ApktoolRequest } from "../../../src/domain/apktool/apktoolResourceAnalysis.js";
import { ok } from "../../../src/domain/result.js";

const invoke = async (argv: readonly string[]) => {
  const requests: ApktoolRequest[] = [];
  const provider: ApktoolResourceAnalysisPort = {
    async inspectAvailability() {
      throw new Error("unexpected provider probe");
    },
    async close() {},
    async execute(request) {
      requests.push(request);
      return ok(
        createAnalysisExecution(
          { strings: [] },
          { id: "apktool", name: "Apktool", version: null },
        ),
      );
    },
  };
  const cli = Cli.create("rea", { sync: false });
  registerApktoolCommands(cli, pino({ level: "silent" }), {}, provider);
  presentOmittableDefaults(cli);

  let stdout = "";
  let exitCode = 0;
  await cli.serve([...argv], {
    env: {},
    exit: (code) => {
      exitCode = code;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  return { exitCode, stdout, requests };
};

/**
 * Locales the apktool input owner admits. The owner's own rejection message
 * advertises `b+zh+Hans+CN`, so the CLI cannot be narrower than this list
 * without refusing a caller-selected locale the decoding lane supports.
 */
const OWNER_ADMITTED_LOCALES = [
  "de",
  "pt-BR",
  "pt-rBR",
  "zh-rCN",
  "en-419",
  "b+zh+Hans+CN",
] as const;

it("forwards every locale the apktool input owner admits", async () => {
  for (const locale of OWNER_ADMITTED_LOCALES) {
    const result = await invoke([
      "decode-android-resources",
      "/targets/app.apk",
      "--locale",
      locale,
      "--json",
    ]);

    expect(result.exitCode, `exit code for locale ${locale}`).toBe(0);
    expect(result.requests, `request for locale ${locale}`).toEqual([
      {
        operation: "decode_android_resources",
        input: { path: "/targets/app.apk", include_strings: true, locale },
      },
    ]);
  }
});

it("still refuses a locale the apktool input owner refuses", async () => {
  const result = await invoke([
    "decode-android-resources",
    "/targets/app.apk",
    "--locale",
    "not a locale",
    "--json",
  ]);

  expect(result.exitCode).not.toBe(0);
  expect(result.requests).toEqual([]);
});
