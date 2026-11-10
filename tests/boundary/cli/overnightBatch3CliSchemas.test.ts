import { Cli } from "incur";
import { expect, it, vi } from "vitest";
import { z } from "incur";
import { registerCoreNativeCommands } from "../../../src/cli/coreNativeCommands.js";
import { registerUtilityCommands } from "../../../src/cli/utilityCommands.js";
import { registerWebNetworkCaptureCommands } from "../../../src/cli/webNetworkCaptureCommands.js";
import { visitRegisteredCommands } from "../../../src/cli/visitRegisteredCommands.js";
import { silentLogger } from "../../../src/logger.js";

const registry = () => {
  const failure = {
    ok: false as const,
    error: { code: "invalid_request", message: "Admitted target control" },
  };
  const runDirectAnalysis = vi.fn(async () => failure);
  const runProviderAnalysis = vi.fn(async () => failure);
  const cli = Cli.create("overnight-batch3-cli-schemas", { sync: false });
  registerCoreNativeCommands(cli, silentLogger, runDirectAnalysis);
  registerUtilityCommands(
    cli,
    silentLogger,
    {},
    {
      runProviderAnalysis,
      runSessionStatus: async () => ({ ok: false, error: null }),
    },
  );
  registerWebNetworkCaptureCommands(cli, silentLogger, {});
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
  return { cli, serve, runDirectAnalysis, runProviderAnalysis };
};

// #9767: inspect_web_network_capture runtime schema requires at least one
// record ordinal when record selection is supplied.
it("rejects an empty --record array for #9767 in the CLI options schema", () => {
  const { cli } = registry();
  let options: unknown;
  visitRegisteredCommands(cli, (command, path) => {
    if (path === "inspect-web-network-capture") options = command.options;
  });
  expect(options).toBeInstanceOf(z.ZodObject);
  if (!(options instanceof z.ZodObject)) throw new Error("unreachable");
  const parsed = options.safeParse({ record: [] });
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  expect(parsed.error.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: ["record"], code: "too_small" }),
    ]),
  );
});

it("admits a nonempty --record selection for #9767 past CLI validation", async () => {
  const { serve } = registry();
  const result = await serve([
    "inspect-web-network-capture",
    "missing.har",
    "har",
    "--record",
    "0",
  ]);
  expect(result).not.toMatchObject({ code: "VALIDATION_ERROR" });
});

// #9764: inspect-plist paths must reject empty/NUL values before provider
// execution; the positional path already uses localPathStringSchema, while
// --relative-path is still a bare string.
it.each([
  { value: "", code: "too_small" },
  { value: "Info\x00.plist", code: "invalid_format" },
])(
  "rejects --relative-path $value for #9764 before provider execution",
  async ({ value, code }) => {
    const { serve, runProviderAnalysis } = registry();
    expect(
      await serve(["inspect-plist", "app", "--relative-path", value]),
    ).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [
        expect.objectContaining({ path: "relativePath", code }),
      ],
    });
    expect(runProviderAnalysis).not.toHaveBeenCalled();
  },
);

it("admits a plain --relative-path for #9764 to provider execution", async () => {
  const { serve, runProviderAnalysis } = registry();
  await serve([
    "inspect-plist",
    "app",
    "--relative-path",
    "Contents/Info.plist",
  ]);
  expect(runProviderAnalysis).toHaveBeenCalled();
});

// #9757: annotate_native_function runtime schema requires a nonempty
// procedure selector.
it("rejects an empty procedure for #9757 before provider execution", async () => {
  const { serve, runDirectAnalysis } = registry();
  expect(
    await serve(["annotate-native-function", "app", "", "--name", "entry"]),
  ).toMatchObject({
    code: "VALIDATION_ERROR",
    fieldErrors: [
      expect.objectContaining({ path: "procedure", code: "too_small" }),
    ],
  });
  expect(runDirectAnalysis).not.toHaveBeenCalled();
});

it("admits a nonempty procedure for #9757 to provider execution", async () => {
  const { serve, runDirectAnalysis } = registry();
  await serve(["annotate-native-function", "app", "main", "--name", "entry"]);
  expect(runDirectAnalysis).toHaveBeenCalled();
});
