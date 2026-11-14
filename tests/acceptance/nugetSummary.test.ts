import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect } from "vitest";
import { readEvidenceBundle } from "../../src/application/EvidenceBundleFiles.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { analysisViewResultSchema } from "../../src/domain/analysisView/analysisViewResult.js";
import { nugetPackageSchema } from "../../src/domain/nugetPackage/nugetPackage.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "publishes NuGet declaration counts without dropping the partial parent inventory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-nuget-summary-");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add(
      "Example.nuspec",
      new TextReader(
        "<package><metadata><id>Example</id><version>1.0</version></metadata></package>",
      ),
    );
    await writer.add(
      "lib/net8.0/Example.dll",
      new TextReader("unexamined member"),
    );
    await writeFile(join(root, "input.nupkg"), await writer.close());
    const output = join(root, "evidence.json");
    const result = await cli.run({
      arguments: [
        "inspect-nuget-package",
        "./input.nupkg",
        "--maxEntries",
        "1",
        "--detail",
        "summary",
        "--evidence_output",
        output,
        "--json",
      ],
      cwd: root,
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const summaryEvidence = parseEvidence(
      (result.json as { summary: unknown }).summary,
    );
    const summary = analysisViewResultSchema.parse(
      summaryEvidence.normalized_result,
    );
    const saved = await readEvidenceBundle(output);
    if (!saved.ok) throw saved.error;
    const parent = saved.value.records.find(
      (record) => record.operation === "inspect_nuget_package",
    );
    if (parent === undefined)
      throw new Error("Missing complete parent Evidence");
    const report = nugetPackageSchema.parse(parent.normalized_result);
    expect(parent.caller_input_path).toBe("./input.nupkg");
    expect(report.assets).toHaveLength(1);
    expect(report.source_coverage.status).toBe("partial");
    expect(
      report.diagnostics.some((entry) => entry.code === "entry-limit-reached"),
    ).toBe(true);
    expect(summary).toMatchObject({
      kind: "summary",
      parent_evidence_id: parent.evidence_id,
      parent_digest: parent.evidence_id.slice(3),
      summary: {
        asset_count: 1,
        nuspec_count: 1,
        source_coverage: report.source_coverage,
      },
    });
    if (summary.kind === "summary")
      expect(summary.summary).not.toHaveProperty("assets");
  },
);
