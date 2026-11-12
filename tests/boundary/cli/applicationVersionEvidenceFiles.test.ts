import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE as pair } from "../../../src/contracts/javascript/javascriptApplicationWorkflowExamples.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "compares saved application Evidence files named relative to the working directory",
  { timeout: 60_000 },
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-application-version-cli-");
    await writeFile(join(root, "left.json"), JSON.stringify(pair.left));
    await writeFile(
      join(root, "bundle.json"),
      JSON.stringify(createEvidenceBundle([pair.left, pair.right])),
    );
    const compare = async (input: Record<string, unknown>) => {
      const request = join(root, "request.json");
      await writeFile(request, JSON.stringify(input));
      return cli.run({
        arguments: ["compare-application-versions", request, "--json"],
        cwd: root,
      });
    };
    const inline = await compare({ left: pair.left, right: pair.right });
    expect(inline.exitCode, inline.stderr).toBe(0);
    const files = await compare({
      left: { kind: "evidence-file", path: "left.json" },
      right: {
        kind: "evidence-file",
        path: "bundle.json",
        evidence_id: pair.right.evidence_id,
      },
    });
    expect(files.exitCode, files.stderr).toBe(0);
    const compared = parseEvidence(files.json);
    expect(compared.evidence_id).toBe(parseEvidence(inline.json).evidence_id);
    expect(compared.parameters).toMatchObject({
      left_evidence_id: pair.left.evidence_id,
      right_evidence_id: pair.right.evidence_id,
    });

    const mismatched = await compare({
      left: {
        kind: "evidence-file",
        path: "left.json",
        evidence_id: pair.right.evidence_id,
      },
      right: pair.right,
    });
    expect(mismatched.exitCode).toBe(1);
    expect(mismatched.json).toMatchObject({
      details: { operation: "compare_application_versions" },
    });
  },
);
