import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ANALYSIS_SETTINGS } from "./analysisSettingDefinitions.js";
import { NUMERIC_LIMIT_REGISTRY } from "./numericLimitRegistry.js";

const inventory = readFileSync(
  join(import.meta.dirname, "../../docs/design/rea-limit-inventory.md"),
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

it("gives every numeric exception a reason and a matching inventory row", () => {
  const names = NUMERIC_LIMIT_REGISTRY.map((entry) => entry.name);
  expect(new Set(names).size).toBe(names.length);
  const runtimeEnvironments = new Set<string>(
    Object.values(ANALYSIS_SETTINGS).flatMap((definition) =>
      "environment" in definition && definition.environment !== undefined
        ? [definition.environment]
        : [],
    ),
  );
  for (const entry of NUMERIC_LIMIT_REGISTRY) {
    expect(entry.update_mode).toBe("restart");
    expect(entry.reason.trim().length).toBeGreaterThanOrEqual(40);
    expect(entry.policy).toBe("restart-only");
    expect(["startup", "construction"]).toContain(entry.read);
    expect(runtimeEnvironments.has(entry.name)).toBe(false);
    const row = exceptionRow(entry.name);
    expect(row.length).toBeGreaterThanOrEqual(5);
    expect(row[1]?.length ?? 0).toBeGreaterThan(0);
  }
  expect(NUMERIC_LIMIT_REGISTRY).toHaveLength(15);
  for (const definition of Object.values(ANALYSIS_SETTINGS)) {
    if (!("environment" in definition) || definition.environment === undefined)
      continue;
    const listed = inventoryRows.some((row) =>
      cells(row).includes(`\`${definition.environment}\``),
    );
    expect(listed, definition.environment).toBe(true);
  }
  expect(inventory).not.toMatch(/^\| `REA_MANAGED_LINUX_HOPPER_LAUNCHER`/mu);
  expect(inventory).not.toMatch(/^\| `REA_WORKFLOW_PROVIDER`/mu);
});
