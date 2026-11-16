import type { CliCommandEntry } from "../../src/cli/commandRegistry.js";

export function createCliInventory(entries: readonly CliCommandEntry[]): {
  readonly primary: readonly string[];
  readonly aliases: readonly {
    readonly name: string;
    readonly target: string;
  }[];
};
export function cliCommandOptionNames(
  entries: readonly CliCommandEntry[],
  name: string,
): readonly string[];
export function cliCommandDescriptionIssues(
  entries: readonly CliCommandEntry[],
): readonly string[];
