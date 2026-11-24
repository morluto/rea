import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { ARTIFACT_COMPARISON_EXAMPLE } from "../../../src/contracts/artifactComparisonExample.js";
import { createArtifactInspection } from "../../../src/domain/artifactInspection.js";
import {
  createEvidence,
  evidenceSubjectTarget,
  type Evidence,
} from "../../../src/domain/evidence.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const INTEGRATION_TEST_TIMEOUT_MS = 60_000;

/** One complete inspect_artifact Evidence document, in the shape the CLI reads. */
const memberDocument = (
  inventoryEvidence: typeof ARTIFACT_COMPARISON_EXAMPLE.left,
): Evidence => {
  const subject = inventoryEvidence.subject;
  if (subject === null) throw new Error("Artifact fixture has no target");
  return createEvidence(
    evidenceSubjectTarget(subject)!,
    inventoryEvidence.provider,
    {
      operation: "inspect_artifact",
      parameters: {},
      result: createArtifactInspection(inventoryEvidence),
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );
};

describe("cluster-artifacts Evidence file inputs", () => {
  cliTest(
    "returns the caller's path-to-Evidence roster beside the clustering",
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-cluster-artifacts-cli-");
      const leftPath = join(root, "left.json");
      const rightPath = join(root, "right.json");
      const left = memberDocument(ARTIFACT_COMPARISON_EXAMPLE.left);
      const right = memberDocument(ARTIFACT_COMPARISON_EXAMPLE.right);
      await writeFile(leftPath, JSON.stringify(left));
      await writeFile(rightPath, JSON.stringify(right));

      const run = await cli.run({
        arguments: [
          "cluster-artifacts",
          "--member",
          leftPath,
          "--member",
          rightPath,
          "--json",
        ],
        environment: process.env,
      });

      expect(run.exitCode, run.stderr).toBe(0);
      const clustered = run.json as {
        readonly summary: { readonly members_examined: number };
        readonly coverage: { readonly members_examined: number };
        readonly members: readonly {
          readonly label: string;
          readonly evidence_id: string;
        }[];
      };

      expect(clustered.summary.members_examined).toBe(2);
      expect(clustered.coverage.members_examined).toBe(2);
      // The CLI has no session ledger to retain the roster in, so the caller's
      // own path-to-Evidence mapping travels in the result itself; it is the
      // only place that mapping survives when the result carries no index rows.
      expect(clustered.members).toEqual([
        { label: leftPath, evidence_id: left.evidence_id },
        { label: rightPath, evidence_id: right.evidence_id },
      ]);
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});
