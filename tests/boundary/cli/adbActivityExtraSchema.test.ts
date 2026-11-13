import { Ajv2020 } from "ajv/dist/2020.js";
import { Cli, z } from "incur";
import { describe, expect, it } from "vitest";

import {
  activityExtraCliEntrySchema,
  MAX_ADB_ACTIVITY_EXTRAS,
} from "../../../src/domain/adb/adbDeviceAnalysis.js";

const advertisedOptions = z
  .object({
    properties: z.record(z.string(), z.unknown()),
  })
  .loose();

const serveSchema = async () => {
  const cli = Cli.create("rea", { sync: false });
  cli.command("start-adb-activity", {
    options: z.object({
      extra: z
        .array(activityExtraCliEntrySchema)
        .max(MAX_ADB_ACTIVITY_EXTRAS)
        .default([]),
    }),
    run: () => undefined,
  });
  let stdout = "";
  let exitCode = 0;
  await cli.serve(["start-adb-activity", "--schema", "--json"], {
    env: {},
    exit: (code) => {
      exitCode = code ?? 0;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  expect(exitCode).toBe(0);
  return advertisedOptions.parse(JSON.parse(stdout).options);
};

describe("ADB activity extra CLI schema", () => {
  it("advertises the runtime extra forms and parses the same value contract", async () => {
    const options = await serveSchema();
    const extra = options.properties.extra;
    expect(extra).toMatchObject({
      type: "array",
      maxItems: MAX_ADB_ACTIVITY_EXTRAS,
      default: [],
    });
    expect(JSON.stringify(extra)).not.toContain('"minLength":1');
    const validate = new Ajv2020({ strict: false }).compile({
      type: "object",
      properties: { extra },
    });
    const accepted = [
      "string:key:value:rest",
      "string:key:",
      "boolean:key:false",
      "int:key:-3",
      "int:key:2147483647",
      "int:key:-2147483648",
      "long:key:9223372036854775807",
      "long:key:-9223372036854775808",
      "float:key:1e-3",
      "float:key:.5",
    ];
    for (const entry of accepted) {
      expect(activityExtraCliEntrySchema.safeParse(entry).success, entry).toBe(
        true,
      );
      expect(validate({ extra: [entry] }), entry).toBe(true);
    }
    const rejectedByAdvertisement = [
      "boolean:key:yes",
      "string:bad key:value",
      "float:key:garbage",
      "int:key:",
      "bogus:key:value",
      "string:key",
    ];
    for (const entry of rejectedByAdvertisement) {
      expect(activityExtraCliEntrySchema.safeParse(entry).success, entry).toBe(
        false,
      );
      expect(validate({ extra: [entry] }), entry).toBe(false);
    }
    for (const entry of [
      "int:key:2147483648",
      "int:key:-2147483649",
      "long:key:9223372036854775808",
      "long:key:-9223372036854775809",
      "int:key:007",
    ])
      expect(activityExtraCliEntrySchema.safeParse(entry).success, entry).toBe(
        entry === "int:key:007",
      );
  });
});
