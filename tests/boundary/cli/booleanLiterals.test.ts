import { Cli, z } from "incur";
import { expect, it, vi } from "vitest";

import { registerCaptureCommands } from "../../../src/cli/captureCommands.js";
import { validateCliArguments } from "../../../src/cli/strictPositionals.js";
import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { err } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";

const install = (cli: ReturnType<typeof Cli.create>) => {
  const strict = validateCliArguments(cli);
  const original = cli.serve.bind(cli);
  cli.serve = (argv = [], options = {}) => strict(argv, options, original);
  return async (argv: readonly string[]) => {
    let stdout = "",
      exitCode = 0;
    await cli.serve([...argv, "--json"], {
      env: {},
      stdout: (text) => {
        stdout += text;
      },
      exit: (code) => {
        exitCode = code;
      },
    });
    return { exitCode, json: JSON.parse(stdout) as unknown, stdout };
  };
};

const fixture = (variadic = false) => {
  const cli = Cli.create("boolean-literals", { sync: false });
  const counters = { runs: 0, defaults: 0, transforms: 0 };
  cli.command("flags", {
    aliases: ["alias"],
    args: variadic
      ? z.object({ values: z.array(z.string()) })
      : z.object({
          value: z
            .string()
            .optional()
            .transform((value) => {
              counters.transforms++;
              return value;
            }),
        }),
    options: z.object({
      enabled: z.boolean().default(false),
      caseSensitive: z.boolean().default(false),
      debuggerContext: z.boolean().default(false),
      selected: z.string().default(() => {
        counters.defaults++;
        return "default";
      }),
      tag: z.array(z.string()).default([]),
      verbosity: z.number().default(0).meta({ count: true }),
      __rea_boolean_literal_0: z.string().optional(),
    }),
    alias: { enabled: "e", caseSensitive: "c", selected: "s", verbosity: "v" },
    run: ({ args, options }) => {
      counters.runs++;
      return { args, options };
    },
  });
  return { serve: install(cli), counters };
};

it.each(["enabled", "case-sensitive", "debugger-context"])(
  "rejects every malformed explicit --%s literal before defaults or dispatch",
  async (flag) => {
    const { serve, counters } = fixture();
    for (const literal of [
      "",
      "banana",
      "1",
      "TRUE",
      "False",
      " true",
      "false ",
      "ab\ncd",
    ]) {
      const result = await serve([
        "alias",
        `--${flag}=${literal}`,
        `--${flag}=false`,
      ]);
      expect(result.exitCode, result.stdout).toBe(1);
      expect(result.json).toMatchObject({ code: "PARSE_ERROR" });
      expect(result.stdout).toContain(`Invalid --${flag} value`);
    }
    expect(counters).toEqual({ runs: 0, defaults: 0, transforms: 0 });
  },
);

it("preserves bare, negated, equals, camel-case and stacked counted aliases", async () => {
  const { serve, counters } = fixture();
  for (const [argv, enabled, caseSensitive, verbosity] of [
    [["--enabled"], true, false, 0],
    [["--no-enabled"], false, false, 0],
    [["--enabled=true"], true, false, 0],
    [["--enabled=false"], false, false, 0],
    [["--caseSensitive=true"], false, true, 0],
    [["-ecvv"], true, true, 2],
  ] as const) {
    const result = await serve(["flags", ...argv]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.json).toMatchObject({
      options: { enabled, caseSensitive, verbosity },
    });
  }
  expect(counters).toEqual({ runs: 6, defaults: 6, transforms: 6 });
});

