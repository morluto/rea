import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createCli } from "../../../src/cli.js";
import {
  cliCommands,
  commandOwnOperations,
  type CliCommandEntry,
} from "../../../src/cli/commandRegistry.js";
import { optionFlagName } from "../../../src/cli/optionFields.js";
import { createCliInventory } from "../../../scripts/lib/catalog-cli.mjs";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { cliCommandFor } from "../../../src/contracts/cliCommandNames.js";
import {
  CLI_COMMAND_NAMES,
  cliCommandNames,
} from "../../../src/contracts/catalog/catalogIdentity.js";
import { describeContractCommand } from "../../../src/cli/contractCliDescription.js";

const coverageViolations = (
  entries: readonly CliCommandEntry[],
  contracts: readonly { readonly name: string; readonly cli?: boolean }[],
): readonly string[] => {
  const violations: string[] = [];
  const contractNames = new Set<string>(contracts.map(({ name }) => name));
  const byName = new Map(entries.map((entry) => [entry.name, entry]));

  for (const contract of contracts) {
    if (contract.cli !== true) continue;
    const command = cliCommandFor(contract.name);
    const entry = byName.get(command);
    if (entry === undefined) {
      violations.push(`missing CLI command ${command} for ${contract.name}`);
      continue;
    }
    if (!commandOwnOperations(entry).some(({ name }) => name === contract.name))
      violations.push(
        `command ${command} does not bind primary operation ${contract.name}`,
      );
  }

  for (const entry of entries) {
    const optionKeys =
      entry.definition.options === undefined
        ? []
        : Object.keys(entry.definition.options.shape);
    const validFlags = new Set(
      optionKeys.map((key) => `--${optionFlagName(key)}`),
    );
    for (const operation of entry.operations) {
      if (!contractNames.has(operation.name))
        violations.push(
          `command ${entry.name} binds unknown contract ${operation.name}`,
        );
      for (const [field, flag] of Object.entries(operation.flags)) {
        if (!validFlags.has(flag))
          violations.push(
            `command ${entry.name} binds ${operation.name}.${field} to undeclared flag ${flag}`,
          );
      }
    }
  }
  return violations;
};

describe("CLI canonical tool coverage", () => {
  it("registers every derived command and binds every command operation and flag to its contract", () => {
    const entries = cliCommands(createCli());
    const registered = createCliInventory(entries);
    expect(registered.primary).toEqual([...CLI_COMMAND_NAMES].sort());
    expect(new Set(registered.primary).size).toBe(registered.primary.length);
    expect(coverageViolations(entries, TOOL_CONTRACTS)).toEqual([]);
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
