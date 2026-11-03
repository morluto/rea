import { createHash } from "node:crypto";
import { appendFile, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it as test } from "vitest";
import { AnalysisProviderRegistry } from "../../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../../src/application/binary/BinarySessionComposition.js";
import { decompileDirectoryIndexSchema } from "../../../../src/contracts/decompileDirectory.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import { KunaProvider } from "../../../../src/kuna/KunaProvider.js";
import { elfNoteFixture } from "../../../../src/native/elf/ElfNotes.fixture.js";
import { createApplicationMcpHarness } from "../../../fixtures/applicationMcpHarness.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { setFakeKunaBehavior, writeFakeKuna } from "./fakeKuna.js";
import { FUNCTIONS } from "./kunaSessionFixture.js";

const it = test.skipIf(process.platform === "win32");

it("retains each written function's producer across an export resume", async () => {
  const root = await createTestTempDirectory("rea-kuna-directory-provenance-");
  const kuna = await writeFakeKuna(root, { functions: FUNCTIONS });
  const target = join(root, "program");
  const output = join(root, "output");
  await writeFile(target, elfNoteFixture({ bits: 64, type: 2 }));
  const run = async (cache: string, resume: boolean) => {
    const provider = new KunaProvider(
      { REA_KUNA_COMMAND: kuna, REA_KUNA_CACHE_DIR: join(root, cache) },
      { platform: process.platform },
    );
    const session = composeBinarySession(
      new AnalysisProviderRegistry([provider], "kuna"),
    );
    const harness = await createApplicationMcpHarness({ session });
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const response = await harness.client.callTool({
          name,
          arguments: args,
        });
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        return parseEvidence(response.structuredContent);
      };
      const opened = await harness.client.callTool({
        name: "open_binary",
        arguments: { path: target, provider_id: "kuna" },
      });
      expect(opened.isError).not.toBe(true);
      await call("procedure_assembly", { procedure: "main" });
      const result = await call("decompile_all", {
        output_directory: output,
        resume,
      });
      const resultValue = result.normalized_result as { index_path: string };
      return decompileDirectoryIndexSchema.parse(
        JSON.parse(await readFile(resultValue.index_path, "utf8")),
      );
    } finally {
      await harness.close();
      const closed = await provider.closeOwnedResources();
      if (!closed.ok) throw closed.error;
    }
  };
  const partial = await run("partial", false);
  const first = partial.functions.find((item) => item.address === "0x1000");
  const failed = partial.functions.find((item) => item.address === "0x1080");
  expect(first?.status).toBe("written");
  expect(first?.provider_source).toMatchObject({
    status: "reported",
    source: { kind: "file-range" },
  });
  expect(failed?.status).toBe("failed");
  expect(failed?.provider_source).toMatchObject({
    status: "reported",
    source: { kind: "file-range" },
  });
  if (first?.relative_path === undefined)
    throw new Error("missing initial file");
  const digest = (value: Uint8Array) =>
    createHash("sha256").update(value).digest("hex");
  const before = digest(await readFile(join(output, first.relative_path)));
  // Simulate an interrupted append after the committed failed observation.
  await appendFile(join(output, "decompile-journal.jsonl"), '{"kind":"func');
  await setFakeKunaBehavior(kuna, {
    functions: FUNCTIONS.map(({ name, addr }) => ({ name, addr })),
  });
  const clean = await run("clean", true);
  const kept = clean.functions.find((item) => item.address === "0x1000");
  const recovered = clean.functions.find((item) => item.address === "0x1080");
  expect(kept).toEqual(first);
  expect(digest(await readFile(join(output, first.relative_path)))).toBe(
    before,
  );
  expect(recovered?.status).toBe("written");
  expect(recovered?.provider_source).toMatchObject({
    status: "reported",
    source: { kind: "file-range" },
  });
  if (recovered === undefined) throw new Error("missing recovered function");
  const oldSource = first.provider_source;
  const newSource = recovered.provider_source;
  if (
    oldSource?.status !== "reported" ||
    oldSource.source.kind !== "file-range" ||
    newSource?.status !== "reported" ||
    newSource.source.kind !== "file-range"
  )
    throw new Error("missing source file ranges");
  expect(newSource.source.sha256).not.toBe(oldSource.source.sha256);
  const journal = (
    await readFile(join(output, "decompile-journal.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          address?: string;
          status?: string;
          provider_source?: unknown;
        },
    );
  expect(journal).toContainEqual(
    expect.objectContaining({
      address: "0x1080",
      status: "failed",
      provider_source: failed?.provider_source,
    }),
  );
  // The descriptor is historical: the source cache can disappear while the
  // verified output and its recorded source facts remain unchanged.
  await unlink(oldSource.source.path);
  const afterSourceRemoval = await run("clean", true);
  expect(
    afterSourceRemoval.functions.find((item) => item.address === "0x1000"),
  ).toEqual(first);
  expect(digest(await readFile(join(output, first.relative_path)))).toBe(
    before,
  );
  // A file published before a journal append can be adopted on resume, but
  // matching bytes do not identify the run that originally wrote the file.
  const journalPath = join(output, "decompile-journal.jsonl");
  const header = (await readFile(journalPath, "utf8")).split("\n")[0];
  await writeFile(journalPath, `${header}\n`);
  const adopted = await run("clean", true);
  const adoptedMain = adopted.functions.find(
    (item) => item.address === "0x1000",
  );
  expect(adoptedMain?.provider_source).toEqual({
    status: "unknown",
    reason: "existing_file_origin_unknown",
  });
  expect(digest(await readFile(join(output, first.relative_path)))).toBe(
    before,
  );
});
