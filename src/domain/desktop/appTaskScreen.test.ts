import { describe, expect, it } from "vitest";

import { parseDesktopTask } from "./appTask.js";
import { evaluateTaskChecks, type TaskFileView } from "./appTaskChecks.js";
import { renderTaskVerifier } from "./appTaskPython.js";
import {
  DEFAULT_JUDGE_MODEL,
  isScreenTask,
  readableChanges,
  screenExamplesOf,
} from "./appTaskScreen.js";

const portable = (name: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name);
const SHOWN = {
  id: "shown",
  kind: "screen_judge",
  question: "Does the calculator's display show the result 8.568?",
};
const parse = (change: Record<string, unknown>) =>
  parseDesktopTask(
    {
      name: "tip-total",
      prompt:
        "In Calculator, work out 18% of 47.60 and leave the result showing.",
      checks: [SHOWN],
      ...change,
    },
    portable,
  );
const EXAMPLES = { fail: "c2VlZA==", pass: "ZW5k" };

describe("screen_judge checks", () => {
  it("keeps a task whose checks are screen judges", () => {
    const parsed = parse({});
    expect(parsed).toMatchObject({ ok: true, value: { checks: [SHOWN] } });
    expect(parsed.ok && isScreenTask(parsed.value)).toBe(true);
  });

  it.each([
    [
      {
        checks: [
          SHOWN,
          { kind: "file_present", file: "Documents/receipt.txt" },
        ],
      },
      "a task with screen_judge checks holds only screen_judge checks",
    ],
    [
      {
        readers: [
          {
            id: "x",
            file: "Documents/a.bin",
            argv: ["cat", "{file}"],
            output: "lines",
          },
        ],
      },
      "takes no readers",
    ],
    [{ checks: [{ ...SHOWN, question: " " }] }, "at checks.0.question"],
    [{ checks: [{ ...SHOWN, file: "Documents/a.txt" }] }, "at checks.0"],
  ])("refuses %j", (change, message) => {
    const parsed = parse(change);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  it("leaves a screen judge undecided in REA's evaluator, which reads no screen", () => {
    const parsed = parse({});
    if (!parsed.ok) throw new Error(parsed.error);
    const [outcome] = evaluateTaskChecks(parsed.value.checks, new Map());
    expect(outcome).toMatchObject({
      id: "shown",
      passed: false,
      undecided: true,
    });
    expect(outcome?.description).toContain("screen");
  });

  it("renders a verifier that screenshots the computer and asks the judge with the build's two examples", () => {
    const parsed = parse({});
    if (!parsed.ok) throw new Error(parsed.error);
    const verifier = renderTaskVerifier(parsed.value, "calculator", EXAMPLES);

    expect(verifier).toContain("computer_screenshot");
    expect(verifier).toContain(
      `DEFAULT_JUDGE_MODEL = "${DEFAULT_JUDGE_MODEL}"`,
    );
    expect(verifier).toContain('get_model_for_role("judge")');
    expect(verifier).toContain("VOTES = 3");
    expect(verifier).toContain("--judge-model");
    expect(screenExamplesOf(verifier)).toEqual(EXAMPLES);
    expect(screenExamplesOf("CHECKS = []\n")).toBeUndefined();
  });

  it("finds the files whose change a check could read, ignoring unreadable and unchanged ones", () => {
    const text = (...lines: string[]): TaskFileView => ({
      format: "text",
      view: { lines, line_count: lines.length, truncated: false },
    });
    const seed = new Map<string, TaskFileView>([
      ["Documents/same.txt", text("a")],
      ["Documents/edited.txt", text("a")],
      ["Documents/gone.txt", text("a")],
      ["Documents/blob.bin", { format: "binary", view: null }],
      [".cache/broken.db", { format: null, view: null, error: "locked" }],
    ]);
    const end = new Map<string, TaskFileView>([
      ["Documents/same.txt", text("a")],
      ["Documents/edited.txt", text("b")],
      ["Documents/new.txt", text("c")],
      ["Documents/blob.bin", { format: "binary", view: null }],
      [".cache/broken.db", { format: null, view: null, error: "locked again" }],
    ]);
    expect(readableChanges(seed, end)).toEqual([
      "Documents/edited.txt",
      "Documents/gone.txt",
      "Documents/new.txt",
    ]);
  });
});
