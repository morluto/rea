import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { Cli, z } from "incur";
import { expect, it, vi } from "vitest";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import type { AdbDeviceAnalysisPort } from "../../../src/application/adb/AdbDeviceAnalysisPort.js";
import type { ApktoolResourceAnalysisPort } from "../../../src/application/apktool/ApktoolResourceAnalysisPort.js";
import { ok } from "../../../src/domain/result.js";
import { registerAdbCommands } from "../../../src/cli/adbCommands.js";
import { registerApktoolCommands } from "../../../src/cli/apktoolCommands.js";
import { registerDecompileDirectoryCommand } from "../../../src/cli/decompileDirectoryCommand.js";
import { registerCoreBinaryCommands } from "../../../src/cli/coreBinaryCommands.js";
import { registerSqliteCommands } from "../../../src/cli/sqliteCommands.js";
import { visitRegisteredCommands } from "../../../src/cli/visitRegisteredCommands.js";
import { silentLogger } from "../../../src/logger.js";

const registry = () => {
  const failure = {
    ok: false as const,
    error: { code: "invalid_request", message: "Admitted target control" },
  };
  const identity = { id: "stub", name: "Stub provider", version: null };
  const adbExecute = vi.fn(async () =>
    ok(createAnalysisExecution({}, identity)),
  );
  const apktoolExecute = vi.fn(async () =>
    ok(createAnalysisExecution({}, identity)),
  );
  const runDirectAnalysis = vi.fn(async () => failure);
  const adbProvider: AdbDeviceAnalysisPort = {
    inspectAvailability: async () => ({
      status: "available",
      code: null,
      reason: null,
      diagnostics: {},
    }),
    close: async () => {},
    execute: adbExecute,
  };
  const apktoolProvider: ApktoolResourceAnalysisPort = {
    inspectAvailability: async () => ({
      status: "available",
      code: null,
      reason: null,
      diagnostics: {},
    }),
    close: async () => {},
    execute: apktoolExecute,
  };
  const cli = Cli.create("overnight-batch1-cli-schemas", { sync: false });
  registerAdbCommands(cli, silentLogger, {}, adbProvider);
  registerApktoolCommands(cli, silentLogger, {}, apktoolProvider);
  registerCoreBinaryCommands(cli, silentLogger, runDirectAnalysis, {});
  registerSqliteCommands(cli, silentLogger, {});
  registerDecompileDirectoryCommand(cli, silentLogger, runDirectAnalysis);
  const serve = async (argv: readonly string[]): Promise<unknown> => {
    let stdout = "";
    await cli.serve([...argv, "--json"], {
      env: {},
      stdout: (text) => {
        stdout += text;
      },
      exit: () => undefined,
    });
    return JSON.parse(stdout);
  };
  return { cli, serve, adbExecute, apktoolExecute, runDirectAnalysis };
};

/**
 * ADB local-path arguments (#9714). `before` holds the argv up to the
 * value under test; `after` holds the argv that follows it.
 */
const adbLocalPathCases: readonly {
  readonly label: string;
  readonly field: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}[] = [
  {
    label: "pull-adb-package --output-directory",
    field: "output-directory",
    before: [
      "pull-adb-package",
      "emulator-5554",
      "com.example",
      "--output-directory",
    ],
    after: [],
  },
  {
    label: "pull-adb-file --output-directory",
    field: "output-directory",
    before: [
      "pull-adb-file",
      "emulator-5554",
      "/data/local/tmp/drop",
      "--output-directory",
    ],
    after: [],
  },
  {
    label: "push-adb-file --local-path",
    field: "local-path",
    before: ["push-adb-file", "emulator-5554"],
    after: ["/data/local/tmp/drop"],
  },
  {
    label: "capture-adb-screen --output-directory",
    field: "output-directory",
    before: ["capture-adb-screen", "emulator-5554", "--output-directory"],
    after: [],
  },
  {
    label: "collect-adb-bugreport --output-directory",
    field: "output-directory",
    before: ["collect-adb-bugreport", "emulator-5554", "--output-directory"],
    after: [],
  },
  {
    label: "install-adb-package --apk-path",
    field: "apk-path",
    before: ["install-adb-package", "emulator-5554"],
    after: [],
  },
];

it.each(adbLocalPathCases)(
  "rejects an empty or NUL $label before contacting adb and admits a plain path",
  async ({ field, before, after }) => {
    const { serve, adbExecute } = registry();
    expect(await serve([...before, "", ...after])).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [
        expect.objectContaining({ path: field, code: "too_small" }),
      ],
    });
    expect(await serve([...before, "out\x00dir", ...after])).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [
        expect.objectContaining({ path: field, code: "invalid_format" }),
      ],
    });
    expect(adbExecute).not.toHaveBeenCalled();
    await serve([...before, "out", ...after]);
    expect(adbExecute).toHaveBeenCalledTimes(1);
  },
);

