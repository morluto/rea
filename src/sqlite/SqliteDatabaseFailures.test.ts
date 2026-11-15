import { setTimeout as delay } from "node:timers/promises";

import { expect, it } from "vitest";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import { sqliteDatabaseDialect } from "./SqliteDatabaseFailures.js";

/** The abort error Node's signal-aware I/O rejects with for `signal`. */
const nodeAbortError = (signal: AbortSignal): Promise<unknown> =>
  delay(1, undefined, { signal }).then(
    () => {
      throw new Error("Expected the aborted delay to reject");
    },
    (cause: unknown) => cause,
  );

it.each([
  ["an object", { source: "caller" }],
  ["NaN", Number.NaN],
])(
  "reports the caller's own abort with its reason when the reason is %s",
  async (_label, reason) => {
    const caller = new AbortController();
    caller.abort(reason);
    const failure = classifyProviderFailure(
      await nodeAbortError(caller.signal),
      sqliteDatabaseDialect("/selected.db", "artifact-read", caller.signal),
    );

    expect(failure).toBeInstanceOf(AnalysisCancelledError);
    expect(Object.is(failure.cause, reason)).toBe(true);
  },
);

it("keeps another signal's abort error as the cancellation's cause", async () => {
  const caller = new AbortController();
  caller.abort({ source: "caller" });
  const other = new AbortController();
  other.abort({ source: "another owner" });
  const foreign = await nodeAbortError(other.signal);

  const failure = classifyProviderFailure(
    foreign,
    sqliteDatabaseDialect("/selected.db", "artifact-read", caller.signal),
  );

  expect(failure).toBeInstanceOf(AnalysisCancelledError);
  expect(failure.cause).toBe(foreign);
});
