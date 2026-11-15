import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { createBrowserScenarioEvidence } from "../../../src/application/BrowserScenarioEvidence.js";
import { browserScenarioCaptureSchema } from "../../../src/domain/browserScenarioCapture.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { webVerificationScenario } from "../../../src/domain/reconstructionWebVerification.fixture.js";
import { readWebScenarioSource } from "../../../src/domain/webComparisonSources.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const recipe = fileURLToPath(
  new URL(
    "../../../scripts/examples/web-reconstruction-recipe.mjs",
    import.meta.url,
  ),
);
const browser = process.env.REA_BROWSER_EXECUTABLE;

it("derives the example brief from one attributable observed report and refuses missing observations", async () => {
  // Modeled producer-boundary facts; the opt-in test below exercises a real browser.
  const { scenario, capture } = structuredClone(
    readWebScenarioSource(webVerificationScenario()),
  );
  scenario.actions = [
    {
      step_id: "save",
      action: "click",
      locator: { kind: "role", role: "button", name: "Save" },
      button: "left",
      click_count: 1,
    },
  ];
  const step = capture.steps[1]!;
  step.step_id = "save";
  step.action = "click";
  step.event_sequence_end = 1;
  capture.events = {
    ...capture.events,
    retained: 1,
    dropped: 0,
    items: [
      {
        kind: "console",
        level: "info",
        text: "saved-count=7",
        url: null,
        sequence: 1,
        step_index: 1,
      },
    ],
  };
  const observed = createBrowserScenarioEvidence(
    scenario,
    {
      source: jsonValueSchema.parse(capture),
      facts: browserScenarioCaptureSchema.parse(capture),
    },
    {
      id: "recipe-fixture",
      name: "Modeled recipe reference",
      version: "1",
    },
  );
  const { webReconstructionBrief, webCandidateFromBrief } = await import(
    pathToFileURL(recipe).href
  );
  const brief = webReconstructionBrief(observed);
  expect(brief.original.evidence_id).toBe(observed.evidence_id);
  expect(brief.observed).toMatchObject({ saved_count: "7", event_sequence: 1 });
  expect(brief.unknowns).toEqual([
    "Storage was not observed and must remain unknown.",
  ]);
  expect(webCandidateFromBrief(brief)).not.toContain(brief.original.origin);
  expect(webCandidateFromBrief(brief)).not.toBe(
    webCandidateFromBrief(brief, true),
  );
  capture.events = { ...capture.events, retained: 0, dropped: 0, items: [] };
  step.event_sequence_end = 0;
  const missing = createBrowserScenarioEvidence(
    scenario,
    {
      source: jsonValueSchema.parse(capture),
      facts: browserScenarioCaptureSchema.parse(capture),
    },
    observed.provider,
  );
  expect(() => webReconstructionBrief(missing)).toThrow(
    /unambiguous observed/u,
  );
});

it("refuses an existing output directory before starting a browser or replacing caller files", async () => {
  const output = await createTestTempDirectory("rea-web-recipe-existing-");
  const sentinel = join(output, "sentinel.txt");
  await writeFile(sentinel, "keep");
  await expect(
    execute(process.execPath, [recipe, process.execPath, output], {
      windowsHide: true,
    }),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("EEXIST"),
  });
  expect(await readFile(sentinel, "utf8")).toBe("keep");
});

it.skipIf(browser === undefined)(
  "runs the complete public web recipe with a real browser (set REA_BROWSER_EXECUTABLE)",
  async () => {
    const root = await createTestTempDirectory("rea-web-recipe-live-");
    const output = join(root, "investigation");
    const result = await execute(process.execPath, [recipe, browser!, output], {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      before: "fail",
      after: "unknown",
      required_claims_passed: true,
    });
    const handoff = JSON.parse(
      await readFile(join(output, "handoff.json"), "utf8"),
    );
    expect(
      handoff.before.map((claim: { status: string }) => claim.status),
    ).toEqual(["pass", "fail", "unknown"]);
    expect(
      handoff.after.map((claim: { status: string }) => claim.status),
    ).toEqual(["pass", "pass", "unknown"]);
    const bundle = parseEvidenceBundle(
      JSON.parse(await readFile(join(output, "evidence-bundle.json"), "utf8")),
    );
    expect(bundle.records).toHaveLength(7);
    const before = await readFile(join(output, "candidate-before.html"));
    const after = await readFile(join(output, "candidate.html"));
    expect(before.equals(after)).toBe(false);
    for (const artifact of handoff.implementation_artifacts) {
      expect(
        createHash("sha256")
          .update(await readFile(artifact.path))
          .digest("hex"),
      ).toBe(artifact.sha256);
    }
    expect(await readFile(join(output, "recipe-prompt.md"), "utf8")).toContain(
      "Build independently",
    );
  },
  90_000,
);
