import { withVerifierCleanup } from "../../../../scripts/lib/verifier-cleanup.mjs";
import { batchDecompileResultSchema } from "../../../../src/domain/native/batchDecompile.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";
import { z } from "zod";

import { AnalysisProviderRegistry } from "../../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../../src/application/binary/BinarySessionComposition.js";
import { ENHANCED_TOOL_CONTRACTS } from "../../../../src/contracts/enhancedToolContracts.js";
import { SESSION_TOOL_CONTRACTS } from "../../../../src/contracts/sessionToolContracts.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import { evidenceBundleSchema } from "../../../../src/domain/evidenceBundle.js";
import { KunaProvider } from "../../../../src/kuna/KunaProvider.js";
import { elfNoteFixture } from "../../../../src/native/elf/ElfNotes.fixture.js";
import { createServer } from "../../../../src/server/createServer.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../../support/mcp/mcpFixture.js";
import { writeFakeKuna } from "./fakeKuna.js";
import { FUNCTIONS } from "./kunaSessionFixture.js";

const test = mcpTest.skipIf(process.platform === "win32");

const batchDecompile = ENHANCED_TOOL_CONTRACTS.find(
  (
    contract,
  ): contract is Extract<
    (typeof ENHANCED_TOOL_CONTRACTS)[number],
    { readonly name: "batch_decompile" }
  > => contract.name === "batch_decompile",
);
const getEvidenceBundle = SESSION_TOOL_CONTRACTS.find(
  (
    contract,
  ): contract is Extract<
    (typeof SESSION_TOOL_CONTRACTS)[number],
    { readonly name: "get_evidence_bundle" }
  > => contract.name === "get_evidence_bundle",
);

/** Read the retained batch's items view and check the per-item provider facts. */
const expectRetainedItems = async (
  call: (
    name: string,
    arguments_: Record<string, unknown>,
  ) => Promise<{ structuredContent?: unknown }>,
  evidenceId: string,
  broken: { readonly limitations: readonly string[] },
  puts: { readonly limitations: readonly string[] },
) => {
  const items = z
    .looseObject({ items: z.array(z.looseObject({ address: z.string() })) })
    .parse(
      parseEvidence(
        (
          await call("inspect_analysis_view", {
            source: { kind: "retained-evidence", evidence_id: evidenceId },
            view: { kind: "batch-decompile", collection: "items" },
          })
        ).structuredContent,
      ).normalized_result,
    ).items;
  const row = (address: string) =>
    items.find((item) => item.address === address);
  expect(row("broken")).toMatchObject({
    pseudocode_absence: { kind: "provider-failure" },
    limitations: broken.limitations,
  });
  expect(row("puts")).toMatchObject({
    pseudocode_absence: { kind: "not-in-export" },
    limitations: puts.limitations,
  });
};

