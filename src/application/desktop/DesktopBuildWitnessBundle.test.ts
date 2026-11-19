import { expect, it } from "vitest";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { judgeScreenTask } from "./DesktopBuildWitnessBundle.js";

it("preserves earlier judge outcomes when a later check fails cleanup", async () => {
  const failure = new ProviderCleanupError(
    "agentenv",
    ["child"],
    { reason: "cleanup failed" },
    { operation: "check_build_task" },
  );
  const result = await judgeScreenTask(
    {
      callTool: async () => ({
        isError: false,
        content: [{ type: "image", data: "aW1hZ2U=" }],
        structured: null,
      }),
    },
    {
      path: "/bundle",
      judge: async (_verifier, check) => {
        if (check.id === "second") throw failure;
        return { id: check.id, passed: true, description: "first completed" };
      },
    },
    {
      name: "test",
      prompt: "test",
      checks: [
        { kind: "screen_judge", id: "first", question: "First?" },
        { kind: "screen_judge", id: "second", question: "Second?" },
      ],
    },
    new AbortController().signal,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected cleanup failure");
  expect(result.error).toBe(failure);
  expect(projectAnalysisError(result.error)).toMatchObject({
    details: {
      diagnostics: {
        completed_judge_checks: [
          { id: "first", passed: true, description: "first completed" },
        ],
      },
    },
  });
});
