import { describe, expect, it } from "vitest";

import { appStateViews } from "./appStateViews.js";
import { parseDesktopTask } from "./appTask.js";
import { evaluateTaskChecks } from "./appTaskChecks.js";

describe("app state views", () => {
  it.each(["__proto__", "constructor", "ordinary"])(
    "grades the exact own state path %s instead of treating it as absent",
    (path) => {
      const view = JSON.parse('{"count":7,"__proto__":"retained value"}');
      const parts = [
        {
          kind: "data",
          data: {
            state: Object.fromEntries([[path, { format: "json", view }]]),
          },
        },
      ];
      const task = parseDesktopTask({
        name: "check-state",
        prompt: "Check the selected file and its value.",
        checks: [
          { kind: "file_present", file: path },
          { kind: "file_absent", file: path },
          { kind: "value_equals", file: path, pointer: "/count", value: 7 },
        ],
      });
      const parsed = appStateViews(parts);
      if (!task.ok) throw new Error(task.error);
      if (!parsed.ok) throw new Error(parsed.error);
      expect([...parsed.value.keys()]).toEqual([path]);
      expect(parsed.value.get(path)).toEqual({
        format: "json",
        view,
        error: null,
      });
      expect(
        evaluateTaskChecks(task.value.checks, parsed.value).map(
          ({ passed }) => passed,
        ),
      ).toEqual([true, false, true]);
      expect(Object.hasOwn(parts[0]!.data.state, path)).toBe(true);
      expect(Object.hasOwn(view, "__proto__")).toBe(true);
    },
  );

  it.each(
    ["__proto__", "ordinary"].flatMap((path) => [
      { path, entry: { format: 7, view: null } },
      { path, entry: { format: "json" } },
      { path, entry: { format: null, view: null, error: 7 } },
    ]),
  )("rejects a malformed view under $path: $entry", ({ path, entry }) => {
    expect(
      appStateViews([
        { kind: "data", data: { state: Object.fromEntries([[path, entry]]) } },
      ]),
    ).toMatchObject({ ok: false });
  });

  it("reads the app's data/get state into the views the checks read, keeping each file's error", () => {
    expect(
      appStateViews([
        { kind: "file", file: { bytes: "eA==" } },
        {
          kind: "data",
          data: {
            state: {
              "Documents/todo.txt": {
                format: "text",
                view: { lines: ["milk"], truncated: false },
                truncated: false,
              },
              "Documents/big.bin": {
                format: null,
                view: null,
                error: "larger than 64 MiB, the most the view reads",
              },
            },
          },
        },
      ]),
    ).toEqual({
      ok: true,
      value: new Map([
        [
          "Documents/todo.txt",
          {
            format: "text",
            view: { lines: ["milk"], truncated: false },
            error: null,
          },
        ],
        [
          "Documents/big.bin",
          {
            format: null,
            view: null,
            error: "larger than 64 MiB, the most the view reads",
          },
        ],
      ]),
    });
    expect(appStateViews([{ kind: "file" }])).toMatchObject({
      ok: false,
      error: expect.stringContaining("no state views"),
    });
  });
});
