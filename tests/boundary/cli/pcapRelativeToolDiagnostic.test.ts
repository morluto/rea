import { expect } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";

cliTest.for([
  { setting: "REA_TSHARK_COMMAND", value: "rel/tshark" },
  { setting: "REA_CAPINFOS_COMMAND", value: "rel/capinfos" },
] as const)(
  "Wireshark refuses and identifies the caller's relative $setting selection",
  async ({ setting, value }, { cli }) => {
    const environment = {
      REA_TSHARK_COMMAND: "/nonexistent/rea-test-tshark",
      [setting]: value,
    };
    const result = await cli.run({
      arguments: ["inspect-pcap-client", "--format", "json"],
      environment,
      timeoutMs: 10_000,
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stdout).toContain(setting);
    expect(result.stdout).toContain(value);
    expect(result.stdout).toContain("absolute path");
    expect(result.json).toMatchObject({
      code: "capability_unavailable",
      retryable: false,
      details: { diagnostics: { configured: value } },
    });
    const { client, call } = await connectLocalToolsMcp(environment);
    try {
      const reply = await call("inspect_pcap_client", {});
      expect(reply.isError).toBe(true);
      const content = reply.content.find((item) => item.type === "text");
      if (content?.type !== "text") throw new Error("Missing MCP error text");
      expect(JSON.parse(content.text)).toEqual({ error: result.json });
    } finally {
      await client.close();
    }
  },
);
