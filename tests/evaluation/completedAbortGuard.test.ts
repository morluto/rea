import { expect, it } from "vitest";
import { completedAbortReclassificationCount } from "../../scripts/verify/completed-abort-guard.mjs";

it.each([
  "if (result.ok && isAborted(state.signal))",
  "return result.ok && deadline.signal.aborted",
  "(waited.ok && isAborted(signal))",
  "if (result.ok && options?.signal?.aborted)",
  "outcome?.ok && signal.aborted",
  "this.#pending.result.ok && signal.aborted",
  "results[0].ok && signal.aborted",
  "results[index]?.ok && isAborted(signal)",
  "getResult().ok && isAborted(signal)",
  "this.readResult().outcome.ok && options.signal?.aborted",
  "(await settle()).ok && signal.aborted",
  "result!.ok && signal.aborted",
  "getResult()!.ok && isAborted(signal)",
  "results[0]!.outcome!.ok && options.signal?.aborted",
])("counts the completed-result check %s", (source) => {
  expect(completedAbortReclassificationCount(source)).toBe(1);
});

it.each([
  "if (!outcome.ok && signal?.aborted)",
  "if (! started.ok && signal?.aborted)",
  "!this.#pending.result.ok && signal.aborted",
  "!results[0].ok && signal.aborted",
  "!this.readResult().outcome.ok && isAborted(signal)",
  "!(await settle()).ok && signal.aborted",
  "!result!.ok && signal.aborted",
  "!getResult()!.ok && isAborted(signal)",
  "if (result.ok) return isAborted(signal);",
  "if (result.ok && signal === undefined)",
])("ignores %s", (source) => {
  expect(completedAbortReclassificationCount(source)).toBe(0);
});

it("counts each check once", () => {
  expect(
    completedAbortReclassificationCount(
      "if (first.ok && isAborted(signal)) a();\nif (second.ok && signal.aborted) b();",
    ),
  ).toBe(2);
});
