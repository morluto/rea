import { expect, it, vi } from "vitest";
import { AndroidAnalysisService } from "./AndroidAnalysisService.js";
import type { AndroidAnalysisPort } from "./AndroidAnalysisPort.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { createEvidence } from "../../domain/evidence.js";
import { ok } from "../../domain/result.js";
import { summarizeRetainedAndroidSearch } from "./AndroidSearchEvidenceSummary.js";
import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { createAnalysisExecution } from "../AnalysisProvider.js";

it("retains the selected subject in bounded search Evidence", () => {
  const provider = { id: "fixture", name: "Fixture", version: "1" };
  const profile = createAnalysisProfile(provider, { inventory: "classes" });
  const relationshipCoverage = {
    status: "unknown",
    reason: "Class search does not inspect calls",
  } as const;
  const source = createEvidence(
    {
      path: "/fixture/app.apk",
      sha256: "a".repeat(64),
      format: "apk",
      name: "Selected app",
    },
    provider,
    {
      operation: "search_android_classes",
      parameters: {},
      result: { matches: [] },
      rawResult: { complete: true },
      analysisProfile: profile,
      relationshipCoverage,
    },
  );
  const result = summarizeRetainedAndroidSearch(source, { pages: 1 }, () =>
    ok("added"),
  );
  if (!result.ok) throw result.error;
  expect(result.value.subject).toEqual(source.subject);
  expect(result.value.evidence_links).toContain(source.evidence_id);
  expect(result.value.analysis_profile).toEqual(source.analysis_profile);
  expect(result.value.relationship_coverage).toEqual(
    source.relationship_coverage,
  );
  expect(result.value.raw_result).toEqual({
    pages: 1,
    complete_evidence_id: source.evidence_id,
  });
});

it.each(["omitted", "null", "explicit"] as const)(
  "preserves Android producer provenance and %s subject through completion",
  async (subjectKind) => {
    const root = await createTestTempDirectory("rea-android-evidence-");
    const path = join(root, "selected.apk");
    // Empty ZIP: target admission observes the artifact without an Android engine.
    await writeFile(
      path,
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]),
    );
    const provider = { id: "fixture", name: "Fixture", version: "1" };
    const profile = createAnalysisProfile(provider, { inventory: "classes" });
    const relationshipCoverage = {
      status: "unknown",
      reason: "Calls were not inspected",
    } as const;
    const source = createEvidence(undefined, provider, {
      operation: "read_dex",
      parameters: {},
      result: { inventory: true },
    });
    const explicit = {
      path: join(root, "provider.dex"),
      sha256: "b".repeat(64),
      format: "file" as const,
    };
    for (const cancelled of [false, true]) {
      const controller = new AbortController();
      const reason = { requested: "stop after observation" };
      const service = new AndroidAnalysisService({
        inspectAvailability: vi.fn(),
        close: vi.fn(),
        execute: async () => {
          if (cancelled) controller.abort(reason);
          return ok(
            createAnalysisExecution({ classes: ["Example"] }, provider, {
              analysisProfile: profile,
              relationshipCoverage,
              sourceEvidence: [source],
              rawResult: { complete: true },
              ...(subjectKind === "omitted"
                ? {}
                : { subject: subjectKind === "null" ? null : explicit }),
            }),
          );
        },
      });
      const result = await service.execute(
        "search_android_classes",
        { path, query: "Example" },
        { signal: controller.signal },
      );
      expect(result.ok).toBe(!cancelled);
      if (!result.ok) {
        expect(result.error._tag).toBe("AnalysisCancelledError");
        expect(result.error.cause).toBe(reason);
      }
      const evidence = result.ok
        ? result.value
        : result.error.partialObservation;
      expect(evidence).toMatchObject({
        analysis_profile: profile,
        relationship_coverage: relationshipCoverage,
        evidence_links: [source.evidence_id],
        normalized_result: { classes: ["Example"] },
        raw_result: { complete: true },
        parameters: { path, query: "Example" },
      });
      expect(evidence).toMatchObject({
        subject:
          subjectKind === "null"
            ? null
            : { local_path: subjectKind === "omitted" ? path : explicit.path },
      });
    }
  },
);

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