it("rejects an empty or NUL decode-android-resources path before launching apktool and admits a plain path", async () => {
  const { serve, apktoolExecute } = registry();
  expect(await serve(["decode-android-resources", ""])).toMatchObject({
    code: "VALIDATION_ERROR",
    fieldErrors: [expect.objectContaining({ path: "path", code: "too_small" })],
  });
  expect(
    await serve(["decode-android-resources", "app\x00.apk"]),
  ).toMatchObject({
    code: "VALIDATION_ERROR",
    fieldErrors: [
      expect.objectContaining({ path: "path", code: "invalid_format" }),
    ],
  });
  expect(apktoolExecute).not.toHaveBeenCalled();
  await serve(["decode-android-resources", "app.apk"]);
  expect(apktoolExecute).toHaveBeenCalledTimes(1);
});

it.each([["analyze"], ["inspect"], ["decompile-all", "--output", "out"]])(
  "rejects an empty or NUL --snapshot on %s before analysis and admits a plain path",
  async (command, ...required) => {
    const { serve, runDirectAnalysis } = registry();
    expect(
      await serve([command, ".", ...required, "--snapshot", ""]),
    ).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [
        expect.objectContaining({ path: "snapshot", code: "too_small" }),
      ],
    });
    expect(
      await serve([command, ".", ...required, "--snapshot", "snap\x00shot"]),
    ).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [
        expect.objectContaining({ path: "snapshot", code: "invalid_format" }),
      ],
    });
    expect(runDirectAnalysis).not.toHaveBeenCalled();
    await serve([command, ".", ...required, "--snapshot", "snapshot.db"]);
    expect(runDirectAnalysis).toHaveBeenCalled();
  },
);

it.each([
  { argv: ["--row-limit", "5"], field: "rowLimit" },
  { argv: ["--row-offset", "1"], field: "rowOffset" },
  { argv: ["--column", "c"], field: "column" },
  { argv: ["--schema-scope", "selected_table"], field: "schemaScope" },
])(
  "rejects inspect-sqlite-database $field without --table",
  async ({ argv, field }) => {
    const { serve } = registry();
    expect(
      await serve(["inspect-sqlite-database", "db.sqlite", ...argv]),
    ).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [expect.objectContaining({ path: field, code: "custom" })],
    });
  },
);

it("rejects an empty column array in the inspect-sqlite-database options schema", () => {
  const { cli } = registry();
  let options: unknown;
  visitRegisteredCommands(cli, (command, path) => {
    if (path === "inspect-sqlite-database") options = command.options;
  });
  expect(options).toBeInstanceOf(z.ZodObject);
  if (!(options instanceof z.ZodObject)) throw new Error("unreachable");
  const parsed = options.safeParse({ column: [] });
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  expect(parsed.error.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: ["column"], code: "too_small" }),
    ]),
  );
});

it("admits --table with --column and --row-limit to runtime validation", async () => {
  const { serve } = registry();
  const missing = join(
    await createTestTempDirectory("rea-sqlite-admission-"),
    "missing.db",
  );
  // The SQLite worker only runs from the built CLI, so this boundary test
  // proves admission with a missing snapshot: CLI validation passes and the
  // runtime refuses the absent file instead of the option combination. The
  // end-to-end read is covered by tests/acceptance/sqliteDatabaseCli.test.ts.
  expect(
    await serve([
      "inspect-sqlite-database",
      missing,
      "--table",
      "t",
      "--column",
      "c",
      "--row-limit",
      "5",
    ]),
  ).toMatchObject({
    code: "invalid_request",
    details: {
      operation: "inspect_sqlite_database",
      issues: [
        expect.objectContaining({
          path: ["path"],
          message: expect.stringContaining(
            "Selected SQLite database does not exist",
          ),
        }),
      ],
    },
  });
});

it("advertises SQLite selection dependencies in CLI discovery", async () => {
  const { serve } = registry();
  const schema = await serve(["inspect-sqlite-database", "--schema"]);
  const { options } = z
    .object({ options: z.record(z.string(), z.unknown()) })
    .parse(schema);
  const validate = new Ajv2020({ strict: false }).compile(options);
  expect(validate({ column: ["id"] })).toBe(false);
  expect(validate({ schemaScope: "selected_table" })).toBe(false);
  expect(validate({ table: "items", column: [] })).toBe(false);
  expect(
    validate({ table: "items", column: ["id"], schemaScope: "selected_table" }),
  ).toBe(true);
  expect(schema).toMatchObject({
    options: {
      dependentRequired: {
        rowLimit: ["table"],
        rowOffset: ["table"],
        column: ["table"],
      },
      if: {
        properties: { schemaScope: { const: "selected_table" } },
        required: ["schemaScope"],
      },
      then: { required: ["table"] },
      properties: { column: { minItems: 1 } },
    },
  });
});
