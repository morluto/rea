import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, onTestFinished } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const compareContract = toolContract("compare_application_versions");
const analyzeContract = toolContract("analyze_javascript_application");
const expectInputFailure = (
  value: unknown,
  path: string,
  message: string,
): void => {
  expect(value).toMatchObject({
    code: "invalid_request",
    details: {
      issues: [{ path: [path], message: expect.stringContaining(message) }],
    },
  });
};
const runJson = async (
  cli: TestCli,
  root: string,
  command: string,
  input: unknown,
) => {
  const path = join(root, "request.json");
  await writeFile(path, JSON.stringify(input));
  return cli.run({
    arguments: [command, path, "--json"],
    cwd: root,
    environment: { REA_LOG_LEVEL: "silent" },
  });
};
const connectMcp = async (root: string) => {
  const client = new Client({
    name: "application-input-identities",
    version: "1",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("scripts/rea.mjs"), "mcp"],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
      REA_LOG_LEVEL: "silent",
    },
  });
  onTestFinished(async () => {
    try {
      await client.close();
    } finally {
      await transport.close();
    }
  });
  await client.connect(transport);
  const tools = new Map(
    (await client.listTools()).tools.map((tool) => [tool.name, tool]),
  );
  const call = (name: string, arguments_: Record<string, unknown> = {}) => {
    const definition = tools.get(name);
    if (definition === undefined)
      throw new Error(`Missing advertised tool ${name}`);
    return client.callTool(
      { name, arguments: arguments_ },
      { toolDefinition: definition },
    );
  };
  return { client, tools, call };
};

type Application = ReturnType<typeof analyzeContract.outputSchema.parse>;
type WorkflowContext = {
  cli: TestCli;
  root: string;
  call: Awaited<ReturnType<typeof connectMcp>>["call"];
  application: Application;
  other: Application;
  reference: { kind: string; evidence_id: string };
  otherReference: { kind: string; evidence_id: string };
};
const selectors = {
  left_module_path: "main.mjs",
  left_export_name: "get",
  right_module_path: "main.mjs",
  right_export_name: "get",
};
const seed = { kind: "module", value: "main.mjs", match: "contains" };

const checkComparisonIdentities = async ({
  cli,
  root,
  call,
  application,
  reference,
}: WorkflowContext) => {
  for (const [name, command, extra] of [
    ["compare_application_versions", "compare-application-versions", {}],
    [
      "compare_javascript_export_shapes",
      "compare-javascript-export-shapes",
      selectors,
    ],
  ] as const) {
    for (const [a, b] of [
      [application, application],
      [reference, reference],
      [application, reference],
      [reference, application],
    ]) {
      const response = await call(name, { left: a, right: b, ...extra });
      expect(response.isError).toBe(true);
      expectInputFailure(
        parseMcpToolError(response).error,
        "right",
        "Evidence must be distinct",
      );
    }
    const invalid = await runJson(cli, root, command, {
      left: application,
      right: application,
      ...extra,
    });
    expect(invalid.exitCode).toBe(1);
    expectInputFailure(invalid.json, "right", "Evidence must be distinct");
  }
};

const checkNativeObservationIdentities = async ({
  cli,
  root,
  call,
  application,
  other,
  reference,
  otherReference,
}: WorkflowContext) => {
  for (const side of [
    "left_native_observations",
    "right_native_observations",
  ] as const) {
    const input = {
      left: application,
      right: other,
      [side]: [application, application],
    };
    const response = await call("compare_application_versions", {
      ...input,
      left: reference,
      right: otherReference,
    });
    expect(response.isError).toBe(true);
    expectInputFailure(
      parseMcpToolError(response).error,
      side,
      "Native observations must be unique",
    );
    const invalid = await runJson(
      cli,
      root,
      "compare-application-versions",
      input,
    );
    expect(invalid.exitCode).toBe(1);
    expectInputFailure(
      invalid.json,
      side,
      "Native observations must be unique",
    );
  }
  const traceInput = {
    application,
    seed,
    native_observations: [application, application],
  };
  const duplicateTrace = await call("trace_application_feature", {
    ...traceInput,
    application: reference,
  });
  expect(duplicateTrace.isError).toBe(true);
  expectInputFailure(
    parseMcpToolError(duplicateTrace).error,
    "native_observations",
    "Native observations must be unique",
  );
  const invalidTrace = await runJson(
    cli,
    root,
    "trace-application-feature",
    traceInput,
  );
  expect(invalidTrace.exitCode).toBe(1);
  expectInputFailure(
    invalidTrace.json,
    "native_observations",
    "Native observations must be unique",
  );
};

cliTest(
  "preserves workflow identity validation through CLI and inline, retained and mixed MCP inputs",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-application-input-identities-",
    );
    const left = join(root, "left"),
      right = join(root, "right");
    await mkdir(left);
    await mkdir(right);
    await writeFile(
      join(left, "main.mjs"),
      "export function get() { return { observed: 1 }; }\n",
    );
    await writeFile(
      join(right, "main.mjs"),
      "export function get() { return { observed: 2 }; }\n",
    );
    const { client, tools, call } = await connectMcp(root);
    const first = await call("analyze_javascript_application", {
      input_path: left,
      format: "directory",
    });
    const second = await call("analyze_javascript_application", {
      input_path: right,
      format: "directory",
    });
    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    const application = analyzeContract.outputSchema.parse(
      first.structuredContent,
    );
    const other = analyzeContract.outputSchema.parse(second.structuredContent);
    const reference = {
      kind: "retained-evidence",
      evidence_id: application.evidence_id,
    };
    const otherReference = {
      kind: "retained-evidence",
      evidence_id: other.evidence_id,
    };
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    for (const name of [
      "compare_application_versions",
      "compare_javascript_export_shapes",
      "trace_application_feature",
    ]) {
      const definition = tools.get(name);
      if (definition?.outputSchema === undefined)
        throw new Error("Missing workflow schema");
      expect(ajv.validateSchema(definition.inputSchema)).toBe(true);
      expect(ajv.validateSchema(definition.outputSchema)).toBe(true);
    }
    const context = {
      cli,
      root,
      call,
      application,
      other,
      reference,
      otherReference,
    };
    await checkComparisonIdentities(context);
    await checkNativeObservationIdentities(context);
    const compared = await call("compare_application_versions", {
      left: reference,
      right: otherReference,
    });
    expect(compared.isError).not.toBe(true);
    const result = compareContract.outputSchema.parse(
      compared.structuredContent,
    );
    expect(result.normalized_result.evidence_links).toEqual(
      [application.evidence_id, other.evidence_id].sort(),
    );
    const cliResult = await runJson(cli, root, "compare-application-versions", {
      left: application,
      right: other,
    });
    expect(cliResult.exitCode, cliResult.stdout).toBe(0);
    expect(compareContract.outputSchema.parse(cliResult.json)).toEqual(result);
    expect(
      (
        await call("compare_javascript_export_shapes", {
          left: reference,
          right: otherReference,
          ...selectors,
        })
      ).isError,
    ).not.toBe(true);
    expect(
      (
        await call("trace_application_feature", {
          application: reference,
          seed,
        })
      ).isError,
    ).not.toBe(true);
    await client.ping();
    expect((await call("close_binary")).isError).not.toBe(true);
    await client.ping();
  },
);
