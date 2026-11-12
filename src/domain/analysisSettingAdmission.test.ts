import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  analysisSettingDefinition,
  runtimeAnalysisEnvironmentNames,
} from "./analysisSettingDefinitions.js";

const source = (path: string) =>
  readFileSync(join(import.meta.dirname, path), "utf8");

it("does not validate runtime-owned launch seeds at startup", () => {
  const startup = [
    source("../config/environment.ts"),
    source("../config/debuggerSessionLimits.ts"),
  ].join("\n");
  const mentioned = [...runtimeAnalysisEnvironmentNames()].filter(
    (name) => startup.includes(`${name}:`) || startup.includes(`[${name}]`),
  );
  expect(mentioned).toEqual([]);
});

it("advertises the operations that consume each migrated setting", () => {
  const operations = (id: Parameters<typeof analysisSettingDefinition>[0]) =>
    analysisSettingDefinition(id).operations;
  expect(operations("debugger.command_deadline_ms")).toEqual(
    expect.arrayContaining(["close_gdb_session", "close_rizin_debug_session"]),
  );
  expect(operations("kuna.function_timeout_ms")).toContain("list_procedures");
  expect(operations("windows.change_time_drift_ms")).toEqual(
    expect.arrayContaining(["inspect_binary_layout", "inspect_recorded_crash"]),
  );
  expect(
    operations("pwntools.max_input_bytes").includes("inspect_binary_layout"),
  ).toBe(true);
  expect(analysisSettingDefinition("pwntools.max_input_bytes").parameter).toBe(
    "producer_limits.input_bytes",
  );
});
