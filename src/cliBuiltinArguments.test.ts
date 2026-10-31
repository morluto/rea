import { describe, expect, it } from "vitest";

import { findMcpAddMissingValue } from "./cliBuiltinArguments.js";

describe("findMcpAddMissingValue", () => {
  it("ignores invocations that are not mcp add", () => {
    expect(findMcpAddMissingValue(["setup", "--client"])).toBeUndefined();
    expect(findMcpAddMissingValue(["mcp", "doctor"])).toBeUndefined();
    expect(findMcpAddMissingValue(["mcp"])).toBeUndefined();
    expect(findMcpAddMissingValue(["--mcp"])).toBeUndefined();
    expect(findMcpAddMissingValue(["--help"])).toBeUndefined();
  });

  it("accepts valued options supplied with a value", () => {
    expect(
      findMcpAddMissingValue(["mcp", "add", "--agent", "claude-code"]),
    ).toBeUndefined();
    expect(
      findMcpAddMissingValue([
        "mcp",
        "add",
        "--command",
        "fixture-server --mcp",
      ]),
    ).toBeUndefined();
    expect(
      findMcpAddMissingValue(["mcp", "add", "--agent=claude-code"]),
    ).toBeUndefined();
    expect(
      findMcpAddMissingValue(["mcp", "add", "-c", "node x.mjs"]),
    ).toBeUndefined();
    expect(
      findMcpAddMissingValue(["mcp", "add", "--agent", "amp", "--no-global"]),
    ).toBeUndefined();
  });

  it("rejects a trailing valued option without a value", () => {
    expect(findMcpAddMissingValue(["mcp", "add", "--agent"])).toBe("--agent");
    expect(findMcpAddMissingValue(["mcp", "add", "--command"])).toBe(
      "--command",
    );
    expect(findMcpAddMissingValue(["mcp", "add", "-c"])).toBe("-c");
    expect(
      findMcpAddMissingValue([
        "mcp",
        "add",
        "--agent",
        "claude-code",
        "--command",
      ]),
    ).toBe("--command");
  });

  it("rejects a valued option followed by another flag", () => {
    expect(
      findMcpAddMissingValue(["mcp", "add", "--agent", "--no-global"]),
    ).toBe("--agent");
    expect(findMcpAddMissingValue(["mcp", "add", "--command", "--json"])).toBe(
      "--command",
    );
  });

  it("rejects an equals form with an empty value", () => {
    expect(findMcpAddMissingValue(["mcp", "add", "--agent="])).toBe("--agent");
    expect(findMcpAddMissingValue(["mcp", "add", "--command="])).toBe(
      "--command",
    );
    expect(findMcpAddMissingValue(["mcp", "add", "-c="])).toBe("-c");
    expect(
      findMcpAddMissingValue(["mcp", "add", "--agent", "amp", "--command="]),
    ).toBe("--command");
  });

  it("still accepts non-empty equals forms", () => {
    expect(
      findMcpAddMissingValue(["mcp", "add", "--agent=amp"]),
    ).toBeUndefined();
    expect(
      findMcpAddMissingValue(["mcp", "add", "--command=node x.mjs"]),
    ).toBeUndefined();
    expect(findMcpAddMissingValue(["mcp", "add", "-cfoo"])).toBeUndefined();
  });

  it("leaves help requests alone", () => {
    expect(findMcpAddMissingValue(["mcp", "add", "--help"])).toBeUndefined();
    expect(
      findMcpAddMissingValue(["mcp", "add", "--agent", "--help"]),
    ).toBeUndefined();
  });

  it("still counts a lone dash as a present value", () => {
    expect(
      findMcpAddMissingValue(["mcp", "add", "--agent", "-"]),
    ).toBeUndefined();
  });
});

describe("findMcpAddMissingValue with global flags and empty values", () => {
  it("rejects a valued option after leading global output flags", () => {
    expect(
      findMcpAddMissingValue(["--full-output", "mcp", "add", "--agent"]),
    ).toBe("--agent");
    expect(findMcpAddMissingValue(["--json", "mcp", "add", "--command"])).toBe(
      "--command",
    );
    expect(findMcpAddMissingValue(["--token-count", "mcp", "add", "-c"])).toBe(
      "-c",
    );
    expect(findMcpAddMissingValue(["--timings", "mcp", "add", "--agent"])).toBe(
      "--agent",
    );
    expect(
      findMcpAddMissingValue(["--format", "json", "mcp", "add", "--agent"]),
    ).toBe("--agent");
    expect(
      findMcpAddMissingValue(["--format=json", "mcp", "add", "--agent"]),
    ).toBe("--agent");
  });

  it("rejects a valued option with global flags between mcp and add", () => {
    expect(
      findMcpAddMissingValue(["mcp", "--full-output", "add", "--agent"]),
    ).toBe("--agent");
    expect(findMcpAddMissingValue(["mcp", "--json", "add", "--command"])).toBe(
      "--command",
    );
    expect(findMcpAddMissingValue(["mcp", "--token-count", "add", "-c"])).toBe(
      "-c",
    );
  });

  it("rejects an empty string value", () => {
    expect(findMcpAddMissingValue(["mcp", "add", "--agent", ""])).toBe(
      "--agent",
    );
    expect(findMcpAddMissingValue(["mcp", "add", "--command", ""])).toBe(
      "--command",
    );
    expect(findMcpAddMissingValue(["mcp", "add", "-c", ""])).toBe("-c");
    expect(
      findMcpAddMissingValue(["--full-output", "mcp", "add", "--agent", ""]),
    ).toBe("--agent");
  });

  it("rejects an option swallowed by another option", () => {
    expect(
      findMcpAddMissingValue(["mcp", "add", "--command", "--agent", "amp"]),
    ).toBe("--command");
    expect(
      findMcpAddMissingValue(["mcp", "add", "--agent", "--command", "x"]),
    ).toBe("--agent");
  });

  it("leaves mode flags ahead of the command alone", () => {
    expect(
      findMcpAddMissingValue(["--mcp", "mcp", "add", "--agent"]),
    ).toBeUndefined();
    expect(
      findMcpAddMissingValue(["mcp", "--mcp", "add", "--agent"]),
    ).toBeUndefined();
    expect(
      findMcpAddMissingValue(["--llms", "mcp", "add", "--agent"]),
    ).toBeUndefined();
    expect(
      findMcpAddMissingValue(["mcp", "--llms", "add", "--agent"]),
    ).toBeUndefined();
    expect(
      findMcpAddMissingValue(["--llms-full", "mcp", "add", "--agent"]),
    ).toBeUndefined();
    expect(
      findMcpAddMissingValue(["--schema", "mcp", "add", "--agent"]),
    ).toBeUndefined();
    expect(
      findMcpAddMissingValue(["--update", "mcp", "add", "--agent"]),
    ).toBeUndefined();
    expect(
      findMcpAddMissingValue(["--incur-update-check", "mcp", "add", "--agent"]),
    ).toBeUndefined();
  });

  it("still accepts valid values with global output flags", () => {
    expect(
      findMcpAddMissingValue(["--full-output", "mcp", "add", "--agent", "amp"]),
    ).toBeUndefined();
    expect(
      findMcpAddMissingValue(["mcp", "add", "--agent", "amp", "--full-output"]),
    ).toBeUndefined();
    expect(
      findMcpAddMissingValue([
        "--format",
        "json",
        "mcp",
        "add",
        "--agent",
        "amp",
      ]),
    ).toBeUndefined();
  });
});
