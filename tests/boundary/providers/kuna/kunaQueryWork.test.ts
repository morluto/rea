import { expect, it } from "vitest";

import { KunaQueryWork } from "../../../../src/kuna/KunaQueryWork.js";
import { KunaRunSlots } from "../../../../src/kuna/KunaRunSlots.js";
import { KunaTargetCommands } from "../../../../src/kuna/KunaTargetCommands.js";

it("does not materialize values for a cancelled queued regex query", async () => {
  const lifetime = new AbortController();
  // This test exercises worker admission only; no native command reads this target.
  const commands = new KunaTargetCommands(
    {
      path: "/unused/program",
      sha256: "a".repeat(64),
      kind: "executable",
      format: "elf",
      architecture: "x86_64",
      availableArchitectures: ["x86_64"],
    },
    { signal: lifetime.signal },
  );
  const work = new KunaQueryWork(commands, {
    signal: lifetime.signal,
    own: (promise) => promise,
    runSlots: new KunaRunSlots(1),
  });
  let admitted!: () => void;
  const ready = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const slow = work.match({
    operation: "search_strings",
    pattern: "^(a+)+$",
    caseSensitive: true,
    values: () => {
      admitted();
      return [`${"a".repeat(40)}!`];
    },
  });
  try {
    await ready;
    const cancelled = new AbortController();
    let materialized = false;
    const queued = work.match({
      operation: "search_procedures",
      pattern: "value",
      caseSensitive: true,
      signal: cancelled.signal,
      values: () => {
        materialized = true;
        return ["value"];
      },
    });
    cancelled.abort();
    expect(await queued).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect(materialized).toBe(false);
    lifetime.abort();
    expect(await slow).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
  } finally {
    lifetime.abort();
    await slow;
    expect(await commands.close()).toEqual({ ok: true, value: null });
  }
});
