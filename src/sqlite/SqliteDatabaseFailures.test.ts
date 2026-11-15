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

it.each([
  ["another signal's abort error", "aborted", "other-signal"],
  ["a reasonless AbortError", "aborted", "reasonless"],
  ["an abort error without a caller abort", "live", "other-signal"],
] as const)(
  "classifies %s as itself, not as cancellation (caller %s)",
  async (_label, state, thrown) => {
    const caller = new AbortController();
    if (state === "aborted") caller.abort({ source: "caller" });
    const other = new AbortController();
    other.abort({ source: "another owner" });
    const foreign =
      thrown === "reasonless"
        ? new DOMException("Aborted elsewhere", "AbortError")
        : await nodeAbortError(other.signal);

    const failure = classifyProviderFailure(
      foreign,
      sqliteDatabaseDialect("/selected.db", "artifact-read", caller.signal),
    );

    expect(failure).not.toBeInstanceOf(AnalysisCancelledError);
    expect(failure).toMatchObject({ _tag: "ProviderAdapterError" });
    expect(failure.cause).toBe(foreign);
  },
);
