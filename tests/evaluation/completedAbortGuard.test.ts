import { expect, it } from "vitest";
import { completedAbortReclassificationCount } from "../../scripts/verify/completed-abort-guard.mjs";

it("counts hand-read abort checks on completed results", () => {
  expect(
    completedAbortReclassificationCount(
      "if (result.ok && options.signal?.aborted) return cancelled();",
    ),
  ).toBe(1);
  expect(
    completedAbortReclassificationCount(
      "if (results[0].ok && signal?.aborted) return cancelled();",
    ),
  ).toBe(1);
  expect(
    completedAbortReclassificationCount(
      "if (waited instanceof AbortedWait || (waited.ok && isAborted(signal))) {}",
    ),
  ).toBe(1);
  expect(
    completedAbortReclassificationCount(
      "return result.ok && deadline.signal.aborted;",
    ),
  ).toBe(1);
  expect(
    completedAbortReclassificationCount(
      "if (!ready && outcome.ok && signal?.aborted) {}",
    ),
  ).toBe(1);
});

it("ignores negated .ok checks that attach cancellation to a failed primary", () => {
  expect(
    completedAbortReclassificationCount(
      "if (!outcome.ok && signal?.aborted) analysisErrorWithCancellation(primary, cancel);",
    ),
  ).toBe(0);
  expect(
    completedAbortReclassificationCount(
      "if (!started.ok && signal?.aborted) return err(analysisErrorWithCancellation(started.error, cancel));",
    ),
  ).toBe(0);
  expect(
    completedAbortReclassificationCount(
      "if (!results[0].ok && signal?.aborted) {}",
    ),
  ).toBe(0);
  expect(
    completedAbortReclassificationCount(
      "if (!this.readResult().outcome.ok && signal?.aborted) {}",
    ),
  ).toBe(0);
  expect(
    completedAbortReclassificationCount(
      "if (! result.ok && isAborted(signal)) {}",
    ),
  ).toBe(0);
  expect(
    completedAbortReclassificationCount(
      "if (!this.#state.outcome.ok && signal?.aborted) {}",
    ),
  ).toBe(0);
  expect(
    completedAbortReclassificationCount(
      "if (!readResult().ok && signal?.aborted) {}",
    ),
  ).toBe(0);
  expect(
    completedAbortReclassificationCount(
      "if (!(await readResult()).ok && signal?.aborted) {}",
    ),
  ).toBe(0);
});