test("keeps each Kuna no-pseudocode observation's limitations on its batch item", async ({
  mcp,
}) => {
  const root = await createTestTempDirectory("rea-kuna-batch-mcp-");
  const kuna = await writeFakeKuna(root, { functions: FUNCTIONS });
  const target = join(root, "program");
  await writeFile(target, elfNoteFixture({ bits: 64, type: 2 }));
  const session = composeBinarySession(
    new AnalysisProviderRegistry(
      [
        new KunaProvider(
          { REA_KUNA_COMMAND: kuna, REA_KUNA_CACHE_DIR: join(root, "cache") },
          { platform: process.platform },
        ),
      ],
      "kuna",
    ),
  );
  await withVerifierCleanup(async () => {
    const client = await mcp.connect(
      createServer({ kind: "session", session }),
    );
    const call = async (name: string, arguments_: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: arguments_ });
      if (response.isError === true)
        throw new Error(`${name} failed: ${JSON.stringify(response)}`);
      return response;
    };
    await call("open_binary", { path: target });
    // Waiting for assembly completes the export, so every pseudocode read
    // below comes from its per-function records.
    await call("procedure_assembly", { procedure: "main" });

    const direct = async (procedure: string) =>
      parseEvidence(
        (await call("procedure_pseudo_code", { procedure })).structuredContent,
      );
    const mainDirect = await direct("main");
    const broken = await direct("broken");
    const importSlot = await direct("puts");
    expect(broken.normalized_result).toBeNull();
    expect(broken.raw_result).toMatchObject({
      pseudocode_absence: { kind: "provider-failure" },
    });
    expect(broken.limitations).toContain(
      "Kuna could not decompile this function: Flow exceeded maximum instructions",
    );
    expect(importSlot.normalized_result).toBeNull();
    expect(importSlot.raw_result).toMatchObject({
      pseudocode_absence: { kind: "not-in-export" },
    });

    const batch = parseEvidence(
      (
        await call("batch_decompile", {
          addresses: ["main", "broken", "puts", "0xdead"],
        })
      ).structuredContent,
    );
    // The provider's version policy travels with this observation, while its
    // profile commits only analysis inputs. Composed and retained views must
    // preserve the same warning for agents reading those results.
    const verificationWarning =
      "Kuna 1.833 is not REA's verified 1.990 release";
    expect(batch.limitations).toContainEqual(
      expect.stringContaining(verificationWarning),
    );
    expect(broken.analysis_profile?.parameters).not.toHaveProperty(
      "verified_release",
    );
    const summary = parseEvidence(
      (await call("analyze_function", { procedure: "main", detail: "summary" }))
        .structuredContent,
    );
    const parent = summary.normalized_result as { parent_evidence_id: string };
    const page = parseEvidence(
      (
        await call("inspect_analysis_view", {
          source: {
            kind: "retained-evidence",
            evidence_id: parent.parent_evidence_id,
          },
          view: { kind: "native", facet: "pseudocode" },
        })
      ).structuredContent,
    );
    expect(page.limitations).toContainEqual(
      expect.stringContaining(verificationWarning),
    );
    if (batchDecompile === undefined || getEvidenceBundle === undefined)
      throw new Error(
        "Missing batch_decompile or get_evidence_bundle contract",
      );
    const result = batchDecompileResultSchema.parse(
      batchDecompile.outputSchema.parse(batch).normalized_result,
    );
    expect(result).toMatchObject({ total: 4, succeeded: 1, failed: 3 });
    const [main, failed, imported, unknown] = result.items;
    expect(main).toMatchObject({ address: "main", status: "ok" });
    // A successful item keeps its own observation's caveats too, so a
    // repeated selector answered differently stays distinguishable.
    if (mainDirect.limitations.length === 0)
      expect(main).not.toHaveProperty("limitations");
    else expect(main).toMatchObject({ limitations: mainDirect.limitations });
    const noPseudocode = {
      status: "unavailable",
      reason: "no_pseudocode",
    };
    // The item keeps exactly the facts the provider reported for its own
    // observation, as the single-function Evidence does.
    expect(failed).toMatchObject({
      address: "broken",
      procedure: { status: "resolved", address: "0x1080", name: "broken" },
      ...noPseudocode,
      pseudocode_absence: { kind: "provider-failure" },
      limitations: broken.limitations,
    });
    expect(imported).toMatchObject({
      address: "puts",
      procedure: { status: "resolved", address: "0x2000" },
      ...noPseudocode,
      pseudocode_absence: { kind: "not-in-export" },
      limitations: importSlot.limitations,
    });
    expect(imported).not.toEqual(
      expect.objectContaining({ limitations: broken.limitations }),
    );
    expect(unknown).toMatchObject({
      address: "0xdead",
      procedure: { status: "unknown" },
      status: "error",
      error: { code: "invalid_request" },
    });
    expect(unknown).not.toHaveProperty("limitations");
    // Aggregate caveats remain on the batch Evidence.
    expect(
      batch.limitations.some((limitation) =>
        limitation.endsWith(
          "Kuna could not decompile this function: Flow exceeded maximum instructions",
        ),
      ),
    ).toBe(true);

    // The retained items view projects the same per-item facts.
    await expectRetainedItems(call, batch.evidence_id, broken, importSlot);

    // A batch-only bundle keeps the association without another provider read.
    const bundle = evidenceBundleSchema.parse(
      getEvidenceBundle.outputSchema.parse(
        (await call("get_evidence_bundle", {})).structuredContent,
      ).result,
    );
    const retained = bundle.records.find(
      ({ evidence_id }) => evidence_id === batch.evidence_id,
    );
    expect(retained?.normalized_result).toEqual(batch.normalized_result);
  }, [
    async () => {
      await mcp.close();
    },
    async () => {
      expect(await session.close()).toEqual({ ok: true, value: null });
    },
  ]);
});
