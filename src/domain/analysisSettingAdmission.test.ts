import { expect, it } from "vitest";
import { analysisSettingDefinition } from "./analysisSettingDefinitions.js";

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
