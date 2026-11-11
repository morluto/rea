import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { AnalysisProviderRegistry } from "../../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../../src/application/binary/BinarySessionComposition.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import { KunaProvider } from "../../../../src/kuna/KunaProvider.js";
import { elfNoteFixture } from "../../../../src/native/elf/ElfNotes.fixture.js";
import { createServer } from "../../../../src/server/createServer.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../../support/mcp/mcpFixture.js";
import { writeFakeKuna } from "./fakeKuna.js";

const test = mcpTest.skipIf(process.platform === "win32");
const caveat =
  "Parallel Kuna project export does not propagate callee-first prototypes";

for (const jobs of [1, 2]) {
  test(`retains source limitations in batch and paged dossier with ${String(jobs)} worker(s)`, async ({
    mcp,
  }) => {
    const root = await createTestTempDirectory("rea-kuna-parallel-mcp-");
    const kuna = await writeFakeKuna(root, {
      functions: [{ name: "main", addr: "0x1000" }],
    });
    const target = join(root, "program");
    await writeFile(target, elfNoteFixture({ bits: 64, type: 2 }));
    const session = composeBinarySession(
      new AnalysisProviderRegistry(
        [
          new KunaProvider(
            {
              REA_KUNA_COMMAND: kuna,
              REA_KUNA_CACHE_DIR: join(root, "cache"),
              REA_KUNA_JOBS: String(jobs),
            },
            { platform: process.platform },
          ),
        ],
        "kuna",
      ),
    );
    const client = await mcp.connect(
      createServer({ kind: "session", session }),
    );
    const call = async (name: string, arguments_: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: arguments_ });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      return response.structuredContent;
    };
    await call("open_binary", { path: target });
    // Assembly waits for the complete project, avoiding timing-based source selection.
    await call("procedure_assembly", { procedure: "main" });
    const batch = parseEvidence(
      await call("batch_decompile", {
        addresses: ["0x1000"],
        detail: "complete",
      }),
    );
    expect(batch.limitations.some((item) => item.includes(caveat))).toBe(
      jobs > 1,
    );
    const dossier = parseEvidence(
      await call("analyze_function", { procedure: "main", detail: "summary" }),
    );
    const summary = dossier.normalized_result as { parent_evidence_id: string };
    const view = parseEvidence(
      await call("inspect_analysis_view", {
        source: {
          kind: "retained-evidence",
          evidence_id: summary.parent_evidence_id,
        },
        view: { kind: "native", facet: "pseudocode" },
      }),
    );
    expect(view.limitations.some((item) => item.includes(caveat))).toBe(
      jobs > 1,
    );
    await call("close_binary", {});
  });
}
