import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { readEvidenceBundle } from "../../../src/application/EvidenceBundleFiles.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { evidenceSchema } from "../../../src/domain/evidence.js";
import { digestCanonicalValue } from "../../../src/domain/canonicalDigest.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { elfDependencyFixture } from "../../../src/native/elf/ElfDependencies.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const dependenciesContract = toolContract("inspect_elf_dependencies");
const viewContract = toolContract("inspect_analysis_view");

cliTest(
  "queries retained ELF dependencies through CLI and actual stdio MCP after the source is deleted",
  { timeout: 60_000 },
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-dep-views-");
    const path = join(root, "program");
    await writeFile(
      path,
      elfDependencyFixture({
        needed: ["libc.so.6", "libc.so.6", "libm.so.6"],
      }),
    );
    const run = cli.sharedCliRun?.bind(cli) ?? cli.run.bind(cli);
    const complete = await run({
      arguments: ["inspect-elf-dependencies", path, "--json"],
    });
    expect(complete.exitCode, complete.stderr).toBe(0);
    const parent = dependenciesContract.outputSchema.parse(complete.json);
    const bundle = join(root, "complete.bundle.json");
    const summarized = await run({
      arguments: [
        "inspect-elf-dependencies",
        path,
        "--detail",
        "summary",
        "--evidence_output",
        bundle,
        "--json",
      ],
    });
    expect(summarized.exitCode, summarized.stderr).toBe(0);
    const delivered = z
      .object({ summary: evidenceSchema })
      .parse(summarized.json).summary;
    expect(delivered.operation).toBe("inspect_analysis_view");
    expect(delivered.normalized_result).toMatchObject({
      parent_evidence_id: parent.evidence_id,
      summary: {
        needed_count: 3,
        import_count: 5,
        coverage: { status: "complete" },
      },
    });
    const loaded = await readEvidenceBundle(bundle);
    if (!loaded.ok) throw loaded.error;
    expect(loaded.value.records).toEqual([parent]);

    const call =
      cli.sharedMcpCall === undefined
        ? (await connectLocalToolsMcp()).call
        : await cli.sharedMcpCall();
    const response = await call("inspect_elf_dependencies", {
      path,
      detail: "summary",
    });
    expect(response.isError).not.toBe(true);
    expect(
      dependenciesContract.outputSchema.parse(response.structuredContent)
        .normalized_result,
    ).toEqual(delivered.normalized_result);
    await rm(path);
    const source = {
      kind: "retained-evidence",
      evidence_id: parent.evidence_id,
    };
    const request = {
      source,
      view: {
        kind: "elf-dependencies",
        collection: "needed",
        names: ["libc.so.6"],
        fields: ["name"],
        offset: 1,
        limit: 1,
      },
    };
    const viewed = await call("inspect_analysis_view", request);
    expect(viewed.isError).not.toBe(true);
    const page = viewContract.outputSchema.parse(viewed.structuredContent);
    expect(page.evidence_links).toContain(parent.evidence_id);
    expect(page.normalized_result).toMatchObject({
      kind: "elf-dependencies",
      items: [{ source_index: 1, name: "libc.so.6" }],
      dependencies: { coverage: { status: "complete" } },
      coverage: { examined: 1, total: 2, next_offset: null, exhausted: true },
    });
    const offline = await run({
      arguments: [
        "inspect-analysis-view",
        JSON.stringify(request),
        "--evidence-bundle",
        bundle,
        "--json",
      ],
    });
    expect(offline.exitCode, offline.stderr).toBe(0);
    expect(viewContract.outputSchema.parse(offline.json)).toEqual(page);
    const projected = await call("inspect_analysis_view", {
      ...request,
      view: {
        ...request.view,
        collection: "imports",
        names: ["printf"],
        fields: ["name", "version"],
        offset: 0,
        limit: 1,
      },
    });
    expect(projected.isError).not.toBe(true);
    const projectedView = analysisViewResultSchema.parse(
      viewContract.outputSchema.parse(projected.structuredContent)
        .normalized_result,
    );
    expect(projectedView).toMatchObject({
      items: [
        {
          source_index: 0,
          name: "printf",
          version: { name: "GLIBC_2.34", file: "libc.so.6" },
        },
      ],
    });
    const { view_digest, ...content } = projectedView;
    expect(view_digest).toBe(digestCanonicalValue(content, "Analysis view"));
  },
);

cliTest(
  "refuses CLI summary without a durable Evidence destination before reading",
  async ({ cli }) => {
    const result = await cli.run({
      arguments: [
        "inspect-elf-dependencies",
        "/rea-nonexistent/program",
        "--detail",
        "summary",
        "--json",
      ],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ path: ["evidence_output"] }] },
    });
  },
);
