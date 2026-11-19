import { describe, expect, it } from "vitest";

import type { DesktopTask } from "./appTask.js";
import { renderTaskVerifier, sameTaskVerifier } from "./appTaskPython.js";

const task: DesktopTask = {
  name: "add-eggs",
  prompt: "Add eggs to today's list.",
  checks: [
    {
      id: "eggs",
      kind: "text_contains",
      file: "Documents/today.txt",
      pointer: "/root",
      value: "eggs",
    },
  ],
};

describe("sameTaskVerifier", () => {
  it("accepts the current generated verifier and rejects changed checks or evaluator code", () => {
    const hosted = renderTaskVerifier(task, "notes");
    expect(sameTaskVerifier(hosted, hosted)).toBe(true);
    const changedChecks = renderTaskVerifier(
      {
        ...task,
        checks: [
          {
            id: "eggs",
            kind: "text_contains",
            file: "Documents/today.txt",
            pointer: "/root",
            value: "milk",
          },
        ],
      },
      "notes",
    );
    for (const bundled of [
      changedChecks,
      hosted.replace(
        'INDEX = re.compile(r"0|[1-9][0-9]*")',
        'INDEX = re.compile(r"[0-9]+")',
      ),
      hosted.replace("def _shown", "def _show"),
      hosted.replace(/\nasync def verify[\s\S]*$/u, "\n"),
    ]) {
      expect(bundled).not.toBe(hosted);
      expect(sameTaskVerifier(hosted, bundled)).toBe(false);
    }
    expect(sameTaskVerifier("not a verifier", "not a verifier")).toBe(false);
  });
});
