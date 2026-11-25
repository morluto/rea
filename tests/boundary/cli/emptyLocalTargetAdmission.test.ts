import { createCommandCli } from "../../support/cli/commandCli.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, vi } from "vitest";
import { serveInProcessCli } from "../../support/cli/serveInProcessCli.js";
import { registerArtifactCommands } from "../../../src/cli/artifactCommands.js";
import { registerCoreBinaryCommands } from "../../../src/cli/coreBinaryCommands.js";
import { registerCoreNativeCommands } from "../../../src/cli/coreNativeCommands.js";
import { registerManagedCommands } from "../../../src/cli/managedCommands.js";
import { registerUtilityCommands } from "../../../src/cli/utilityCommands.js";
import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { silentLogger } from "../../../src/logger.js";

const registry = () => {
  const failure = {
    ok: false as const,
    error: { code: "invalid_request", message: "Admitted target control" },
  };
  const run = () =>
    vi.fn(async (_path: string, ..._rest: unknown[]) => failure);
  const runDirectAnalysis = run();
  const runProviderAnalysis = run();
  const runManagedProviderEvidence = vi.fn(
    async (_path: string, ..._rest: unknown[]) =>
      ({
        ok: false,
        error: new AnalysisInputError("inspect_managed_members", undefined, [
          {
            path: ["path"],
            reason: "invalid_value",
            message: "Admitted target control",
          },
        ]),
      }) as const,
  );
  const cli = createCommandCli();
  registerArtifactCommands(cli, silentLogger, runProviderAnalysis, {});
  registerCoreBinaryCommands(cli, silentLogger, runDirectAnalysis, {});
  registerCoreNativeCommands(cli, silentLogger, runDirectAnalysis);
  registerManagedCommands(cli, silentLogger, {
    runProviderAnalysis,
    runManagedProviderEvidence,
  });
  registerUtilityCommands(
    cli,
    silentLogger,
    {},
    {
      runProviderAnalysis,
      runSessionStatus: async () => ({ ok: false, error: null }),
    },
  );
  const serve = async (argv: readonly string[]): Promise<unknown> => {
    const { stdout } = await serveInProcessCli(cli, [...argv, "--json"]);
    return JSON.parse(stdout);
  };
  return {
    serve,
    runs: [runDirectAnalysis, runProviderAnalysis],
    runManagedProviderEvidence,
  };
};

// Each command with its other required arguments; the target comes first.
const commands: readonly (readonly string[])[] = [
  ["inspect-artifact"],
  ["extract-artifact"],
  ["inspect-keyed-archive"],
  ["trace-dylib-resolution"],
  ["inspect-asset-catalog"],
  ["decode-interface-builder"],
  ["inspect"],
  ["decompile", "main"],
  ["xrefs", "0x1000"],
  ["trace", "feature"],
  ["function", "0x1000"],
  ["instructions", "0x1000"],
  ["search", "name"],
  ["search-bytes", "00"],
  ["inspect-native-load-image"],
  ["read-bytes", "0x1000"],
  ["address-to-file-offset", "0x1000"],
  ["trace-native-values", "main"],
  ["inspect-native-data-type", "--type", "/MyStruct"],
  ["inspect-native-instruction", "0x1000"],
  ["resolve-native-call-targets", "0x1000"],
  ["inspect-native-dispatch-metadata"],
  ["trace-native-ui-action", "openDocument:"],
  ["inspect-native-api", "0x1000"],
  ["annotate-native-function", "main", "--name", "entry"],
  ["inspect-managed-artifact"],
  ["inspect-managed-members"],
  ["inspect-managed-native-boundaries"],
  ["observe-native-ui", "--pid", "1", "--window-id", "1"],
  [
    "capture-native-ui-scenario",
    "--pid",
    "1",
    "--window-id",
    "1",
    "--steps",
    '[{"kind":"wait","milliseconds":0}]',
  ],
  ["inspect-macho"],
  ["inspect-signature"],
  ["list-architectures"],
  ["inspect-plist"],
  ["demangle-swift", "$s4main"],
];

it.each(commands)(
  "rejects an empty or NUL %s target before resolution and admits explicit .",
  async (command, ...rest) => {
    const { serve, runs } = registry();
    // docs/getting-started/cli.md: an empty string never selects the working directory.
    expect(await serve([command, "", ...rest])).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [
        expect.objectContaining({ path: "path", code: "too_small" }),
      ],
    });
    expect(await serve([command, "target\x00name", ...rest])).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [
        expect.objectContaining({ path: "path", code: "invalid_format" }),
      ],
    });
    for (const run of runs) expect(run).not.toHaveBeenCalled();
    await serve([command, ".", ...rest]);
    expect(runs.flatMap((run) => run.mock.calls.map(([path]) => path))).toEqual(
      ["."],
    );
  },
);

it.each([
  { argv: ["", "."], field: "leftPath" },
  { argv: [".", ""], field: "rightPath" },
])(
  "rejects an empty compare-managed-members $field before reading either input",
  async ({ argv, field }) => {
    const { serve, runManagedProviderEvidence } = registry();
    expect(await serve(["compare-managed-members", ...argv])).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [
        expect.objectContaining({ path: field, code: "too_small" }),
      ],
    });
    expect(runManagedProviderEvidence).not.toHaveBeenCalled();
  },
);

it.each([
  {
    command: "inspect-plist",
    field: "relativePath",
    valid: "Contents/Info.plist",
    invalid: ["", "Contents/a\x00b"],
  },
  {
    command: "trace-dylib-resolution",
    field: "root",
    valid: ["Contents/MacOS/app"],
    invalid: [[""], ["Contents/a\x00b"], ["../outside"]],
  },
])(
  "advertises the $field option constraints",
  async ({ command, field, valid, invalid }) => {
    const { serve } = registry();
    const schema = (await serve([command, "--schema"])) as { options: object };
    const validate = new Ajv2020({ strict: false }).compile(schema.options);
    expect(validate({})).toBe(true);
    expect(validate({ [field]: valid })).toBe(true);
    for (const value of invalid)
      expect(validate({ [field]: value })).toBe(false);
  },
);

it("rejects an empty or NUL --snapshot option before analysis", async () => {
  const { serve, runs } = registry();
  expect(await serve(["inspect", ".", "--snapshot", ""])).toMatchObject({
    code: "VALIDATION_ERROR",
    fieldErrors: [
      expect.objectContaining({ path: "snapshot", code: "too_small" }),
    ],
  });
  expect(
    await serve(["inspect", ".", "--snapshot", "snap\x00shot"]),
  ).toMatchObject({
    code: "VALIDATION_ERROR",
    fieldErrors: [
      expect.objectContaining({ path: "snapshot", code: "invalid_format" }),
    ],
  });
  for (const run of runs) expect(run).not.toHaveBeenCalled();
});

it.each([
  { argv: ["inspect-plist", ".", "--relative-path"], field: "relativePath" },
  { argv: ["trace-dylib-resolution", ".", "--root"], field: "root" },
])(
  "rejects an empty or NUL $field option on the CLI and names that option",
  async ({ argv, field }) => {
    const { serve, runs } = registry();
    for (const value of ["", "Contents/a\x00b"]) {
      const result = (await serve([...argv, value])) as {
        code: string;
        fieldErrors: readonly { path: string }[];
      };
      expect(result.code).toBe("VALIDATION_ERROR");
      expect(
        new Set(result.fieldErrors.map(({ path }) => path.split(".")[0])),
      ).toEqual(new Set([field]));
    }
    for (const run of runs) expect(run).not.toHaveBeenCalled();
  },
);
