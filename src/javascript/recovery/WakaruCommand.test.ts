import { expect, it } from "vitest";
import { runWakaruCommand } from "./WakaruCommand.js";

it("rejects an exhausted shared execution budget before launching the next command", async () => {
  await expect(
    runWakaruCommand({
      command: "/selected/wakaru",
      limiter: "/usr/bin/prlimit",
      arguments: ["--version"],
      cwd: "/tmp/unused",
      environment: {},
      deadline: Date.now() - 1,
      launcher: async () => {
        throw new Error("An expired budget must not launch");
      },
    }),
  ).rejects.toMatchObject({
    _tag: "AnalysisTimeoutError",
    operation: "recover_javascript_sources",
  });
});

it("preserves caller cancellation before acquiring an expired execution budget", async () => {
  await expect(
    runWakaruCommand({
      command: "/selected/wakaru",
      limiter: "/usr/bin/prlimit",
      arguments: ["--version"],
      cwd: "/tmp/unused",
      environment: {},
      deadline: Date.now() - 1,
      signal: AbortSignal.abort(),
      launcher: async () => {
        throw new Error("A cancelled request must not launch");
      },
    }),
  ).rejects.toMatchObject({ _tag: "AnalysisCancelledError" });
});
