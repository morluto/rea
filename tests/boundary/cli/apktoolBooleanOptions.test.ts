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

it("dispatches --no-strings as include_strings false", async () => {
  const result = await invoke([
    "decode-android-resources",
    "/targets/app.apk",
    "--no-strings",
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.requests).toEqual([
    {
      operation: "decode_android_resources",
      input: { path: "/targets/app.apk", include_strings: false },
    },
  ]);
});

it("keeps string projection enabled when the flag is omitted", async () => {
  const result = await invoke([
    "decode-android-resources",
    "/targets/app.apk",
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.requests).toEqual([
    {
      operation: "decode_android_resources",
      input: { path: "/targets/app.apk", include_strings: true },
    },
  ]);
});

it("documents the supported negative flag in command help", async () => {
  const result = await invoke(["decode-android-resources", "--help"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("--no-strings");
});
