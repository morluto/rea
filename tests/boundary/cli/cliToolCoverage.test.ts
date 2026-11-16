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
    expect(coverageViolations(entries, TOOL_CONTRACTS)).toEqual([]);

    const aliasedCommands = entries.filter((entry) => {
      const own = commandOwnOperations(entry);
      return (
        own.length > 0 &&
        own.every(({ name }) => cliCommandFor(name) !== entry.name)
      );
    });
    expect(aliasedCommands.length).toBeGreaterThanOrEqual(14);
  });

  it("rejects an unmapped cli: true contract or invalid operation/flag registration", () => {
    const entries = cliCommands(createCli());
    expect(
      coverageViolations(entries, [
        ...TOOL_CONTRACTS,
        { name: "inspect_unmapped_probe", cli: true },
      ]),
    ).toEqual([
      "missing CLI command inspect-unmapped-probe for inspect_unmapped_probe",
    ]);
    const withoutBinding = entries.map((entry) =>
      entry.name === "inspect-plist" ? { ...entry, operations: [] } : entry,
    );
    expect(coverageViolations(withoutBinding, TOOL_CONTRACTS)).toEqual([
      "command inspect-plist does not bind primary operation inspect_plist",
    ]);
    const withoutRoutedBinding = entries.map((entry) =>
      entry.name === "compare-web-captures"
        ? { ...entry, operations: [] }
        : entry,
    );
    expect(coverageViolations(withoutRoutedBinding, TOOL_CONTRACTS)).toEqual([
      "command compare-web-captures does not bind primary operation compare_web_captures",
    ]);
    const badFlag = entries.map((entry) =>
      entry.name === "guidance"
        ? {
            ...entry,
            operations: [
              { name: "search_guidance", flags: { query: "--nonexistent" } },
            ],
          }
        : entry,
    );
    expect(coverageViolations(badFlag, TOOL_CONTRACTS)).toEqual([
      "command guidance binds search_guidance.query to undeclared flag --nonexistent",
    ]);
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
