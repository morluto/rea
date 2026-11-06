import { describe, expect, it } from "vitest";

import { driverCall, w3cKeys } from "./computerActions.js";

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
});
