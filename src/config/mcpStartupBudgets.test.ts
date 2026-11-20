import { expect, it } from "vitest";

import { MAX_NODE_TIMER_DELAY_MS } from "../domain/analysisResourceLimits.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { parseEnvironment } from "./environment.js";
import {
  MCP_PHASE_BUDGET_FLOOR_MS,
  parseMcpStartupBudgets,
  resolveMcpStartupBudgets,
} from "./mcpStartupBudgets.js";

it("resolves default budgets with the launch setting for each startup phase", () => {
  const budgets = resolveMcpStartupBudgets({});
  expect(budgets).toMatchObject({
    initialize: { setting: "REA_MCP_INITIALIZE_BUDGET_MS" },
    toolsList: { setting: "REA_MCP_TOOLS_LIST_BUDGET_MS" },
    firstCatalog: { setting: "REA_MCP_FIRST_CATALOG_BUDGET_MS" },
    doctor: { setting: "REA_MCP_DOCTOR_DEADLINE_MS" },
  });
  for (const budget of Object.values(budgets))
    expect(budget.milliseconds, budget.setting).toBe(
      budget.defaultMilliseconds,
    );
});

it("admits distinct overrides for all four startup phases", () => {
  const environment = {
    REA_MCP_INITIALIZE_BUDGET_MS: String(MCP_PHASE_BUDGET_FLOOR_MS),
    REA_MCP_TOOLS_LIST_BUDGET_MS: "6000",
    REA_MCP_FIRST_CATALOG_BUDGET_MS: "21000",
    REA_MCP_DOCTOR_DEADLINE_MS: String(MAX_NODE_TIMER_DELAY_MS),
  };
  expect(resolveMcpStartupBudgets(environment)).toMatchObject({
    initialize: { milliseconds: MCP_PHASE_BUDGET_FLOOR_MS, source: "setting" },
    toolsList: { milliseconds: 6_000, source: "setting" },
    firstCatalog: { milliseconds: 21_000, source: "setting" },
    doctor: { milliseconds: MAX_NODE_TIMER_DELAY_MS, source: "setting" },
  });
  const parsed = parseEnvironment(environment);
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value).toMatchObject({
    REA_MCP_INITIALIZE_BUDGET_MS: MCP_PHASE_BUDGET_FLOOR_MS,
    REA_MCP_TOOLS_LIST_BUDGET_MS: 6_000,
    REA_MCP_FIRST_CATALOG_BUDGET_MS: 21_000,
    REA_MCP_DOCTOR_DEADLINE_MS: MAX_NODE_TIMER_DELAY_MS,
  });
});

it.each([
  ["REA_MCP_INITIALIZE_BUDGET_MS", ""],
  ["REA_MCP_TOOLS_LIST_BUDGET_MS", "0"],
  ["REA_MCP_FIRST_CATALOG_BUDGET_MS", "1e3"],
  ["REA_MCP_DOCTOR_DEADLINE_MS", String(MAX_NODE_TIMER_DELAY_MS + 1)],
])("rejects invalid %s=%j as a configuration error", (setting, value) => {
  const environment = { [setting]: value };
  const parsed = parseMcpStartupBudgets(environment);
  if (parsed.ok)
    throw new Error(`Accepted ${setting}=${JSON.stringify(value)}`);
  expect(parsed.error.settings).toEqual([
    { setting, constraint: expect.stringContaining(setting) },
  ]);
  const startup = parseEnvironment(environment);
  if (startup.ok) throw new Error(`Startup accepted ${setting}`);
  expect(startup.error.settings).toEqual(parsed.error.settings);
});

it("reports both invalid phase budgets alongside a valid override", () => {
  const environment = {
    REA_MCP_INITIALIZE_BUDGET_MS: "0",
    REA_MCP_TOOLS_LIST_BUDGET_MS: "6000",
    REA_MCP_DOCTOR_DEADLINE_MS: "nope",
  };
  const parsed = parseMcpStartupBudgets(environment);
  if (parsed.ok) throw new Error("Invalid budgets were accepted");
  expect(parsed.error.settings.map(({ setting }) => setting)).toEqual([
    "REA_MCP_INITIALIZE_BUDGET_MS",
    "REA_MCP_DOCTOR_DEADLINE_MS",
  ]);
  expect(parsed.error.message).not.toContain(
    environment.REA_MCP_TOOLS_LIST_BUDGET_MS,
  );
  expect(() => resolveMcpStartupBudgets(environment)).toThrow(
    ConfigurationError,
  );
});
