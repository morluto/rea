import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import { expect } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, runFileCli } from "../../support/cli/cliFixture.js";

const PACKAGE_LINE = "package:/data/app/example/base.apk=com.example.app";

interface AdbSelectorCase {
  readonly command: string;
  readonly field: string;
  readonly valid: string;
  readonly invalid: string;
  readonly constraint: Readonly<Record<string, unknown>>;
  /** Positional arguments between the serial and the checked field. */
  readonly between?: Readonly<Record<string, string>>;
  readonly options?: readonly string[];
}

cliTest.for<AdbSelectorCase>([
  {
    command: "list-adb-directory",
    field: "device-path",
    valid: "/sdcard",
    invalid: "sdcard",
    constraint: { expected: "regex" },
  },
  {
    command: "pull-adb-file",
    field: "device-path",
    valid: "/sdcard/notes.txt",
    invalid: "sdcard/notes.txt",
    constraint: { expected: "regex" },
    options: ["--output-directory", "pulled"],
  },
  {
    command: "push-adb-file",
    field: "device-path",
    valid: "/data/local/tmp/payload.bin",
    invalid: "data/local/tmp/payload.bin",
    constraint: { expected: "regex" },
    between: { "local-path": "payload.bin" },
  },
  {
    command: "resolve-adb-packages",
    field: "query",
    valid: "a".repeat(256),
    invalid: "a".repeat(257),
    constraint: { maximum: 256 },
  },
])(
  "publishes the enforced ADB selector constraint for $command",
  async (
    { command, field, valid, invalid, constraint, between = {}, options = [] },
    { cli },
  ) => {
    const schema = await cli.run({
      arguments: [command, "--schema", "--json"],
    });
    expect(schema.exitCode, schema.stderr).toBe(0);
    const output = schema.json as { args: Parameters<Ajv2020["compile"]>[0] };
    const validate = new Ajv2020({ strict: false }).compile(output.args);
    const leading = { serial: "emulator-5554", ...between };
    expect(validate({ ...leading, [field]: valid })).toBe(true);
    expect(validate({ ...leading, [field]: invalid })).toBe(false);
    const result = await cli.run({
      arguments: [
        command,
        ...Object.values(leading),
        invalid,
        ...options,
        "--json",
      ],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [expect.objectContaining({ path: field, ...constraint })],
    });
  },
);
const unrecognized = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => `unrecognized package row ${String(index + 1)}`,
  );

cliTest.skipIf(process.platform === "win32")(
  "reports unrecognized package rows through package search and listing via CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-adb-package-coverage-");
    const binary = join(root, "adb");
    const inventory = join(root, "packages.txt");
    await writeFile(
      binary,
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'version') {
  console.log('Android Debug Bridge version 1.0.41\\nVersion 34.0.5-fixture\\nInstalled as ' + process.argv[1]);
  process.exit(0);
}
if (args.join(' ') === '-s emulator-5554 shell pm list packages -f') {
  process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(inventory)}));
  process.exit(0);
}
process.exit(91);
`,
      { mode: 0o700 },
    );
    const environment = {
      HOME: root,
      USERPROFILE: root,
      REA_ADB_PATH: binary,
      REA_LOG_LEVEL: "silent",
    };
    const { call } = await connectLocalToolsMcp(environment);

    for (const count of [0, 1, 11]) {
      const rows = unrecognized(count);
      await writeFile(inventory, [PACKAGE_LINE, ...rows, ""].join("\n"));
      const expected = {
        unparsed_lines: rows.slice(0, 10),
        coverage: count === 0 ? "complete" : "partial",
      };
      const truncation =
        "unparsed_lines reports the first 10 of 11 unrecognized lines";

      for (const [command, operation, tail] of [
        ["resolve-adb-packages", "resolve_adb_packages", ["example"]],
        ["list-adb-packages", "list_adb_packages", []],
      ] as const) {
        const invocation = {
          arguments: [command, "emulator-5554", ...tail, "--json"],
          environment,
        };
        const output = await (count === 0
          ? cli.run(invocation)
          : runFileCli(cli, invocation));
        expect(output.exitCode, output.stderr).toBe(0);
        const evidence = parseEvidence(output.json);
        expect(
          evidence.normalized_result,
          `${command} ${String(count)}`,
        ).toMatchObject(expected);
        if (count === 11) expect(evidence.limitations).toContain(truncation);
        else
          expect(evidence.limitations).not.toContain(
            expect.stringContaining("unparsed_lines"),
          );

        const installedPackage = {
          package_name: "com.example.app",
          base_apk_device_path: "/data/app/example/base.apk",
        };
        expect(evidence.normalized_result).toMatchObject(
          operation === "resolve_adb_packages"
            ? { matches: [installedPackage], exact_match: false }
            : { packages: [installedPackage], scope: "all" },
        );
        const reply = await call(
          operation,
          operation === "resolve_adb_packages"
            ? { serial: "emulator-5554", query: "example" }
            : { serial: "emulator-5554" },
        );
        expect(reply.isError).not.toBe(true);
        const structured = toolContract(operation).outputSchema.parse(
          reply.structuredContent,
        );
        expect(structured.normalized_result).toEqual(
          evidence.normalized_result,
        );
        expect(structured.limitations).toEqual(evidence.limitations);
      }
    }
  },
);
