import { expect } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { writeStubTools } from "../fixtures/pcap/pcapTestTools.js";
import { cliTest } from "../support/cli/cliFixture.js";

const environmentFor = (
  root: string,
  tools: { readonly tshark: string; readonly capinfos: string },
) => ({
  HOME: root,
  USERPROFILE: root,
  XDG_CONFIG_HOME: root,
  XDG_CACHE_HOME: root,
  REA_LOG_LEVEL: "silent",
  REA_TSHARK_COMMAND: tools.tshark,
  REA_CAPINFOS_COMMAND: tools.capinfos,
});

const parameterLimit = (field: string, effective: number) => ({
  control_kind: "parameter",
  parameter: `producer_limits.${field}`,
  effective_value: effective,
  unit: "bytes",
  minimum: 1,
  applies_at: "next_call",
});

cliTest.skipIf(process.platform !== "linux")(
  "names producer_limits for an inspect_pcap_capture refusal and admits the capture once raised",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pcap-producer-limits-");
    const path = join(root, "capture.pcap");
    await writeFile(path, Buffer.from("pcap-fixture-bytes"));
    const tools = await writeStubTools(root);
    const environment = environmentFor(root, tools);

    // The 18-byte capture exceeds an 8-byte snapshot budget before tshark runs.
    const input = await cli.run({
      arguments: [
        "inspect-pcap-capture",
        path,
        "--producer-limits",
        JSON.stringify({ input_bytes: 8 }),
        "--json",
      ],
      environment,
    });
    expect(input.exitCode, input.stdout).toBe(1);
    expect(input.json).toMatchObject({
      code: "resource_constraint",
      details: {
        limit: {
          ...parameterLimit("input_bytes", 8),
          default_value: 2 * 1024 ** 3,
        },
      },
    });
    expect(input.json).not.toHaveProperty("details.refusal");

    // The stub's tshark JSON exceeds a 16-byte output budget.
    const output = await cli.run({
      arguments: [
        "inspect-pcap-capture",
        path,
        "--producer-limits",
        JSON.stringify({ output_bytes: 16 }),
        "--json",
      ],
      environment,
    });
    expect(output.exitCode, output.stdout).toBe(1);
    expect(output.json).toMatchObject({
      code: "resource_constraint",
      details: {
        limit: {
          ...parameterLimit("output_bytes", 16),
          maximum: 128 * 1024 * 1024,
          default_value: 8 * 1024 * 1024,
        },
      },
    });

    // The same complete capture succeeds with the defaults.
    const admitted = await cli.run({
      arguments: ["inspect-pcap-capture", path, "--json"],
      environment,
    });
    expect(admitted.exitCode, admitted.stdout).toBe(0);

    const { client, call } = await connectLocalToolsMcp(environment);
    try {
      const reply = await call("inspect_pcap_capture", {
        path,
        producer_limits: { output_bytes: 16 },
      });
      expect(reply.isError).toBe(true);
      const text = reply.content.find((item) => item.type === "text");
      if (text?.type !== "text") throw new Error("Missing MCP error text");
      expect(JSON.parse(text.text)).toMatchObject({
        error: {
          code: "resource_constraint",
          details: { limit: parameterLimit("output_bytes", 16) },
        },
      });
    } finally {
      await client.close();
    }
  },
);
