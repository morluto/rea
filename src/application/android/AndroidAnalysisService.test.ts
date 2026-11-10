import { expect, it, vi } from "vitest";
import { AndroidAnalysisService } from "./AndroidAnalysisService.js";
import type { AndroidAnalysisPort } from "./AndroidAnalysisPort.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { createEvidence } from "../../domain/evidence.js";
import { ok } from "../../domain/result.js";
import { summarizeRetainedAndroidSearch } from "./AndroidSearchEvidenceSummary.js";

it("retains the selected subject in bounded search Evidence", () => {
  const source = createEvidence(
    {
      path: "/fixture/app.apk",
      sha256: "a".repeat(64),
      format: "apk",
      name: "Selected app",
    },
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "search_android_classes",
      parameters: {},
      result: { matches: [] },
      rawResult: { complete: true },
    },
  );
  const result = summarizeRetainedAndroidSearch(source, { pages: 1 }, () =>
    ok("added"),
  );
  if (!result.ok) throw result.error;
  expect(result.value.subject).toEqual(source.subject);
  expect(result.value.evidence_links).toContain(source.evidence_id);
});

it("retains selector correction issues before target acquisition", async () => {
  const execute = vi.fn<AndroidAnalysisPort["execute"]>();
  const provider: AndroidAnalysisPort = {
    execute,
    inspectAvailability: vi.fn(),
    close: vi.fn(),
  };
  const result = await new AndroidAnalysisService(provider).execute(
    "inspect_android_class",
    {
      path: "/nonexistent.apk",
      class_name: "",
    },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "invalid_request",
    details: {
      issues: [{ path: ["class_name"], reason: "out_of_range", minimum: 1 }],
    },
  });
  expect(execute).not.toHaveBeenCalled();
});
