import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ANALYSIS_SETTINGS } from "./analysisSettingDefinitions.js";
import { NUMERIC_LIMIT_REGISTRY } from "./numericLimitRegistry.js";

const inventory = readFileSync(
  join(import.meta.dirname, "../../docs/design/rea-limit-inventory.md"),
  "utf8",
);

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
    expect(entry.read).toBe(
      entry.policy === "per-call" ? "per-call" : "startup",
    );
    expect(runtimeEnvironments.has(entry.name)).toBe(false);
    expect(inventory).toContain(`\`${entry.name}\``);
  }
  expect(
    NUMERIC_LIMIT_REGISTRY.filter((entry) => entry.policy === "restart-only"),
  ).toHaveLength(15);
  expect(
    NUMERIC_LIMIT_REGISTRY.filter((entry) => entry.policy === "per-call"),
  ).toHaveLength(11);
});
