import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { Cli, z } from "incur";
import { expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";

type CliInstance = ReturnType<typeof createCli>;
type CommandMap = NonNullable<ReturnType<typeof Cli.toCommands.get>>;

const registeredCommands: WeakMap<object, CommandMap> = Cli.toCommands;

const serve = async (cli: CliInstance, argv: readonly string[]) => {
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
  expect(exitCode, argv.join(" ")).toBe(0);
  return z
    .object({
      args: z
        .object({ properties: z.record(z.string(), z.unknown()) })
        .passthrough()
        .optional(),
      options: z
        .object({ properties: z.record(z.string(), z.unknown()) })
        .passthrough()
        .optional(),
    })
    .parse(JSON.parse(stdout));
};

const absoluteMapping =
  process.platform === "win32" ? "C:\\mapping.txt" : "/tmp/mapping.txt";

it("advertises the domain constraints for android, adb settings, and browser selectors", async () => {
  const cli = createCli({});
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const validate = async (
    command: string,
    group: "args" | "options",
    value: Record<string, unknown>,
  ) => {
    const advertised = await serve(cli, [command, "--schema", "--json"]);
    const schema = advertised[group];
    expect(schema, command).toBeDefined();
    return ajv.compile(schema as AnySchema)(value);
  };

  expect(
    await validate("inspect-android-class", "args", {
      path: "",
      className: "com.example.Main",
    }),
  ).toBe(false);
  expect(
    await validate("inspect-android-class", "args", {
      path: "app.apk",
      className: "",
    }),
  ).toBe(false);
  expect(
    await validate("inspect-android-class", "args", {
      path: "app.apk",
      className: "com.example.Main",
    }),
  ).toBe(true);
  expect(
    await validate("inspect-android-class", "options", {
      mappingPath: "mapping.txt",
    }),
  ).toBe(false);
  expect(
    await validate("inspect-android-class", "options", {
      mappingPath: absoluteMapping,
    }),
  ).toBe(true);
  expect(
    await validate("inspect-android-method", "args", {
      path: "app.apk",
      className: "com.example.Main",
      methodName: "",
    }),
  ).toBe(false);

  const setting = {
    serial: "emulator-5554",
    namespace: "system",
  };
  expect(
    await validate("read-adb-setting", "args", {
      ...setting,
      key: "key with space",
    }),
  ).toBe(false);
  expect(
    await validate("read-adb-setting", "args", {
      ...setting,
      key: "k".repeat(257),
    }),
  ).toBe(false);
  expect(
    await validate("read-adb-setting", "args", {
      ...setting,
      key: "airplane_mode_on",
    }),
  ).toBe(true);

  const listener = {
    targetId: "page",
    selector: "button",
  };
  expect(
    await validate("inspect-web-event-listeners", "args", {
      ...listener,
      endpoint: "",
    }),
  ).toBe(false);
  expect(
    await validate("inspect-web-event-listeners", "args", {
      endpoint: "http://127.0.0.1:9222",
      targetId: "",
      selector: "button",
    }),
  ).toBe(false);
  expect(
    await validate("inspect-web-event-listeners", "args", {
      endpoint: "http://127.0.0.1:9222",
      ...listener,
      selector: "",
    }),
  ).toBe(false);
  expect(
    await validate("inspect-web-event-listeners", "args", {
      endpoint: "http://127.0.0.1:9222",
      ...listener,
    }),
  ).toBe(true);
  expect(
    await validate("capture-web-screenshot", "args", {
      endpoint: "",
      targetId: "page",
    }),
  ).toBe(false);
  expect(
    await validate("capture-web-screenshot", "args", {
      endpoint: "http://127.0.0.1:9222",
      targetId: "page",
    }),
  ).toBe(true);

  const parser = registeredCommands.get(cli)?.get("inspect-android-class");
  expect(parser && "args" in parser && parser.args instanceof z.ZodObject).toBe(
    true,
  );
  if (parser && "args" in parser && parser.args instanceof z.ZodObject)
    expect(
      parser.args.safeParse({ path: "app.apk", className: "" }).success,
    ).toBe(false);
});

it("advertises selection dependencies after omittable-default projection", async () => {
  const cli = createCli({});
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  for (const [command, invalid, valid] of [
    [
      "inspect-packet-fields",
      { all: true, limit: 1 },
      { all: false, limit: 1 },
    ],
    [
      "inspect-signal-decoders",
      { all: true, limit: 1 },
      { all: false, limit: 1 },
    ],
    [
      "inspect-packet-capture",
      { fields: ["ip.src"], all_matches: true, match_limit: 1 },
      { fields: ["ip.src"], all_matches: false, match_limit: 1 },
    ],
    [
      "decode-signal-recording",
      { decoders: "uart", all_lines: true, line_limit: 1 },
      { decoders: "uart", all_lines: false, line_limit: 1 },
    ],
    [
      "inspect-il2cpp-metadata",
      { genericInstances: true },
      { genericInstances: false },
    ],
    [
      "inspect-il2cpp-metadata",
      { architecture: "arm64" },
      { binary: "lib.dylib", architecture: "arm64" },
    ],
    [
      "inspect-il2cpp-metadata",
      { ghidraSeeds: "seeds.txt" },
      { binary: "lib.so", ghidraSeeds: "seeds.txt" },
    ],
    [
      "inspect-il2cpp-metadata",
      { seedBase: "0x1000" },
      { binary: "lib.so", ghidraSeeds: "seeds.txt", seedBase: "0x1000" },
    ],
    [
      "import-reference-source",
      { outlineDepth: 2, detail: "full" },
      { outlineDepth: 2, detail: "summary" },
    ],
  ] as const) {
    const schema = (await serve(cli, [command, "--schema", "--json"])).options;
    expect(schema, command).toBeDefined();
    const validate = ajv.compile(schema as AnySchema);
    expect(
      validate(invalid),
      `${command} invalid ${JSON.stringify(invalid)}`,
    ).toBe(false);
    expect(validate(valid), `${command} valid ${JSON.stringify(valid)}`).toBe(
      true,
    );
  }
});

it("rejects invalid selected paths before inspecting a target", async () => {
  const cli = createCli({});
  for (const [args, field, code] of [
    [
      ["inspect-apple-ips", "missing.ips", "--join-path="],
      "joinPath",
      "too_small",
    ],
    [
      ["match-native-functions", "missing.json", "--evidence_output="],
      "evidence_output",
      "too_small",
    ],
    [
      ["match-native-functions", "missing.json", "--evidence_output=bad\0path"],
      "evidence_output",
      "invalid_format",
    ],
    [
      [
        "match-native-functions",
        "missing.json",
        "--evidence_output=bad\ud800path",
      ],
      "evidence_output",
      "invalid_format",
    ],
    [
      ["match-native-functions", "missing.json", "--source_bundle="],
      "source_bundle.0",
      "too_small",
    ],
    [["import-reference-source", ""], "root", "too_small"],
  ] as const) {
    let stdout = "";
    await cli.serve([...args, "--json"], {
      env: {},
      exit: () => {},
      stdout: (text) => {
        stdout += text;
      },
    });
    expect(JSON.parse(stdout), args.join(" ")).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [{ path: field, code }],
    });
  }
});

it("advertises domain minItems for inspect-web-network-capture record selection", async () => {
  const cli = createCli({});
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const advertised = await serve(cli, [
    "inspect-web-network-capture",
    "--schema",
    "--json",
  ]);
  const schema = advertised.options;
  expect(schema, "inspect-web-network-capture options").toBeDefined();
  const validate = ajv.compile(schema as AnySchema);

  expect(validate({ record: [] })).toBe(false);
  expect(validate({ record: [0] })).toBe(true);

  const parser = registeredCommands
    .get(cli)
    ?.get("inspect-web-network-capture");
  expect(
    parser && "options" in parser && parser.options instanceof z.ZodObject,
  ).toBe(true);
  if (parser && "options" in parser && parser.options instanceof z.ZodObject) {
    expect(parser.options.safeParse({ record: [] }).success).toBe(false);
    expect(parser.options.safeParse({ record: ["0"] }).success).toBe(true);
  }
});
