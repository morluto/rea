import { expect, it } from "vitest";
import { adbUiInputSchemas } from "./adbUiAnalysis.js";

const scope = { serial: "emulator-5554", package: "com.example.app" };
const snapshot = "00000000-0000-4000-8000-000000000001";

it("keeps omitted selectors distinct from false and empty text", () => {
  const selected = adbUiInputSchemas.find_adb_ui_elements.parse({
    ...scope,
    selector: { text: { value: "" }, enabled: false },
  });
  expect(selected.selector).toEqual({
    text: { value: "", match: "exact" },
    enabled: false,
  });
  expect(selected.selector.clickable).toBeUndefined();
});

it("requires an explicit element for element actions and prevents ignored key-event targets", () => {
  expect(
    adbUiInputSchemas.perform_adb_ui_action.safeParse({
      ...scope,
      snapshot_id: snapshot,
      action: { kind: "tap" },
    }).success,
  ).toBe(false);
  expect(
    adbUiInputSchemas.perform_adb_ui_action.safeParse({
      ...scope,
      snapshot_id: snapshot,
      element_id: "0",
      action: { kind: "key_event", key_code: 4 },
    }).success,
  ).toBe(false);
  expect(
    adbUiInputSchemas.perform_adb_ui_action.safeParse({
      ...scope,
      snapshot_id: snapshot,
      element_id: "0",
      action: { kind: "set_text", text: "" },
    }).success,
  ).toBe(true);
});

it("requires retained snapshot identity for paging and rejects out-of-protocol input", () => {
  expect(
    adbUiInputSchemas.find_adb_ui_elements.safeParse({
      ...scope,
      selector: {},
      offset: 1,
    }).success,
  ).toBe(false);
  expect(
    adbUiInputSchemas.find_adb_ui_elements.safeParse({
      ...scope,
      selector: {},
      offset: 1,
      snapshot_id: snapshot,
    }).success,
  ).toBe(true);
  expect(
    adbUiInputSchemas.inspect_adb_ui.safeParse({ ...scope, timeout_ms: 30001 })
      .success,
  ).toBe(false);
  expect(
    adbUiInputSchemas.perform_adb_ui_action.safeParse({
      ...scope,
      snapshot_id: snapshot,
      element_id: "0",
      action: { kind: "swipe", direction: "up", percent: 2 },
    }).success,
  ).toBe(false);
  expect(
    adbUiInputSchemas.find_adb_ui_elements.safeParse({
      ...scope,
      selector: { script: "arbitrary()" },
    }).success,
  ).toBe(false);
});
