import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPackageWithOptions } from "@electron/asar";
import { expect } from "vitest";
import { z } from "zod";
import { artifactInventorySummaryViewResultSchema } from "../../../src/domain/analysisView/analysisViewResult.js";
import { ARTIFACT_INVENTORY_VIEW_CAVEATS } from "../../../src/domain/analysisView/artifactInventoryViewCaveats.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "discloses unavailable ASAR content hashes in both summary routes and retains the parent",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-asar-summary-");
    const source = join(root, "source");
    await mkdir(join(source, "native"), { recursive: true });
    await writeFile(join(source, "main.js"), "console.log(1);\n");
    const bytes = "inert addon bytes\n";
    await writeFile(join(source, "native", "addon.node"), bytes);
    const archive = join(root, "app.asar");
    await createPackageWithOptions(source, archive, { unpack: "*.node" });
    const companion = join(`${archive}.unpacked`, "native", "addon.node");
    for (const phase of ["missing", "restored"] as const) {
      if (phase === "missing") await rm(companion);
      if (phase === "restored") await writeFile(companion, bytes);
      const bundle = join(root, `${phase}-evidence.json`);
      const direct = await cli.run({
        arguments: [
          "inspect-artifact",
          archive,
          "--detail",
          "summary",
          "--evidence_output",
          bundle,
          "--json",
        ],
      });
      expect(direct.exitCode).toBe(0);
      const delivered = z.object({ summary: z.unknown() }).parse(direct.json);
      const compact = artifactInventorySummaryViewResultSchema.parse(
        parseEvidence(delivered.summary).normalized_result,
      );
      const retained = parseEvidenceBundle(
        JSON.parse(await readFile(bundle, "utf8")),
      );
      const parent = retained.records.find(
        ({ evidence_id }) => evidence_id === compact.parent_evidence_id,
      );
      if (parent === undefined)
        throw new Error("Delivery omitted the complete Evidence parent");
      expect(parent.operation).toBe("inspect_artifact");
      const request = join(root, "request.json");
      await writeFile(
        request,
        JSON.stringify({
          source: { kind: "inline", evidence: parent },
          view: { kind: "summary" },
        }),
      );
      const inline = await cli.run({
        arguments: ["inspect-analysis-view", request, "--json"],
      });
      expect(inline.exitCode).toBe(0);
      const summary = parseEvidence(inline.json).normalized_result;
      const inspection = artifactInspectionResultSchema.parse(
        parent.normalized_result,
      );
      const occurrence = inspection.substeps
        .flatMap((step) => step.evidence.normalized_result.occurrences)
        .find((row) => row.logical_path === "native/addon.node");
      expect(occurrence).toMatchObject({
        hash_status: phase === "missing" ? "unavailable" : "verified",
        ...(phase === "missing" ? { artifact_id: null } : {}),
      });
      expect(summary).toEqual(compact);
      expect(compact.summary.source_complete).toBe(true);
      expect(
        compact.unknowns.includes(
          ARTIFACT_INVENTORY_VIEW_CAVEATS.unknownContentHashes,
        ),
        phase,
      ).toBe(phase === "missing");
    }
  },
);
