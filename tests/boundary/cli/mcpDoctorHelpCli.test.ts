import { expect } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";

const invalidDeadline = { REA_MCP_DOCTOR_DEADLINE_MS: "0" };
const deadlineReport = {
  healthy: false,
  adapter: "production-stdio",
  checks: [
    expect.objectContaining({ name: "REA_MCP_DOCTOR_DEADLINE_MS", ok: false }),
  ],
};
const unknownOption = {
  code: "VALIDATION_ERROR",
  message: "Unknown mcp doctor option: --bogus",
};
const missingFormat = {
  code: "MISSING_OUTPUT_VALUE",
  message:
    "--format requires a value, as in --format <value> or --format=<value>.",
};

cliTest(
  "routes output-prefixed and interleaved commands to the production doctor",
  async ({ cli }) => {
    for (const [arguments_, expected] of [
      [["--format", "json", "mcp", "doctor"], deadlineReport],
      [["mcp", "--json", "doctor"], deadlineReport],
      [["mcp", "--format", "", "doctor", "--json"], missingFormat],
      [
        ["--full-output", "mcp", "--format=json", "doctor"],
        { ok: false, error: deadlineReport },
      ],
    ] as const) {
      const result = await cli.run({
        arguments: arguments_,
        environment: invalidDeadline,
      });
      expect(result, arguments_.join(" ")).toMatchObject({
        exitCode: 1,
        stderr: "",
        json: expected,
      });
    }
  },
);

cliTest(
  "advertises doctor help and honors both spellings over option errors",
  async ({ cli }) => {
    const parent = await cli.run({ arguments: ["mcp", "--help"] });
    expect(parent.exitCode).toBe(0);
    expect(parent.stdout).toContain("doctor");

    for (const arguments_ of [
      ["mcp", "doctor", "--bogus", "--help", "--json"],
      ["--format=", "mcp", "doctor", "-h"],
    ]) {
      const result = await cli.run({
        arguments: arguments_,
        environment: invalidDeadline,
      });
      expect(result, arguments_.join(" ")).toMatchObject({
        exitCode: 0,
        stderr: "",
      });
      expect(result.stdout).toContain("Usage: rea mcp doctor [options]");
      expect(result.stdout).toContain("--format <toon|json|yaml|md|jsonl>");
      expect(result.stdout).toContain("--full-output");
      expect(result.stdout).toContain("--help, -h");
      expect(result.stdout).toContain("current runtime");
      expect(result.stdout).toContain(
        "registered command or launch environment",
      );
    }
  },
);

cliTest(
  "preserves the first option error and still applies later output choices",
  async ({ cli }) => {
    for (const [args, expected] of [
      [
        ["--bogus", "--json", "--full-output", "--format="],
        { ok: false, error: unknownOption },
      ],
      [
        ["--format=", "--json", "--full-output"],
        { ok: false, error: missingFormat },
      ],
      [
        ["--json", "--bogus", "--format=jsonl", "--full-output"],
        {
          $rea: "jsonl/v1",
          type: "error",
          ok: false,
          result: { ok: false, error: unknownOption },
        },
      ],
    ] as const) {
      const result = await cli.run({ arguments: ["mcp", "doctor", ...args] });
      expect(result, args.join(" ")).toMatchObject({ exitCode: 1, stderr: "" });
      expect(result.json, args.join(" ")).toEqual(expected);
    }

    const missing = await cli.run({ arguments: ["mcp", "doctor", "--format"] });
    expect(missing).toMatchObject({
      exitCode: 1,
      stderr: "",
      stdout: `code: ${missingFormat.code}\nmessage: "${missingFormat.message}"\n`,
    });
  },
);

cliTest(
  "diagnoses flag-shaped format values without activating the flags",
  async ({ cli }) => {
    for (const [value, ...format] of [
      ["--help", "--format=--help"],
      ["-h", "--format", "-h"],
      ["--timings", "--format", "--timings"],
      ["--full-output", "--format", "--full-output"],
    ]) {
      const result = await cli.run({
        arguments: ["mcp", "doctor", ...format, "--json"],
      });
      expect(result, value).toMatchObject({ exitCode: 1, stderr: "" });
      expect(result.json, value).toEqual({
        code: "VALIDATION_ERROR",
        message: `Invalid output format: ${value}`,
      });
    }
  },
);

cliTest(
  "writes opt-in timing to stderr and leaves production doctor JSON unchanged",
  async ({ cli }) => {
    const args = ["mcp", "doctor", "--json", "--timings"];
    const timed = await cli.run({
      arguments: args,
      environment: invalidDeadline,
    });
    const disabled = await cli.run({
      arguments: [...args, "--no-timings"],
      environment: invalidDeadline,
    });
    expect(timed).toMatchObject({ exitCode: 1, json: deadlineReport });
    expect(disabled).toMatchObject({
      exitCode: timed.exitCode,
      stdout: timed.stdout,
      stderr: "",
    });
    const lines = timed.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as {
      rea_timings: { version: number; command_ms: number };
    };
    expect(record).toMatchObject({
      rea_timings: { version: 1, command_ms: expect.any(Number) },
    });
    expect(Number.isFinite(record.rea_timings.command_ms)).toBe(true);
    expect(record.rea_timings.command_ms).toBeGreaterThanOrEqual(0);
  },
);
