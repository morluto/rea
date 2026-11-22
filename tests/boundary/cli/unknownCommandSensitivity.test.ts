import { expect } from "vitest";

import { HOST_PLATFORM } from "../../../src/platform/HostPlatform.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "MCP replies keep the existing default and explicit suggestion policies",
  async ({ cli }) => {
    const implicit = await cli.run({ arguments: ["mcp", "dctor"] });
    expect(implicit.exitCode).toBe(1);
    expect(implicit.stdout).toContain("Did you mean 'doctor'?");
    const explicit = await cli.run({ arguments: ["mcp", "dctor", "--json"] });
    expect(explicit.exitCode).toBe(1);
    expect(explicit.stdout).not.toContain("Did you mean");
  },
);

cliTest(
  "unknown schema diagnostics exclude declared command names",
  async ({ cli }) => {
    const result = await cli.run({
      arguments: [
        "s3cret",
        "--schema",
        "--sensitive-value",
        "s3cret",
        "--json",
      ],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("s3cret");
    expect(result.stdout).toContain("[REDACTED]");
  },
);

cliTest.skipIf(HOST_PLATFORM.platform === "win32")(
  "terminal unknown-command guidance excludes declared values",
  async ({ cli }) => {
    for (const prefix of [[], ["mcp"]]) {
      const result = await cli.run({
        arguments: [...prefix, "s3cret", "--sensitive-value", "s3cret"],
        terminal: true,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain("s3cret");
      expect(result.stdout).toContain("Error:");
      expect(result.stdout).toContain("[REDACTED]");
    }
  },
);

cliTest(
  "unknown-command diagnostics exclude declared values in every document format",
  async ({ cli }) => {
    const secret = "PRIVATE_VALUE";
    for (const format of ["json", "toon", "yaml", "md", "jsonl"]) {
      const result = await cli.run({
        arguments: [
          "inspect-web-network-captur",
          "capture.har",
          "har",
          "--sensitive-value",
          secret,
          "--format",
          format,
        ],
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain(secret);
      expect(result.stdout).not.toContain("rea inspect-web-network-capture ");
      expect(result.stdout).toContain("COMMAND_NOT_FOUND");
    }
  },
);

cliTest(
  "unknown names and fixed guidance honor declarations for root and MCP commands",
  async ({ cli }) => {
    for (const prefix of [[], ["mcp"]]) {
      for (const format of [[], ["--json"], ["--json", "--full-output"]]) {
        const result = await cli.run({
          arguments: [
            ...prefix,
            "s3cret",
            "--sensitive-value",
            "s3cret",
            "--sensitive-value=help",
            ...format,
          ],
        });
        expect(result.exitCode).toBe(1);
        expect(result.stdout).not.toContain("s3cret");
        expect(result.stdout).not.toContain("help");
        expect(result.stdout).toContain("[REDACTED]");
      }
    }
  },
);

cliTest(
  "command corrections retain ordinary values and omit unsafe shell replays",
  async ({ cli }) => {
    const ordinary = await cli.run({
      arguments: [
        "inspect-web-network-captur",
        "ordinary.har",
        "har",
        "--json",
      ],
    });
    expect(ordinary.exitCode).toBe(1);
    expect(ordinary.stdout).toContain(
      "rea inspect-web-network-capture ordinary.har har --json",
    );
    const sameNameData = await cli.run({
      arguments: [
        "inspect-web-network-captur",
        "inspect-web-network-captur",
        "har",
        "--json",
      ],
    });
    expect(sameNameData.stdout).toContain(
      "rea inspect-web-network-capture inspect-web-network-captur har --json",
    );
    const unsafe = await cli.run({
      arguments: [
        "inspect-web-network-captur",
        "capture with spaces.har",
        "har",
        "--json",
      ],
    });
    expect(unsafe.exitCode).toBe(1);
    expect(unsafe.stdout).not.toContain("rea inspect-web-network-capture ");
    expect(unsafe.stdout).toContain("rea --help");
  },
);
