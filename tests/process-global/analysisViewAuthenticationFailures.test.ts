import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, onTestFinished, vi } from "vitest";

import { createApplicationMcpHarness } from "../fixtures/applicationMcpHarness.js";
import {
  analysisViewCaptureEvidence,
  environmentManifestCaptureFixture,
} from "../fixtures/analysisView.js";
import { createTestBinarySession } from "../fixtures/binarySession.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const manifestView = {
  kind: "environment-manifest",
  template_rules: ["opaque-token", "sibling-pair-variance"],
} as const;

const authenticationEntries = ["parseEvidence", "immutableEvidence"] as const;

const createOwnedHarness = async () => {
  const harness = await createApplicationMcpHarness({
    session: createTestBinarySession(() => {
      throw new Error("stored Evidence views must not launch a provider");
    }),
  });
  onTestFinished(async () => {
    vi.restoreAllMocks();
    await harness.close();
  });
  return harness;
};

it.each([
  {
    sourceKind: "inline",
    authenticate: "parseEvidence",
    failure: new TypeError("inline parser failed unexpectedly"),
  },
  {
    sourceKind: "evidence-file",
    authenticate: "immutableEvidence",
    failure: new Error("file parser failed unexpectedly"),
  },
] as const)(
  "preserves the unexpected $sourceKind parser failure without retaining a view",
  async ({ sourceKind, authenticate, failure }) => {
    const harness = await createOwnedHarness();
    const parent = analysisViewCaptureEvidence(
      environmentManifestCaptureFixture(),
    );
    expect(harness.session.recordEvidence(parent).ok).toBe(true);
    const before = harness.session.exportEvidenceBundle();

    let source: Record<string, unknown>;
    if (sourceKind === "inline") {
      source = { kind: "inline", evidence: parent };
    } else {
      const root = await createTestTempDirectory("rea-view-auth-failure-");
      const path = join(root, "parent.json");
      await writeFile(path, JSON.stringify(parent));
      source = { kind: "evidence-file", path };
    }

    const evidenceModule = await import("../../src/domain/evidence.js");
    const parse = vi
      .spyOn(evidenceModule, authenticate)
      .mockImplementationOnce(() => {
        throw failure;
      });

    const response = await harness.client.callTool({
      name: "inspect_analysis_view",
      arguments: { source, view: manifestView },
    });

    expect(response).toMatchObject({
      isError: true,
      content: [{ type: "text", text: failure.message }],
    });
    expect(response.structuredContent).toBeUndefined();
    expect(parse).toHaveBeenCalledWith(
      expect.objectContaining({ evidence_id: parent.evidence_id }),
    );
    expect(harness.session.exportEvidenceBundle()).toEqual(before);
  },
);

it("uses retained Evidence without reparsing its parent", async () => {
  const harness = await createOwnedHarness();
  const parent = analysisViewCaptureEvidence(
    environmentManifestCaptureFixture(),
  );
  expect(harness.session.recordEvidence(parent).ok).toBe(true);

  const evidenceModule = await import("../../src/domain/evidence.js");
  for (const name of authenticationEntries) {
    const originalParse = evidenceModule[name];
    vi.spyOn(evidenceModule, name).mockImplementation((input) => {
      if (
        typeof input === "object" &&
        input !== null &&
        "evidence_id" in input &&
        input.evidence_id === parent.evidence_id
      )
        throw new TypeError("retained source parent was reparsed");
      return originalParse(input);
    });
  }

  const response = await harness.client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: manifestView,
    },
  });

  expect(response.isError).not.toBe(true);
  expect(response.structuredContent).toBeDefined();
  expect(harness.session.exportEvidenceBundle().records).toHaveLength(2);
});
