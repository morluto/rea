import { Ajv2020 } from "ajv/dist/2020.js";
import { Cli } from "incur";
import { expect, it, vi } from "vitest";

import { registerArtifactCommands } from "../../../src/cli/artifactCommands.js";
import { dylibResolutionInputSchema } from "../../../src/domain/apple/dylibResolution.js";
import { silentLogger } from "../../../src/logger.js";

const registry = () => {
  const run = vi.fn(async (_path: string, ..._rest: unknown[]) => ({
    ok: false as const,
    error: { code: "invalid_request", message: "Admitted selector control" },
  }));
  const cli = Cli.create("dylib-selector-schema", { sync: false });
  registerArtifactCommands(cli, silentLogger, run);
  const serve = async (argv: readonly string[]): Promise<unknown> => {
    let stdout = "";
    await cli.serve(["trace-dylib-resolution", ...argv, "--json"], {
      env: {},
      stdout: (text) => {
        stdout += text;
      },
      exit: () => undefined,
    });
    return JSON.parse(stdout) as unknown;
  };
  return { serve, run };
};

it("advertises the canonical optional root and architecture selectors", async () => {
  const { serve } = registry();
  const schema = (await serve(["--schema"])) as {
    options: Record<string, unknown>;
  };
  expect(schema.options).toMatchObject({
    properties: {
      root: {
        minItems: 1,
        items: { minLength: 1, pattern: expect.any(String) },
      },
    },
  });
  const options = new Ajv2020({ strict: false }).compile(schema.options);
  const cases = [
    [{}, true],
    [{ root: ["App"] }, true],
    [{ root: ["App", "App"] }, true],
    [{ root: ["Contents/MacOS/App", ".helper"], architecture: "arm64" }, true],
    [{ root: ["App"], architecture: "x86_64" }, true],
    [{ root: ["App"], architecture: "arm64e" }, true],
    [{ root: [] }, false],
    [{ root: [""] }, false],
    [{ root: ["."] }, false],
    [{ root: [".."] }, false],
    [{ root: ["../App"] }, false],
    [{ root: ["/App"] }, false],
    [{ root: ["App//helper"] }, false],
    [{ root: ["App\\helper"] }, false],
    [{ root: ["App\u0000helper"] }, false],
    [{ architecture: "armv7" }, false],
  ] as const;
  for (const [value, accepted] of cases) {
    expect(options(value), JSON.stringify(value)).toBe(accepted);
    expect(
      dylibResolutionInputSchema.safeParse({
        roots: "root" in value ? value.root : undefined,
        architecture: "architecture" in value ? value.architecture : undefined,
      }).success,
    ).toBe(accepted);
  }
});

it.each(["", ".", "..", "../App", "/App", "App//helper", "App\\helper"])(
  "refuses malformed root %j before provider dispatch",
  async (root) => {
    const { serve, run } = registry();
    expect(await serve(["fixture.app", "--root", root])).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ path: "root.0" }),
      ]),
    });
    expect(run).not.toHaveBeenCalled();
  },
);

it("forwards repeated roots and architecture and preserves omitted selectors", async () => {
  const { serve, run } = registry();
  await serve([
    "fixture.app",
    "--root",
    "App",
    "--root",
    ".helper",
    "--architecture",
    "arm64",
  ]);
  await serve(["fixture.app"]);
  expect(run.mock.calls).toEqual([
    [
      "fixture.app",
      "trace_dylib_resolution",
      { roots: ["App", ".helper"], architecture: "arm64" },
      silentLogger,
    ],
    ["fixture.app", "trace_dylib_resolution", {}, silentLogger],
  ]);
});
