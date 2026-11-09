import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import { createCliInventory } from "../../../scripts/lib/catalog-cli.mjs";
import type * as CliModule from "../../../src/cli.js";
import { CLI_COMMAND_GROUPS } from "../../../src/cli/commandGroups.js";
import { CLI_COMMAND_NAMES } from "../../../src/cliCommandNames.js";

// The compiled runtime carries the build-recorded command ownership.
const compiled = async (): Promise<{
  readonly cli: typeof CliModule;
  readonly recorded: Readonly<Record<string, string>>;
}> => {
  const cli = (await import(
    pathToFileURL(resolve("dist/cli.js")).href
  )) as typeof CliModule;
  const { RECORDED_CLI_COMMAND_GROUPS } = (await import(
    pathToFileURL(resolve("dist/recordedCliCommandGroups.js")).href
  )) as { RECORDED_CLI_COMMAND_GROUPS: Readonly<Record<string, string>> };
  return { cli, recorded: RECORDED_CLI_COMMAND_GROUPS };
};

it("records one known owning group for every primary CLI command", async () => {
  const { recorded } = await compiled();
  const groupIds = new Set(CLI_COMMAND_GROUPS.map(({ id }) => id));
  expect(groupIds.size).toBe(CLI_COMMAND_GROUPS.length);
  for (const name of CLI_COMMAND_NAMES)
    expect(groupIds.has(recorded[name] ?? ""), name).toBe(true);
  expect(new Set(Object.values(recorded))).toEqual(groupIds);
}, 60_000);

it("registers exactly the owning group for a recorded command and every group otherwise", async () => {
  const { cli, recorded } = await compiled();
  const full = createCliInventory(await cli.createCli({})).primary;
  expect(full).toEqual([...CLI_COMMAND_NAMES].sort());

  for (const command of ["doctor", "analyze", "inspect-sqlite-database"]) {
    const owner = recorded[command];
    const selected = createCliInventory(
      await cli.createCli({}, undefined, undefined, command),
    ).primary;
    expect(selected).toContain(command);
    expect(selected).toEqual(full.filter((name) => recorded[name] === owner));
  }

  // Root help, built-ins, typos and option tokens keep the complete router.
  for (const token of ["--help", "mcp", "analyse", "__proto__", "toString"])
    expect(
      createCliInventory(await cli.createCli({}, undefined, undefined, token))
        .primary,
    ).toEqual(full);
}, 120_000);
