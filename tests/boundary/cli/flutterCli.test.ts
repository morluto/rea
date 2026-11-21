import { expect, it } from "vitest";
import { Ajv } from "ajv";
import type { AnySchema } from "ajv";

import { aotFixtureImage } from "../../../src/flutter/FlutterBuild.fixture.js";
import { flutterInputSchemas } from "../../../src/domain/flutter/flutterBuildAnalysis.js";
import { createFlutterApk } from "../../fixtures/flutterApk.js";
import { serveCli } from "./cliServeHarness.js";

it.each(["identify-flutter-build", "inspect-dart-aot"])(
  "%s advertises a schema through the public CLI",
  async (command) => {
    const result = await serveCli([command, "--schema", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toBeTruthy();
  },
);

it("reports an unreadable target with an input refusal", async () => {
  const result = await serveCli([
    "identify-flutter-build",
    "/nonexistent/app.apk",
    "--json",
  ]);
  expect(result.stdout).toContain("invalid_request");
});

it.each(["identify-flutter-build", "inspect-dart-aot"])(
  "%s uses canonical local-path validation before provider admission",
  async (command) => {
    const result = await serveCli([command, "fixture\u0000.apk", "--json"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [
        expect.objectContaining({
          path: "path",
          message: expect.stringContaining("NUL"),
        }),
      ],
    });
  },
);

it("advertises and validates one ABI selector grammar with field correction guidance", async () => {
  const advertised = await serveCli(["inspect-dart-aot", "--schema", "--json"]);
  expect(advertised.exitCode).toBe(0);
  const schema = JSON.parse(advertised.stdout) as { options: AnySchema };
  const ajv = new Ajv({ strict: false });
  expect(ajv.validateSchema(schema.options)).toBe(true);
  const accepts = ajv.compile(schema.options);
  const abiSchema = flutterInputSchemas.inspect_dart_aot.shape.abi;
  for (const abi of [
    "ARM64-V8A",
    "ARM64",
    "arm64.v8a",
    "A",
    "a",
    "abi\\label",
    "abi\nlabel",
    "l".repeat(1010),
    "😀".repeat(1010),
  ]) {
    expect(accepts({ abi })).toBe(true);
    expect(abiSchema.safeParse(abi).success).toBe(true);
  }
  for (const abi of [
    "",
    "lib/x86_64",
    "l".repeat(1011),
    "😀".repeat(1011),
    "l".repeat(1010) + "\n",
  ]) {
    expect(accepts({ abi })).toBe(false);
    expect(abiSchema.safeParse(abi).success).toBe(false);
    const rejected = await serveCli([
      "inspect-dart-aot",
      "/nonexistent/app.apk",
      "--abi",
      abi,
      "--json",
    ]);
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [
        expect.objectContaining({
          path: "abi",
          message: expect.stringContaining("ABI"),
        }),
      ],
    });
  }
});

it("inspects the caller-selected nonstandard ABI through the public CLI", async () => {
  const path = await createFlutterApk("selector.apk", [
    { path: "lib/ARM64-V8A/libapp.so", bytes: aotFixtureImage("a".repeat(32)) },
    { path: "lib/x86_64/libapp.so", bytes: aotFixtureImage("b".repeat(32)) },
  ]);
  const selected = await serveCli([
    "inspect-dart-aot",
    path,
    "--abi",
    "ARM64-V8A",
    "--pool-policy",
    '{"contains":"package:animations/","uri_limit":1}',
    "--json",
  ]);
  expect(selected.exitCode).toBe(0);
  expect(JSON.parse(selected.stdout)).toMatchObject({
    caller_input_path: path,
    parameters: {
      path,
      abi: "ARM64-V8A",
      pool_policy: { contains: "package:animations/", uri_limit: 1 },
    },
    normalized_result: {
      abi: "ARM64-V8A",
      string_pool: {
        package_uris: ["package:animations/src/fade_scale_transition.dart"],
        package_uri_count_at_least: 1,
        policy: { uri_limit: 1, contains: "package:animations/" },
      },
      libapp: { snapshot_hash: "a".repeat(32), coverage: "complete" },
    },
  });
  const invalid = await serveCli([
    "inspect-dart-aot",
    path,
    "--pool-policy",
    '{"uri_limit":0}',
    "--json",
  ]);
  expect(JSON.parse(invalid.stdout).code).toBe("VALIDATION_ERROR");
});
