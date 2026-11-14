import { Ajv2020 } from "ajv/dist/2020.js";
import { estimateTokenCount } from "tokenx";
import { expect, it } from "vitest";

import { createCli } from "./cli.js";
import { JAVASCRIPT_FEATURE_TRACE_EXAMPLE } from "./contracts/javascript/javascriptApplicationWorkflowExamples.js";

const cli = createCli({ REA_LOG_LEVEL: "silent" });

const run = async (...arguments_: string[]) => {
  let stdout = "";
  let exitCode = 0;
  await cli.serve(arguments_, {
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

const schemaArgs = async (...arguments_: string[]) => {
  const result = await run(...arguments_);
  expect(result.exitCode, result.stdout).toBe(0);
  const document = JSON.parse(result.stdout) as {
    args?: { properties?: Record<string, unknown> };
    options?: { properties?: Record<string, unknown> };
  };
  expect(document.args?.properties).toBeDefined();
  return document;
};

it("exposes the trace-application-feature input schema through --schema", async () => {
  const document = await schemaArgs(
    "trace-application-feature",
    "--schema",
    "--json",
  );
  expect(document.args?.properties).toMatchObject({
    application: expect.anything(),
    seed: expect.anything(),
    native_observations: expect.anything(),
    direction: expect.anything(),
  });
  expect(document.args?.properties).not.toHaveProperty("inputJson");
  expect(document.options?.properties).toHaveProperty("evidenceBundle");
});

it("emits an args schema a caller can validate the input document against", async () => {
  const result = await run("trace-application-feature", "--schema", "--json");
  expect(result.exitCode, result.stdout).toBe(0);
  const document = JSON.parse(result.stdout) as {
    args: Parameters<Ajv2020["compile"]>[0];
  };
  const validate = new Ajv2020({ strict: false }).compile(document.args);
  expect(validate(JAVASCRIPT_FEATURE_TRACE_EXAMPLE)).toBe(true);
  expect(validate({})).toBe(false);
  expect(
    validate({ ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE, seed: 42 }),
  ).toBe(false);
});

it("emits JSON Schema for --schema without --json", async () => {
  const document = await schemaArgs("trace-application-feature", "--schema");
  expect(document.args?.properties).toMatchObject({
    application: expect.anything(),
    seed: expect.anything(),
  });
  expect(document.args?.properties).not.toHaveProperty("inputJson");
});

it("exposes the reconstruction ledger and coverage input schemas", async () => {
  const ledger = await schemaArgs(
    "build-reconstruction-obligation-ledger",
    "--schema",
    "--json",
  );
  expect(ledger.args?.properties).toMatchObject({
    evidence_bundle: expect.anything(),
    reviewed_obligations: expect.anything(),
    manifest: expect.anything(),
  });
  expect(ledger.args?.properties).not.toHaveProperty("inputJson");
  const coverage = await schemaArgs(
    "evaluate-reconstruction-coverage",
    "--schema",
    "--json",
  );
  expect(coverage.args?.properties).toMatchObject({
    coverage: expect.anything(),
    boundary_id: expect.anything(),
  });
});

it("exposes the application graph projection and export-shape input schemas", async () => {
  const projection = await schemaArgs(
    "project-android-application-graph",
    "--schema",
    "--json",
  );
  expect(projection.args?.properties).toMatchObject({
    inventory_evidence: expect.anything(),
  });
  expect(projection.options?.properties).toHaveProperty("evidenceBundle");
  const shapes = await schemaArgs(
    "compare-javascript-export-shapes",
    "--schema",
    "--json",
  );
  expect(shapes.args?.properties).toMatchObject({
    left: expect.anything(),
    right: expect.anything(),
    left_module_path: expect.anything(),
    left_export_name: expect.anything(),
  });
});

it("counts the schema document for --schema --token-count", async () => {
  const document = await run("trace-application-feature", "--schema");
  expect(document.exitCode, document.stdout).toBe(0);
  const counted = await run(
    "trace-application-feature",
    "--schema",
    "--token-count",
  );
  expect(counted.exitCode, counted.stdout).toBe(0);
  expect(counted.stdout).toBe(`${estimateTokenCount(document.stdout)}\n`);
});

it("windows a schema document for --schema --token-limit", async () => {
  const result = await run(
    "trace-application-feature",
    "--schema",
    "--token-limit",
    "1",
  );
  expect(result.exitCode, result.stdout).toBe(0);
  expect(result.stdout).toMatch(
    /\[truncated: showing tokens 0–1 of \d+\]\n$/,
  );
  expect(result.stdout).not.toContain('"seed"');
});

it("keeps --schema for other commands on Incur's wrapper schema", async () => {
  const document = await schemaArgs("inspect-devicetree", "--schema", "--json");
  expect(document.args?.properties).toMatchObject({
    path: expect.anything(),
  });
});

it("lets --help outrank --schema for a JSON-input command", async () => {
  const result = await run(
    "trace-application-feature",
    "--schema",
    "--help",
  );
  expect(result.exitCode, result.stdout).toBe(0);
  expect(result.stdout).toContain("Inline workflow JSON");
  expect(() => JSON.parse(result.stdout)).toThrow();
});

it("still runs a JSON-input command instead of emitting its schema", async () => {
  // In-process serve reports a command failure through its error document;
  // the exit callback is owned by the executable dispatcher, not the CLI.
  const result = await run("trace-application-feature", "{}", "--json");
  const document = JSON.parse(result.stdout) as {
    code?: unknown;
    args?: unknown;
  };
  expect(document.code).toBe("invalid_request");
  expect(document.args).toBeUndefined();
});
