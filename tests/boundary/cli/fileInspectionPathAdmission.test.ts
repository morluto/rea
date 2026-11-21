import { expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import { serveInProcessCli } from "../../support/cli/serveInProcessCli.js";

/**
 * File-inspection commands whose first positional argument is a caller-selected
 * local path. `localPathAdmissionCli.test.ts` checks empty selections for the same
 * set through a real CLI process. A NUL byte cannot cross an argv boundary, so
 * that half of the contract is verified here with the in-process CLI.
 */
const fileInspectionCommands = [
  "inspect-sqlite-database",
  "inspect-python-pyc",
  "inspect-apk-signature",
  "inspect-packet-capture",
  "decode-signal-recording",
  "inspect-model-artifact",
  "inspect-elf-notes",
  "inspect-native-initializers",
  "inspect-elf-unwind-ranges",
  "inspect-kernel-module",
  "inspect-kernel-build-config",
  "inspect-byte-entropy",
  "inspect-pe-resources",
  "inspect-pe-certificates",
  "inspect-native-exports",
  "inspect-binary-layout",
  "inspect-recorded-crash",
  "inspect-go-binary",
  "inspect-rust-binary",
  "inspect-gpu-code-objects",
  "inspect-il2cpp-metadata",
  "inspect-native-data-type",
] as const;

/** The advertised local-path grammar spells NUL as `\x00`. */
const nulFreePattern = "^[^\\x00]*$";

let sharedCli: ReturnType<typeof createCli> | undefined;

const serveJson = async (
  argv: readonly string[],
): Promise<{ exitCode: number; json: Record<string, unknown> }> => {
  sharedCli ??= createCli({});
  const result = await serveInProcessCli(sharedCli, [...argv, "--json"]);
  return {
    exitCode: result.exitCode,
    json: JSON.parse(result.stdout) as Record<string, unknown>,
  };
};

it.each(fileInspectionCommands)(
  "%s advertises a NUL-free path and refuses a NUL-bearing target before analysis",
  async (command) => {
    const advertised = await serveJson([command, "--schema"]);
    const args = advertised.json.args as Record<string, unknown>;
    const properties = args.properties as Record<string, unknown>;
    const path = properties.path as Record<string, unknown>;
    expect(path, `${command} --schema`).toMatchObject({
      type: "string",
      minLength: 1,
    });
    expect(path.allOf, `${command} --schema`).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pattern: nulFreePattern }),
      ]),
    );

    const rejected = await serveJson([command, "sample\x00.bin"]);
    expect(rejected.exitCode, command).toBe(1);
    expect(rejected.json, command).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ path: "path", code: "invalid_format" }),
      ]),
    });

    // Admission is specific to invalid paths: a plain relative selection is
    // not refused on the path field. Some commands require unrelated options,
    // so only the path field is checked rather than the whole exit code.
    const admitted = await serveJson([command, "missing-sample.bin"]);
    const fieldErrors = (admitted.json.fieldErrors ?? []) as {
      path?: string;
    }[];
    expect(fieldErrors, command).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "path" })]),
    );
  },
);
