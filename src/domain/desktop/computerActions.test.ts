import { describe, expect, it } from "vitest";

import {
  computerActionInputSchema,
  driverCall,
  w3cKeys,
} from "./computerActions.js";

describe("computer actions", () => {
  it("translates model key spellings to W3C names and keeps W3C names and characters", () => {
    expect(w3cKeys(["ctrl+s"])).toEqual(["Control", "s"]);
    expect(w3cKeys(["cmd+Shift+z"])).toEqual(["Meta", "Shift", "z"]);
    expect(w3cKeys(["Return", "esc", "pgdn", "f5", "space"])).toEqual([
      "Enter",
      "Escape",
      "PageDown",
      "F5",
      " ",
    ]);
    expect(w3cKeys(["Control", "ArrowUp", "+", "ctrl++"])).toEqual([
      "Control",
      "ArrowUp",
      "+",
      "Control",
      "+",
    ]);
    // An unknown name passes through for the driver to refuse with its hint.
    expect(w3cKeys(["Hyper"])).toEqual(["Hyper"]);
  });

  it("passes the driver's arguments through and translates key fields", () => {
    expect(
      driverCall("click", { x: 500, y: 250, count: 2, space: "norm" }),
    ).toEqual({
      ok: true,
      value: {
        tool: "computer_click",
        arguments: { x: 500, y: 250, count: 2, space: "norm" },
      },
    });
    expect(driverCall("key", { keys: ["ctrl+s"] })).toEqual({
      ok: true,
      value: { tool: "computer_key", arguments: { keys: ["Control", "s"] } },
    });
    expect(
      driverCall("drag", {
        path: [
          [1, 2],
          [3, 4],
        ],
        modifiers: ["shift"],
      }),
    ).toEqual({
      ok: true,
      value: {
        tool: "computer_drag",
        arguments: {
          path: [
            [1, 2],
            [3, 4],
          ],
          modifiers: ["Shift"],
        },
      },
    });
  });

  it("refuses a field the action does not take", () => {
    expect(driverCall("type", { text: "hi", x: 3 })).toEqual({
      ok: false,
      error: { field: "x", accepted: ["text", "screenshot"] },
    });
  });

  it("types a secret by its handle alone, with no screenshot and no text", () => {
    expect(driverCall("type_secret", { secret: "keepassxc-master" })).toEqual({
      ok: true,
      value: {
        tool: "computer_type",
        arguments: { secret: "keepassxc-master" },
      },
    });
    expect(
      driverCall("type_secret", {
        secret: "keepassxc-master",
        screenshot: true,
      }),
    ).toEqual({
      ok: false,
      error: { field: "screenshot", accepted: ["secret"] },
    });
    expect(
      driverCall("type_secret", { secret: "keepassxc-master", text: "x" }),
    ).toEqual({ ok: false, error: { field: "text", accepted: ["secret"] } });
    expect(driverCall("type_secret", {})).toEqual({
      ok: false,
      error: { field: "secret", accepted: ["secret"], missing: true },
    });
    expect(
      computerActionInputSchema.safeParse({
        computer_id: "00000000-0000-4000-8000-000000000001",
        action: "type_secret",
        secret: "../passwd",
      }).success,
    ).toBe(false);
  });

  it("resets the app's data rather than calling a driver tool, taking only a screenshot afterwards", () => {
    expect(driverCall("reset", { screenshot: true })).toEqual({
      ok: true,
      value: { tool: "data/reset", arguments: { screenshot: true } },
    });
    expect(driverCall("reset", { keys: ["Enter"] })).toEqual({
      ok: false,
      error: { field: "keys", accepted: ["screenshot"] },
    });
  });
});