it("keeps flag-shaped string data and the SDK's separator refusal unchanged", async () => {
  const { serve } = fixture();
  for (const value of [
    "--enabled=banana",
    "--caseSensitive=1",
    "--not-an-option=x",
    "--__rea_boolean_literal_0=bad",
  ]) {
    const result = await serve(["flags", "-s", value, "--enabled=false"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.json).toMatchObject({
      options: { selected: value, enabled: false },
    });
  }
  const positional = await serve(["flags", "--", "--enabled=banana"]);
  expect(positional.exitCode).toBe(1);
  expect(positional.stdout).toContain("Unknown flag: --");
  const arrayData = await serve(["flags", "--tag", "--enabled=banana"]);
  expect(arrayData.exitCode, arrayData.stdout).toBe(0);
  expect(arrayData.json).toMatchObject({
    options: { tag: ["--enabled=banana"], enabled: false },
  });
});

it("validates booleans on variadic commands while preserving their literal tail", async () => {
  const { serve, counters } = fixture(true);
  const invalid = await serve(["flags", "one", "two", "--enabled=banana"]);
  expect(invalid.exitCode).toBe(1);
  expect(counters.runs).toBe(0);
  const valid = await serve(["flags", "one", "two", "-s", "--enabled=banana"]);
  expect(valid.exitCode, valid.stdout).toBe(0);
  expect(valid.json).toMatchObject({
    args: { values: ["one", "two"] },
    options: { enabled: false, selected: "--enabled=banana" },
  });
});

it("avoids retained-name collisions and reports original surplus tokens", async () => {
  const { serve } = fixture();
  const valid = await serve([
    "flags",
    "--__rea_boolean_literal_0=kept",
    "--enabled=true",
  ]);
  expect(valid.exitCode, valid.stdout).toBe(0);
  expect(valid.json).toMatchObject({
    options: { __rea_boolean_literal_0: "kept", enabled: true },
  });
  const unknown = await serve([
    "flags",
    "--__rea_boolean_literal_1=x",
    "--enabled=true",
  ]);
  expect(unknown.exitCode).toBe(1);
  expect(unknown.stdout).toContain("Unknown flag: --__rea_boolean_literal_1");
  const extra = await serve(["flags", "one", "two", "--enabled=true"]);
  expect(extra.exitCode).toBe(1);
  expect(extra.stdout).toContain("Unexpected positional arguments");
  expect(extra.stdout).toContain("two");
  expect(extra.stdout).not.toContain("__rea_boolean_literal_");
});

it("rejects a real packet-command boolean before its service and keeps valid all/limit projection", async () => {
  const cli = Cli.create("packet-booleans", { sync: false });
  const service = {
    inspect: vi.fn(async () =>
      err(new AnalysisInputError("inspect_packet_capture", undefined, [])),
    ),
    inspectFields: vi.fn(async (_input: unknown) =>
      err(new AnalysisInputError("inspect_packet_fields", undefined, [])),
    ),
    close: vi.fn(async () => undefined),
  };
  registerCaptureCommands(cli, silentLogger, {}, service);
  const serve = install(cli);
  const invalid = await serve([
    "inspect-packet-fields",
    "--all=banana",
    "--limit",
    "1",
  ]);
  expect(invalid.exitCode).toBe(1);
  expect(invalid.json).toMatchObject({ code: "PARSE_ERROR" });
  expect(service.inspectFields).not.toHaveBeenCalled();
  expect(service.close).not.toHaveBeenCalled();
  await serve(["inspect-packet-fields", "--all=false", "--limit", "1"]);
  await serve(["inspect-packet-fields", "--all=true"]);
  expect(
    service.inspectFields.mock.calls.map(([input]) => input),
  ).toMatchObject([{ limit: 1 }, { limit: null }]);
  expect(service.close).toHaveBeenCalledTimes(2);
});

it("uses the SDK's resolved group alias for boolean admission", async () => {
  const run = vi.fn(
    ({ options }: { options: { enabled: boolean } }) => options,
  );
  const group = Cli.create("group", { sync: false }).command("flags", {
    aliases: ["alias"],
    options: z.object({ enabled: z.boolean().default(false) }),
    run,
  });
  const serve = install(
    Cli.create("group-booleans", { sync: false }).command(group),
  );
  const invalid = await serve(["group", "alias", "--enabled=banana"]);
  expect(invalid.exitCode).toBe(1);
  expect(invalid.json).toMatchObject({ code: "PARSE_ERROR" });
  expect(run).not.toHaveBeenCalled();
  const valid = await serve(["group", "alias", "--enabled=false"]);
  expect(valid.exitCode, valid.stdout).toBe(0);
  expect(valid.json).toEqual({ enabled: false });
});

it("leaves explicitly coercing schemas to their declared owner", async () => {
  const cli = Cli.create("coercing-control", { sync: false }).command("flags", {
    options: z.object({
      enabled: z.boolean().default(false),
      permissive: z.coerce.boolean().optional(),
      text: z.string().optional(),
    }),
    run: ({ options }) => options,
  });
  const serve = install(cli);
  const result = await serve([
    "flags",
    "--enabled=false",
    "--permissive=banana",
    "--text=banana",
  ]);
  expect(result.exitCode, result.stdout).toBe(0);
  expect(result.json).toEqual({
    enabled: false,
    permissive: false,
    text: "banana",
  });
});
