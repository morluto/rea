import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import { createCliInventory } from "../../../scripts/lib/catalog-cli.mjs";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import {
  CLI_COMMAND_ALIASES,
  CLI_COMMAND_NAMES,
  CLI_COMMAND_TOOL_ALIASES,
  MCP_TOOLS_WITHOUT_DEDICATED_CLI,
} from "../../../src/cliCommandNames.js";

describe("CLI canonical tool coverage", () => {
  it("accounts for every MCP tool on the CLI or marks it intentionally MCP-only", () => {
    const registeredCli = createCliInventory(createCli());
    const registeredCommandNames = new Set([
      ...registeredCli.primary,
      ...registeredCli.aliases.map(({ name }) => name),
    ]);
    const cliToolNames = new Set(
      registeredCli.primary.map((command) => command.replaceAll("-", "_")),
    );
    for (const [command, names] of Object.entries(CLI_COMMAND_TOOL_ALIASES)) {
      expect(registeredCommandNames.has(command)).toBe(true);
      for (const name of names) cliToolNames.add(name);
    }
    for (const command of CLI_COMMAND_NAMES)
      expect(registeredCommandNames.has(command)).toBe(true);
    for (const command of CLI_COMMAND_ALIASES)
      expect(registeredCommandNames.has(command)).toBe(true);
    const intentionalMcpOnly = new Set<string>(MCP_TOOLS_WITHOUT_DEDICATED_CLI);
    expect(
      [...intentionalMcpOnly].filter((name) => cliToolNames.has(name)).sort(),
    ).toEqual([]);
    const unaccounted = TOOL_CONTRACTS.map(({ name }) => name).filter(
      (name) => !cliToolNames.has(name) && !intentionalMcpOnly.has(name),
    );
    expect(unaccounted).toEqual([]);
    expect(new Set(MCP_TOOLS_WITHOUT_DEDICATED_CLI).size).toBe(
      MCP_TOOLS_WITHOUT_DEDICATED_CLI.length,
    );
    expect(
      MCP_TOOLS_WITHOUT_DEDICATED_CLI.every((name) =>
        TOOL_CONTRACTS.some((contract) => contract.name === name),
      ),
    ).toBe(true);
  });
});
