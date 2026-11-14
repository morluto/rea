import { expect, it } from "vitest";
import { parseDesktopTask } from "./appTask.js";
import { evaluateTaskChecks } from "./appTaskChecks.js";

it.each(["__proto__", "constructor", "ordinary"])(
  "retains the own row condition %s while grading every selected column",
  (column) => {
    const where = Object.fromEntries([
      ["id", 1],
      [column, "wanted"],
    ]);
    const common = { file: "db.sqlite", table: "rows", where };
    const parsed = parseDesktopTask({
      name: "find-row",
      prompt: "Find the row matching every selected column.",
      checks: [
        { kind: "row_present", ...common },
        { kind: "row_absent", ...common },
        { kind: "row_count", ...common, equals: 0 },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const first = parsed.value.checks[0];
    if (first?.kind !== "row_present") throw new Error("Expected a row check");
    expect(Object.keys(first.where)).toEqual(["id", column]);
    const views = new Map([
      [
        "db.sqlite",
        {
          format: "sqlite",
          view: {
            tables: {
              rows: {
                columns: ["id", column],
                primary_key: ["id"],
                rows: [[1, "other"]],
                truncated: false,
              },
            },
            tables_truncated: false,
          },
        },
      ],
    ]);
    expect(
      evaluateTaskChecks(parsed.value.checks, views).map(
        ({ passed }) => passed,
      ),
    ).toEqual([false, true, true]);
    expect(Object.keys(where)).toEqual(["id", column]);
  },
);

it("accepts an own __proto__ condition as a nonempty row predicate", () => {
  const where = JSON.parse('{"__proto__":"wanted"}');
  const parsed = parseDesktopTask({
    name: "find-row",
    prompt: "Find the selected row.",
    checks: [{ kind: "row_present", file: "db.sqlite", table: "rows", where }],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const check = parsed.value.checks[0];
  if (check?.kind !== "row_present") throw new Error("Expected a row check");
  expect(Object.keys(check.where)).toEqual(["__proto__"]);
  expect(check.where["__proto__"]).toBe("wanted");
});
