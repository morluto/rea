import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { Cli, z } from "incur";
import { expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import { androidInputSchemas } from "../../../src/domain/android/androidAnalysis.js";

type CliInstance = ReturnType<typeof createCli>;
type CommandMap = NonNullable<ReturnType<typeof Cli.toCommands.get>>;

const registeredCommands: WeakMap<object, CommandMap> = Cli.toCommands;

const serveRaw = async (cli: CliInstance, argv: readonly string[]) => {
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
  return { stdout, exitCode };
};

const serve = async (cli: CliInstance, argv: readonly string[]) => {
  const { stdout, exitCode } = await serveRaw(cli, argv);
  expect(exitCode, argv.join(" ")).toBe(0);
  return z
    .object({
      args: z
        .object({ properties: z.record(z.string(), z.unknown()) })
        .optional(),
      options: z
        .object({ properties: z.record(z.string(), z.unknown()) })
        .optional(),
    })
    .parse(JSON.parse(stdout));
};

const absoluteMapping =
  process.platform === "win32" ? "C:\\mapping.txt" : "/tmp/mapping.txt";

const createSchemaValidator = (cli: CliInstance) => {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  return async (
    command: string,
    group: "args" | "options",
    value: Record<string, unknown>,
  ) => {
    const advertised = await serve(cli, [command, "--schema", "--json"]);
    const schema = advertised[group];
    expect(schema, command).toBeDefined();
    return ajv.compile(schema as AnySchema)(value);
  };
};

it("advertises the domain constraints for android, adb settings, and browser selectors", async () => {
  const cli = createCli({});
  const validate = createSchemaValidator(cli);

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

it("requires nonempty Android class and method selectors in advertised CLI schemas", async () => {
  const cli = createCli({});
  const validate = createSchemaValidator(cli);

  expect(
    await validate("inspect-android-method", "args", {
      path: "",
      className: "com.example.Main",
      methodName: "onCreate",
    }),
  ).toBe(false);
  expect(
    await validate("inspect-android-method", "args", {
      path: "app.apk",
      className: "",
      methodName: "onCreate",
    }),
  ).toBe(false);
  expect(
    await validate("inspect-android-method", "args", {
      path: "app.apk",
      className: "com.example.Main",
      methodName: "onCreate",
    }),
  ).toBe(true);
  expect(
    await validate("trace-android-references", "args", {
      path: "",
      className: "com.example.Main",
    }),
  ).toBe(false);
  expect(
    await validate("trace-android-references", "args", {
      path: "app.apk",
      className: "",
    }),
  ).toBe(false);
  expect(
    await validate("trace-android-references", "args", {
      path: "app.apk",
      className: "com.example.Main",
    }),
  ).toBe(true);
  const traceSchema = await serve(cli, [
    "trace-android-references",
    "--schema",
    "--json",
  ]);
  expect(traceSchema.args?.properties.className).toMatchObject({
    minLength: 1,
    description:
      androidInputSchemas.trace_android_references.shape.class_name.description,
  });
  expect(await validate("trace-android-references", "options", {})).toBe(true);
  expect(
    await validate("trace-android-references", "options", {
      methodName: "",
    }),
  ).toBe(false);
  expect(
    await validate("trace-android-references", "options", {
      methodName: "onCreate",
    }),
  ).toBe(true);
});

it("rejects empty Android class and method selectors in CLI parsing before opening a target", async () => {
  const cli = createCli({});
  const rejectedCases = [
    {
      argv: ["inspect-android-class", "/nonexistent/missing.apk", ""],
      path: "className",
    },
    {
      argv: [
        "inspect-android-method",
        "/nonexistent/missing.apk",
        "",
        "onCreate",
      ],
      path: "className",
    },
    {
      argv: [
        "inspect-android-method",
        "/nonexistent/missing.apk",
        "com.example.Main",
        "",
      ],
      path: "methodName",
    },
    {
      argv: ["trace-android-references", "/nonexistent/missing.apk", ""],
      path: "className",
    },
    {
      argv: [
        "trace-android-references",
        "/nonexistent/missing.apk",
        "com.example.Main",
        "--method-name",
        "",
      ],
      path: "methodName",
    },
    {
      argv: [
        "trace-android-references",
        "/nonexistent/missing.apk",
        "com.example.Main",
        "--method-name=",
      ],
      path: "methodName",
    },
  ] as const;

  for (const { argv, path } of rejectedCases) {
    const result = await serveRaw(cli, [...argv, "--json"]);
    expect(result.exitCode, argv.join(" ")).toBe(1);
    expect(JSON.parse(result.stdout), argv.join(" ")).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [
        expect.objectContaining({
          code: "too_small",
          path,
        }),
      ],
    });
  }

  for (const argv of [
    ["inspect-android-class", "/nonexistent/missing.apk", "com.example.Main"],
    [
      "inspect-android-method",
      "/nonexistent/missing.apk",
      "com.example.Main",
      "onCreate",
    ],
    [
      "trace-android-references",
      "/nonexistent/missing.apk",
      "com.example.Main",
      "--method-name",
      "onCreate",
    ],
  ] as const) {
    const result = await serveRaw(cli, [...argv, "--json"]);
    expect(JSON.parse(result.stdout), argv.join(" ")).toMatchObject({
      code: "target_unavailable",
    });
  }
});
