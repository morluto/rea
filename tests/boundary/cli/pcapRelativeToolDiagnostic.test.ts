import { expect } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for([
  { setting: "REA_TSHARK_COMMAND", value: "rel/tshark" },
  { setting: "REA_CAPINFOS_COMMAND", value: "rel/capinfos" },
] as const)(
  "Wireshark refuses and identifies the caller's relative $setting selection",
  async ({ setting, value }, { cli }) => {
    const result = await cli.run({
      arguments: ["inspect-pcap-client", "--format", "json"],
      environment: {
        REA_TSHARK_COMMAND: "/nonexistent/rea-test-tshark",
        [setting]: value,
      },
      timeoutMs: 10_000,
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stdout).toContain(setting);
    expect(result.stdout).toContain(value);
    expect(result.stdout).toContain("absolute path");
  },
);
