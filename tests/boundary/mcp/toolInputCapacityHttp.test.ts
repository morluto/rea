import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { startListeningProcess } from "../../support/mcp/streamableHttpProcess.js";
import {
  processTest,
  type TestProcesses,
} from "../../support/process/processFixture.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

const openHttp = async (
  processes: TestProcesses,
  maximum: string | undefined,
) => {
  const root = await createTestTempDirectory("rea-input-capacity-http-");
  const { url, stderr, child } = await startListeningProcess(
    processes,
    ["mcp", "--http", "--port", "0"],
    {
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_DATA_HOME: join(root, "data"),
      NODE_OPTIONS: "--max-old-space-size=3072",
      REA_MCP_OUTPUT_SCHEMA_PROFILE: "off",
      ...(maximum === undefined ? {} : { REA_MCP_MAX_INPUT_ELEMENTS: maximum }),
    },
  );
  const client = new Client(
    { name: "input-capacity-http", version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  const transport = new StreamableHTTPClientTransport(url, {
    // SDK output-schema compilation can outlive an idle pooled socket on two
    // CPUs. Keep this admission test independent of that client-side race.
    requestInit: { headers: { Connection: "close" } },
  });
  onTestFinished(() => client.close());
  await client.connect(transport);
  return { root, client, stderr, child };
};

processTest(
  "bounds HTTP validation before building amplified diagnostics and keeps serving",
  async ({ processes }) => {
    const { root, client, stderr, child } = await openHttp(processes, "8192");
    const catalog = await client.listTools();
    const declared = catalog.tools.find(
      (tool) => tool.name === "compare_bundles",
    );
    expect(declared?.inputSchema).toMatchObject({ type: "object" });
    const arguments_ = {
      left_bundle_path: join(root, "absent-left"),
      right_bundle_path: join(root, "absent-right"),
      record_pairs: Array.from({ length: 8192 }, () => 0),
    };
    const result = await client
      .callTool({ name: "compare_bundles", arguments: arguments_ })
      .catch((cause: unknown) => {
        throw new Error(
          `HTTP capacity probe failed; exit=${String(child.exitCode)} signal=${String(child.signalCode)}; listener diagnostic tail:\n${stderr().slice(-3000)}`,
          { cause },
        );
      });
    const { error } = parseMcpToolError(result);
    expect(error).toMatchObject({
      code: "resource_constraint",
      details: {
        resource: "transport",
        reported_limits: { max_input_elements: 8192 },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096);
    await client.ping();
    const healthy = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    expect(healthy.isError).not.toBe(true);
  },
);

processTest(
  "bounds Evidence validation and a near-frame-limit request under the default allowance",
  async ({ processes }) => {
    const { root, client } = await openHttp(processes, undefined);
    for (const count of [1_019, 1_020]) {
      const arguments_ = {
        functions: Array.from({ length: count }, () => ({})),
        start: { address: "0x1" },
        goal: { address: "0x2" },
      };
      const result = await client.callTool({
        name: "build_call_path",
        arguments: arguments_,
      });
      const error = parseMcpToolError(result).error;
      if (count === 1_019) {
        // Three root members and two address members fill the remaining five.
        // Admitted source carriers reach the Evidence owner, which rejects
        // the first invalid record without expanding every missing field.
        expect(error).toMatchObject({
          code: "evidence_integrity_mismatch",
          category: "integrity_mismatch",
          message: expect.stringContaining("at evidence_id"),
          details: { diagnostics: { input_path: ["functions", 0] } },
        });
      } else {
        expect(error.code).toBe("resource_constraint");
        expect(error.remediation.action).toContain("retained-evidence");
        expect(error.details).toMatchObject({
          resource: "transport",
          reported_limits: { max_input_elements: 1_024 },
        });
      }
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096);
    }

    const paths = {
      left_bundle_path: join(root, "absent-left"),
      right_bundle_path: join(root, "absent-right"),
    };
    // Prove this exact server is guarded before constructing the larger probe.
    // A missing/regressed guard therefore fails on the bounded small fixture.
    const calibration = await client.callTool({
      name: "compare_bundles",
      arguments: {
        ...paths,
        record_pairs: Array.from({ length: 1_024 }, () => 0),
      },
    });
    const calibratedError = parseMcpToolError(calibration).error;
    expect(calibratedError.code).toBe("resource_constraint");
    expect(calibratedError.remediation.action).not.toContain(
      "retained-evidence",
    );
    expect(calibratedError.details).toMatchObject({
      resource: "transport",
      reported_limits: { max_input_elements: 1_024 },
    });
    const arguments_ = {
      ...paths,
      record_pairs: Array.from({ length: 2_090_000 }, () => 0),
    };
    const argumentBytes = Buffer.byteLength(JSON.stringify(arguments_));
    expect(argumentBytes).toBeLessThan(4 * 1024 * 1024 - 4096);
    const result = await client.callTool({
      name: "compare_bundles",
      arguments: arguments_,
    });
    const { error } = parseMcpToolError(result);
    expect(error.code).toBe("resource_constraint");
    expect(error.details).toMatchObject({
      resource: "transport",
      reported_limits: { max_input_elements: 1_024 },
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096);
    await client.ping();
    const healthy = await client.callTool({
      name: "inspect_analysis_settings",
      arguments: {},
    });
    expect(healthy.isError).not.toBe(true);
  },
);
