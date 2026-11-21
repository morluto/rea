import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ANALYSIS_SETTINGS } from "./analysisSettingDefinitions.js";
import { NUMERIC_LIMIT_REGISTRY } from "./numericLimitRegistry.js";

const inventory = readFileSync(
  join(import.meta.dirname, "../../docs/reference/rea-limit-inventory.md"),
  "utf8",
);

const inventoryRows = inventory
  .split("\n")
  .filter((line) => line.startsWith("|"));

const cells = (line: string): string[] =>
  line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());

/** A markdown table row whose first cell is exactly this name. */
const exceptionRow = (name: string): string[] => {
  const line = inventoryRows.find((row) => cells(row)[0] === `\`${name}\``);
  expect(line, name).toBeDefined();
  return cells(line ?? "");
};

it("documents the owners of numeric exceptions and runtime environment seeds", () => {
  for (const { name } of NUMERIC_LIMIT_REGISTRY) {
    const row = exceptionRow(name);
    expect(row[1]?.length ?? 0).toBeGreaterThan(0);
  }
  for (const definition of Object.values(ANALYSIS_SETTINGS)) {
    if (!("environment" in definition) || definition.environment === undefined)
      continue;
    const listed = inventoryRows.some((row) =>
      cells(row).includes(`\`${definition.environment}\``),
    );
    expect(listed, definition.environment).toBe(true);
  }
});
