import { describe, expect } from "vitest";
import type { z } from "zod";

import {
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
} from "../../../src/domain/browserObservation.js";
import { listJavaScriptRuntimeTargetsInputSchema } from "../../../src/domain/javascript/javascriptRuntimeObservation.js";
import { analyzeWebBundleInputSchema } from "../../../src/domain/webBundleAnalysis.js";
import { discoverWebMcpToolsInputSchema } from "../../../src/domain/webMcpDiscovery.js";
import { workspaceCliTest as cliTest } from "../../support/cli/workspaceCliFixture.js";

const malformedEndpoint = "not a url";
const browserEndpoint = "http://127.0.0.1:9222";
const inspectorEndpoint = "http://127.0.0.1:9229";

/** The domain schema owns custom issue text. Tests compare the CLI to that issue. */
const schemaIssue = (
  schema: z.ZodType,
  value: unknown,
  path: readonly (string | number)[],
) => {
  const parsed = schema.safeParse(value);
  if (parsed.success)
    throw new Error(`domain schema accepted ${path.join(".")}`);
  const issue = parsed.error.issues.find(
    (item) => item.path.join(".") === path.join("."),
  );
  if (issue === undefined)
    throw new Error(
      `domain schema omitted ${path.join(".")}: ${JSON.stringify(parsed.error.issues)}`,
    );
  return issue;
};

const malformedEndpointInput = (operation: string) =>
  operation === "list_browser_targets"
    ? { cdp_endpoint: malformedEndpoint }
    : {
        cdp_endpoint: malformedEndpoint,
        target_id: "target",
        ...(operation === "analyze_web_bundle"
          ? { include_script_sources: true }
          : {}),
      };

const invalidInputs = [
  {
    command: "list-browser-targets",
    arguments: [malformedEndpoint],
    operation: "list_browser_targets",
    error: "Browser observation failed",
    issue: {
      path: ["cdp_endpoint"],
      reason: "invalid_value",
    },
    schema: listBrowserTargetsInputSchema,
  },
  {
    command: "analyze-web-bundle",
    arguments: [malformedEndpoint, "target"],
    operation: "analyze_web_bundle",
    error: "Browser observation failed",
    issue: {
      path: ["cdp_endpoint"],
      reason: "invalid_value",
    },
    schema: analyzeWebBundleInputSchema,
  },
  {
    command: "discover-webmcp-tools",
    arguments: [malformedEndpoint, "target"],
    operation: "discover_webmcp_tools",
    error: "Browser observation failed",
    issue: {
      path: ["cdp_endpoint"],
      reason: "invalid_value",
    },
    schema: discoverWebMcpToolsInputSchema,
  },
];

const parserRejections = [
  {
    command: "inspect-web-page",
    arguments: [browserEndpoint, ""],
    path: "targetId",
  },
  {
    command: "observe-web-session",
    arguments: [browserEndpoint, ""],
    path: "targetId",
  },
  {
    command: "list-javascript-runtime-targets",
    arguments: [""],
    path: "endpoint",
  },
  {
    command: "observe-javascript-runtime",
    arguments: [inspectorEndpoint, ""],
    path: "targetId",
  },
  {
    command: "capture-web-screenshot",
    arguments: [browserEndpoint, ""],
    path: "targetId",
  },
] as const;

describe("inspection branch diagnostics", () => {
  cliTest.for([[], ["--include-script-sources"]])(
    "reports only the selected inspection branch's endpoint error (%j)",
    async (flags, { cli, workspace }) => {
      const result = await cli.run({
        arguments: [
          "inspect-web-page",
          malformedEndpoint,
          "target",
          ...flags,
          "--json",
        ],
        cwd: workspace.root,
        environment: { ...workspace.environment, REA_LOG_LEVEL: "silent" },
      });
      expect(result.exitCode).toBe(1);
      const owner = schemaIssue(
        inspectWebPageInputSchema,
        {
          cdp_endpoint: malformedEndpoint,
          target_id: "target",
          include_script_sources: flags.includes("--include-script-sources"),
        },
        ["cdp_endpoint"],
      );
      expect(result.json).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "inspect_web_page",
          issues: [
            {
              path: ["cdp_endpoint"],
              reason: "invalid_value",
              message: owner.message,
            },
          ],
        },
      });
    },
  );
});

