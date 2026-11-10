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
        .optional(),
      options: z
        .object({ properties: z.record(z.string(), z.unknown()) })
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
