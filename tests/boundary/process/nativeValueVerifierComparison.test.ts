import { fileURLToPath } from "node:url";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processTest } from "../../support/process/processFixture.js";

const moduleUrl = (path: string) =>
  JSON.stringify(new URL(`../../../${path}`, import.meta.url).href);

processTest.for([
  { coverage: "complete", status: "unchanged" },
  { coverage: "partial", status: "unknown" },
] as const)(
  "compares retained $coverage function Evidence within default MCP limits",
  async ({ coverage, status }, { processes }) => {
    const root = await createTestTempDirectory("rea-verifier-comparison-");
    const source = `
      import assert from "node:assert/strict";
      import { writeFile } from "node:fs/promises";
      import { join } from "node:path";
      import { Client } from "@modelcontextprotocol/client";
      import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
      import { FUNCTION_COMPARISON_EXAMPLE } from ${moduleUrl("dist/contracts/functionComparisonExample.js")};
      import { createEvidence } from ${moduleUrl("dist/domain/evidence.js")};
      import { createEvidenceBundle } from ${moduleUrl("dist/domain/evidenceBundle.js")};
      import { functionDossierSchema } from ${moduleUrl("dist/domain/native/functionDossier.js")};
      import { compareRetainedFunctionEvidence } from ${moduleUrl("scripts/lib/native-value-e2e.mjs")};
      import { requireMcpEvidenceBundle } from ${moduleUrl("scripts/lib/mcp-verifier-results.mjs")};

      // Explicit synthetic facts qualify this adapter boundary, not real Ghidra.
      const dossier = functionDossierSchema.parse(
        structuredClone(FUNCTION_COMPARISON_EXAMPLE.left.normalized_result));
      dossier.assembly = Array.from({ length: 1200 }, (_, i) => "synthetic instruction " + i);
      const evidence = createEvidence({ path: "/synthetic/function.elf",
        sha256: "a".repeat(64), format: "elf", architecture: "x86_64" },
        { id: "synthetic-verifier-facts", name: "Explicit synthetic facts", version: "1" },
        { operation: "analyze_function", parameters: { procedure: "main" }, result: dossier,
          relationshipCoverage: { status: ${JSON.stringify(coverage)},
            ...(${JSON.stringify(coverage)} === "partial"
              ? { limitations: ["Explicit synthetic unresolved relationships."] } : {}) } });
      const bundlePath = join(process.argv[1], "source.json");
      await writeFile(bundlePath, JSON.stringify(createEvidenceBundle([evidence], [])));
      const transport = new StdioClientTransport({ command: process.execPath,
        args: [${JSON.stringify(fileURLToPath(new URL("../../../scripts/rea.mjs", import.meta.url)))}, "mcp"],
        env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent",
          HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper" }, stderr: "pipe" });
      const client = new Client({ name: "synthetic-verifier-comparison", version: "1" });
      try {
        await client.connect(transport);
        const imported = await client.callTool({ name: "import_evidence_bundle",
          arguments: { path: bundlePath } });
        assert.notEqual(imported.isError, true, JSON.stringify(imported));
        const inline = await client.callTool({ name: "compare_functions",
          arguments: { left: evidence, right: evidence } });
        assert.equal(inline.isError, true, JSON.stringify(inline));
        const error = JSON.parse(inline.content.find(item => item.type === "text").text).error;
        assert.equal(error.code, "resource_constraint");
        assert.equal(error.details.reported_limits.max_input_elements, 1024);

        // Execute the same request producer used by both real-provider controls.
        const compared = await compareRetainedFunctionEvidence(client, evidence);
        assert.equal(compared.normalized_result.status, ${JSON.stringify(status)});
        assert.ok(compared.evidence_links.includes(evidence.evidence_id));
        const bundle = requireMcpEvidenceBundle(await client.callTool({
          name: "get_evidence_bundle", arguments: {} }));
        for (const record of [evidence, compared])
          assert.deepEqual(bundle.records.find(item => item.evidence_id === record.evidence_id), record);
        await assert.rejects(() => compareRetainedFunctionEvidence(client,
          { ...evidence, evidence_id: "ev_" + "b".repeat(64) }));
        console.log(JSON.stringify({ status: compared.normalized_result.status,
          exact_source_link: true, complete_records_retained: true, missing_reference_refused: true }));
      } finally {
        await client.close();
        await transport.close();
      }
    `;
    const result = await processes.run(process.execPath, [
      "--input-type=module",
      "--eval",
      source,
      root,
    ]);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      status,
      exact_source_link: true,
      complete_records_retained: true,
      missing_reference_refused: true,
    });
  },
);
