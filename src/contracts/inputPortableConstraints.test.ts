import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { presentInputJsonSchema } from "./inputSchemaPresentation.js";
import { adbSerialSchema } from "../domain/adb/adbIdentity.js";
import { z } from "zod";
import {
  portablePatternViolations,
  advertisedInputDialectViolations,
} from "./advertisedDialect.js";
import { advertisedInputJsonSchema } from "./toolSchemaMetadata.js";
import { advertisedInputExamples } from "./advertisedInputExamples.js";
import { ADB_UI_TOOL_CONTRACTS } from "./adb/adbUiToolContracts.js";
import { adbUiInputSchemas } from "../domain/adb/adbUiAnalysis.js";

const ajv = new Ajv2020({ strict: false, validateFormats: false });
const project = (schema: Record<string, unknown>) =>
  presentInputJsonSchema(schema, () => undefined, { portableDialect: true });

it("omits redundant 2020-12 metadata and unsupported constraints only from the advertisement", () => {
  const canonical = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { value: { type: "string", maxLength: 16384, format: "uuid" } },
  };
  const advertised = project(canonical);
  expect(advertised.$schema).toBeUndefined();
  expect(advertised).toMatchObject({
    properties: { value: { type: "string" } },
  });
  expect(JSON.stringify(advertised)).not.toMatch(/"(?:maxLength|format)"/u);
  expect(canonical.properties.value).toEqual({
    type: "string",
    maxLength: 16384,
    format: "uuid",
  });
  expect(ajv.validateSchema(advertised)).toBe(true);
});

it("keeps smaller bounds and a different explicit dialect", () => {
  const advertised = project({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { value: { type: "string", maxLength: 1998 } },
  });
  expect(advertised.$schema).toBe("http://json-schema.org/draft-07/schema#");
  expect(advertised).toMatchObject({
    properties: { value: { maxLength: 1998 } },
  });
});

it.each([
  { name: "negation", value: { not: { type: "string", maxLength: 2000 } } },
  {
    name: "exclusive union",
    value: {
      oneOf: [
        { type: "string", maxLength: 2000 },
        { type: "string", minLength: 2001 },
      ],
    },
  },
  { name: "reference", value: { $ref: "#/$defs/value" } },
])("never narrows a valid long input under $name", ({ value }) => {
  const canonical = {
    type: "object",
    properties: { value },
    $defs: { value: { type: "string", maxLength: 2000 } },
  };
  const example = { value: "x".repeat(2001) };
  if ("$ref" in value) {
    // The canonical shorter control remains accepted; its upper limit is a
    // runtime constraint after projection, not a new advertised rejection.
    expect(ajv.validate(canonical, { value: "ok" })).toBe(true);
    expect(ajv.validate(project(canonical), { value: "ok" })).toBe(true);
    expect(ajv.validate(canonical, example)).toBe(false);
    expect(ajv.validate(project(canonical), example)).toBe(true);
  } else {
    expect(ajv.validate(canonical, example)).toBe(true);
    expect(ajv.validate(project(canonical), example)).toBe(true);
  }
});

it("drops a changed conditional rather than routing a valid input into the wrong branch", () => {
  const canonical = {
    type: "object",
    properties: { value: { type: "string" }, selected: { type: "string" } },
    if: { properties: { value: { maxLength: 2000 } } },
    then: { properties: { selected: { const: "small" } } },
    else: { properties: { selected: { const: "large" } } },
  };
  const example = { value: "x".repeat(2001), selected: "large" };
  expect(ajv.validate(canonical, example)).toBe(true);
  expect(ajv.validate(project(canonical), example)).toBe(true);
});

it("advertises portable ADB serial syntax while retaining canonical Unicode-whitespace rejection", () => {
  const schema = z.toJSONSchema(adbSerialSchema);
  expect(typeof schema.pattern).toBe("string");
  expect(portablePatternViolations(schema.pattern!)).toEqual([]);
  expect(adbSerialSchema.safeParse("emulator-5554").success).toBe(true);
  for (const serial of [
    "two words",
    "two\twords",
    "two\u00a0words",
    "two\u2028words",
    "nul\0value",
    'quote"value',
  ])
    expect(adbSerialSchema.safeParse(serial).success).toBe(false);
});

it.each(["display_id", "window_id", "max_nodes"])(
  "retains Java integer bounds for %s independently of timer limits",
  (field) => {
    const scope = { serial: "emulator-5554", package: "com.example.app" };
    expect(
      adbUiInputSchemas.inspect_adb_ui.safeParse({
        ...scope,
        [field]: 2 ** 31 - 1,
      }).success,
    ).toBe(true);
    for (const value of [2 ** 31, -1, 1.5])
      expect(
        adbUiInputSchemas.inspect_adb_ui.safeParse({ ...scope, [field]: value })
          .success,
      ).toBe(false);
  },
);

it("keeps every public UI input advertisement portable without weakening its canonical parser", () => {
  for (const contract of ADB_UI_TOOL_CONTRACTS) {
    const advertised = advertisedInputJsonSchema(contract);
    expect(
      advertisedInputDialectViolations({
        name: contract.name,
        description: contract.description,
        inputSchema: advertised,
      }),
    ).toEqual([]);
    expect(advertisedInputExamples(contract)).toEqual([]);
    for (const example of contract.examples)
      expect(contract.inputSchema.safeParse(example.input).success).toBe(true);
  }
  const scope = { serial: "emulator-5554", package: "com.example.app" };
  expect(adbUiInputSchemas.inspect_adb_ui.parse(scope)).toMatchObject({
    display_id: 0,
    max_nodes: 500,
    timeout_ms: 10000,
  });
  expect(
    adbUiInputSchemas.find_adb_ui_elements.safeParse({
      ...scope,
      selector: { text: { value: "x".repeat(16385) } },
    }).success,
  ).toBe(false);
  expect(
    adbUiInputSchemas.find_adb_ui_elements.safeParse({
      ...scope,
      snapshot_id: "not-a-uuid",
      selector: {},
    }).success,
  ).toBe(false);
});
