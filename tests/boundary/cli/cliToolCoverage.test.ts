import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createCli } from "../../../src/cli.js";
import { createCliInventory } from "../../../scripts/lib/catalog-cli.mjs";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import {
  CLI_COMMAND_NAMES,
  cliCommandNames,
} from "../../../src/contracts/catalog/catalogIdentity.js";
import { describeContractCommand } from "../../../src/cli/contractCliDescription.js";

import { CLI_COMMAND_TOOL_ALIASES } from "./cliContractAliases.js";

describe("CLI canonical tool coverage", () => {
  it("registers every derived command and every alias of an MCP tool", () => {
    const registered = createCliInventory(createCli());
    expect(registered.primary).toEqual([...CLI_COMMAND_NAMES].sort());
    const names = new Set<string>(TOOL_CONTRACTS.map(({ name }) => name));
    for (const [command, tools] of Object.entries(CLI_COMMAND_TOOL_ALIASES)) {
      expect(registered.primary).toContain(command);
      for (const tool of tools) expect(names.has(tool)).toBe(true);
    }
  });

  it("names a contract's command from its declaration alone", () => {
    const contract = {
      name: "inspect_synthetic_probe",
      cli: true,
      inputSchema: z.strictObject({ path: z.string() }),
    } as const;
    expect(cliCommandNames([contract])).toContain("inspect-synthetic-probe");
    expect(
      describeContractCommand(contract, {
        description: "Probe",
        positionals: ["path"],
      }).command,
    ).toBe("inspect-synthetic-probe");
    const { cli: _undeclared, ...mcpOnly } = contract;
    expect(cliCommandNames([mcpOnly])).not.toContain("inspect-synthetic-probe");
    expect(() =>
      describeContractCommand(mcpOnly, { description: "Probe" }),
    ).toThrow("inspect_synthetic_probe does not declare its CLI command");
  });
});