describe("browser and Inspector CLI input diagnostics", () => {
  cliTest.for(invalidInputs)(
    "$command retains the named contract's correction details",
    async (input, { cli, workspace }) => {
      const result = await cli.run({
        arguments: [input.command, ...input.arguments, "--json"],
        cwd: workspace.root,
        environment: { ...workspace.environment, REA_LOG_LEVEL: "silent" },
      });

      const owner = schemaIssue(
        input.schema,
        malformedEndpointInput(input.operation),
        input.issue.path,
      );
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        error: input.error,
        code: "invalid_request",
        category: "invalid_input",
        message:
          "Analysis input is invalid. Check the arguments and try again.",
        retryable: false,
        remediation: {
          action: `Read the declared input schema or CLI usage for ${input.operation}; if using MCP and the catalog may be stale, call tools/list. Correct the listed fields, then retry. Do not repeat the unchanged call.`,
        },
        recovery: {
          kind: "inspect_input_contract",
          operation: input.operation,
        },
        details: {
          operation: input.operation,
          issues: expect.arrayContaining([
            { ...input.issue, message: owner.message },
          ]),
        },
      });
      expect(result.stdout).not.toContain(malformedEndpoint);
      expect(result.stderr).not.toContain(malformedEndpoint);
    },
  );

  cliTest.for([
    ["list-browser-targets", "cdp_endpoint"],
    ["list-javascript-runtime-targets", "inspector_endpoint"],
  ] as const)(
    "%s does not echo rejected endpoint credentials",
    async ([command, field], { cli, workspace }) => {
      const endpoint =
        "http://rea-diagnostic-user:rea-diagnostic-secret@127.0.0.1:9222/";
      const result = await cli.run({
        arguments: [command, endpoint, "--json"],
        cwd: workspace.root,
        environment: { ...workspace.environment, REA_LOG_LEVEL: "debug" },
      });

      const owner = schemaIssue(
        command === "list-browser-targets"
          ? listBrowserTargetsInputSchema
          : listJavaScriptRuntimeTargetsInputSchema,
        command === "list-browser-targets"
          ? { cdp_endpoint: endpoint }
          : { inspector_endpoint: endpoint },
        [field],
      );
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: [field],
              reason: "invalid_value",
              message: owner.message,
            },
          ],
        },
      });
      const output = result.stdout + result.stderr;
      expect(output).not.toContain(endpoint);
      expect(output).not.toContain("rea-diagnostic-user");
      expect(output).not.toContain("rea-diagnostic-secret");
    },
  );
});

describe("browser correction facts", () => {
  cliTest(
    "retains authored cross-field correction guidance",
    async ({ cli, workspace }) => {
      const result = await cli.run({
        arguments: [
          "inspect-web-page",
          browserEndpoint,
          "target",
          "--include-storage-fingerprints",
          "--json",
        ],
        cwd: workspace.root,
        environment: { ...workspace.environment, REA_LOG_LEVEL: "silent" },
      });

      const owner = schemaIssue(
        inspectWebPageInputSchema,
        {
          cdp_endpoint: browserEndpoint,
          target_id: "target",
          include_script_sources: false,
          include_storage_fingerprints: true,
        },
        ["include_storage_fingerprints"],
      );
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "inspect_web_page",
          issues: expect.arrayContaining([
            {
              path: ["include_storage_fingerprints"],
              reason: "invalid_value",
              message: owner.message,
            },
          ]),
        },
      });
    },
  );

  cliTest(
    "retains correction details for invalid capture comparison inputs",
    async ({ cli, workspace }) => {
      const result = await cli.run({
        arguments: ["compare-web-captures", "{}", "{}", "--json"],
        cwd: workspace.root,
        environment: { ...workspace.environment, REA_LOG_LEVEL: "silent" },
      });

      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "compare_web_captures",
          issues: expect.arrayContaining([
            expect.objectContaining({
              path: ["before", "inspection"],
              reason: "missing_argument",
            }),
            expect.objectContaining({
              path: ["after", "inspection"],
              reason: "missing_argument",
            }),
          ]),
        },
      });
    },
  );

  cliTest(
    "preserves the parser diagnostic for an omitted endpoint",
    async ({ cli, workspace }) => {
      const result = await cli.run({
        arguments: ["list-browser-targets", "--json"],
        cwd: workspace.root,
        environment: { ...workspace.environment, REA_LOG_LEVEL: "silent" },
      });

      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        code: "VALIDATION_ERROR",
        fieldErrors: [
          {
            path: "endpoint",
            code: "invalid_type",
            missing: true,
            expected: "string",
          },
        ],
      });
    },
  );
});

describe("empty browser and Inspector selectors", () => {
  cliTest.for(parserRejections)(
    "$command rejects an empty selector in argument parsing",
    async (input, { cli, workspace }) => {
      const result = await cli.run({
        arguments: [input.command, ...input.arguments, "--json"],
        cwd: workspace.root,
        environment: { ...workspace.environment, REA_LOG_LEVEL: "silent" },
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        code: "VALIDATION_ERROR",
        fieldErrors: [
          {
            code: "too_small",
            path: input.path,
          },
        ],
      });
    },
  );
});
