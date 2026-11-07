import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { serveCli } from "./cliServeHarness.js";

it("advertises the execution timer range and rejects overflow before connecting", async () => {
  const result = await serveCli([
    "observe-web-execution",
    "--schema",
    "--json",
  ]);
  const schema = JSON.parse(result.stdout);
  expect(schema.options.properties.observationMs.default).toBe(10_000);
  const accepts = new Ajv2020({ strict: false }).compile(schema.options);
  expect(accepts({ observationMs: 1 })).toBe(true);
  expect(accepts({ observationMs: 1.5 })).toBe(false);
  expect(accepts({ observationMs: 2_147_483_647 })).toBe(true);
  expect(accepts({ observationMs: 2_147_483_648 })).toBe(false);
  expect(accepts({ observationMs: 0 })).toBe(false);
  const rejected = await serveCli([
    "observe-web-execution",
    "http://127.0.0.1:1",
    "target",
    "--observation-ms",
    "2147483648",
    "--json",
  ]);
  expect(JSON.parse(rejected.stdout)).toMatchObject({
    code: "VALIDATION_ERROR",
    fieldErrors: expect.arrayContaining([
      expect.objectContaining({ code: "too_big", path: "observationMs" }),
    ]),
  });
});

it.each([undefined, 1, 2_000, 2_147_483_647])(
  "admits a valid observation duration %s through the actual CLI parser",
  async (duration) => {
    const result = await serveCli([
      "observe-web-execution",
      "http://127.0.0.1:1",
      "target",
      ...(duration === undefined ? [] : ["--observation-ms", String(duration)]),
      "--json",
    ]);
    // Reaching endpoint admission proves numeric argv coercion succeeded.
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "provider_unavailable",
      details: {
        operation: "observe_web_execution",
        reason: "endpoint_unreachable",
      },
    });
  },
);
