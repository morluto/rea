import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it as test } from "vitest";
import { AnalysisProviderRegistry } from "../../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../../src/application/binary/BinarySessionComposition.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import { KunaProvider } from "../../../../src/kuna/KunaProvider.js";
import { elfNoteFixture } from "../../../../src/native/elf/ElfNotes.fixture.js";
import { createApplicationMcpHarness } from "../../../fixtures/applicationMcpHarness.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { writeFakeKuna } from "./fakeKuna.js";
import { FUNCTIONS } from "./kunaSessionFixture.js";

const it = test.skipIf(process.platform === "win32");

it("explains an unreadable journal without suggesting input-schema changes", async () => {
  const root = await createTestTempDirectory("rea-decompile-journal-recovery-");
  const kuna = await writeFakeKuna(root, { functions: FUNCTIONS });
  const target = join(root, "program");
  const output = join(root, "output");
  await writeFile(target, elfNoteFixture({ bits: 64, type: 2 }));
  const provider = new KunaProvider(
    { REA_KUNA_COMMAND: kuna, REA_KUNA_CACHE_DIR: join(root, "cache") },
    { platform: process.platform },
  );
  const session = composeBinarySession(
    new AnalysisProviderRegistry([provider], "kuna"),
  );
  const harness = await createApplicationMcpHarness({ session });
  try {
    expect(
      (
        await harness.client.callTool({
          name: "open_binary",
          arguments: { path: target, provider_id: "kuna" },
        })
      ).isError,
    ).not.toBe(true);
    const first = await harness.client.callTool({
      name: "decompile_all",
      arguments: { output_directory: output, name: "main" },
    });
    expect(first.isError, JSON.stringify(first)).not.toBe(true);
    const manifest = parseEvidence(first.structuredContent)
      .normalized_result as { index_path: string };
    const index = JSON.parse(await readFile(manifest.index_path, "utf8")) as {
      functions: Array<{ relative_path: string }>;
    };
    const file = join(output, index.functions[0]!.relative_path);
    const journal = join(output, "decompile-journal.jsonl");
    const lines = (await readFile(journal, "utf8")).trimEnd().split("\n");
    const record = JSON.parse(lines[1]!) as Record<string, unknown>;
    record.future_field = { version: 2 };
    lines[1] = JSON.stringify(record);
    await writeFile(journal, `${lines.join("\n")}\n`);
    const hash = async (path: string) =>
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    const paths = [target, file, journal, manifest.index_path];
    const before = await Promise.all(paths.map(hash));
    const refused = await harness.client.callTool({
      name: "decompile_all",
      arguments: { output_directory: output, name: "main", resume: true },
    });
    expect(refused.isError).toBe(true);
    const result = JSON.parse(
      (refused.content[0] as { text: string }).text,
    ) as {
      error: {
        code: string;
        message: string;
        remediation: { action: string };
        recovery?: unknown;
      };
    };
    expect(result.error).toMatchObject({
      code: "invalid_request",
      message: "The decompile journal is not a compatible export.",
      remediation: {
        action:
          "Inspect the journal and use the REA version that created it, or choose a new output directory. The journal may be damaged or from an unsupported version; existing files were left unchanged.",
      },
    });
    expect(result.error.recovery).toBeUndefined();
    expect(await Promise.all(paths.map(hash))).toEqual(before);
  } finally {
    await harness.close();
    const closed = await provider.closeOwnedResources();
    if (!closed.ok) throw closed.error;
  }
});
