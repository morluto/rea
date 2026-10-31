import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { AnalysisProviderRegistry } from "../../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../../src/application/binary/BinarySessionComposition.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import { KunaProvider } from "../../../../src/kuna/KunaProvider.js";
import { createServer } from "../../../../src/server/createServer.js";
import { parseMcpToolError } from "../../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../../support/mcp/mcpFixture.js";
import { fakeKunaCalls, writeFakeKuna } from "./fakeKuna.js";
import {
  MACHO_FUNCTIONS,
  MACHO_INVENTORY_ENTRIES,
  machoInventoryImage,
} from "./kunaMachoFixture.js";

const test = mcpTest.skipIf(process.platform === "win32");

test("keeps Mach-O data symbols out of listings, overviews and decompile_all", async ({
  mcp,
}) => {
  const root = await createTestTempDirectory("rea-kuna-macho-mcp-");
  const kuna = await writeFakeKuna(root, {
    functions: MACHO_FUNCTIONS,
    inventoryEntries: MACHO_INVENTORY_ENTRIES,
    inventoryImports: false,
  });
  const target = join(root, "program");
  await writeFile(target, machoInventoryImage());
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
  try {
    const client = await mcp.connect(
      createServer({ kind: "session", session }),
    );
    const call = async (name: string, arguments_: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: arguments_ });
      if (response.isError === true)
        throw new Error(`${name} failed: ${JSON.stringify(response)}`);
      return response.structuredContent;
    };
    const observe = async (name: string, arguments_: Record<string, unknown>) =>
      parseEvidence(await call(name, arguments_));
    await call("open_binary", { path: target });

    const listed = await observe("list_procedures", {});
    expect(listed.normalized_result).toEqual([
      { address: "0x100000400", value: "main" },
      { address: "0x100000440", value: "helper" },
      { address: "0x100000480", value: "puts" },
      { address: "0x100004000", value: "puts" },
      { address: "0x10000c010", value: "linkedit_entry" },
    ]);
    const omitted = listed.limitations.find((limitation) =>
      limitation.startsWith("Kuna's inventory also lists 5 entries"),
    );
    expect(omitted).toBeDefined();

    const refused = await client.callTool({
      name: "procedure_pseudo_code",
      arguments: { procedure: "global_count" },
    });
    expect(refused.isError).toBe(true);
    expect(parseMcpToolError(refused).error).toMatchObject({
      category: "invalid_input",
      message: expect.stringContaining(
        "lies in __DATA,__data, a Mach-O section whose attributes declare no instructions",
      ),
    });

    // Composed workflows count and decompile only the listed entries, and
    // keep the listing's account of what it omitted.
    const overview = await observe("binary_overview", {});
    expect(overview.normalized_result).toMatchObject({ procedure_count: 5 });
    expect(overview.limitations).toContainEqual(
      expect.stringContaining(omitted!),
    );
    const output = join(root, "out");
    const exported = await observe("decompile_all", {
      output_directory: output,
    });
    expect(exported.normalized_result).toMatchObject({
      counts: { selected: 5, written: 2, failed: 3 },
    });
    expect(exported.limitations).toContainEqual(
      expect.stringContaining(omitted!),
    );
    expect((await readdir(join(output, "functions"))).sort()).toEqual([
      "0x100000400.c",
      "0x100000440.c",
    ]);
    // Only the real functions reached Kuna's single-function decompiler.
    expect(
      (await fakeKunaCalls(kuna))
        .filter(({ argv }) => argv[0] === "decompile")
        .map(({ argv }) => argv[2]),
    ).not.toContain("0x100008000");
  } finally {
    await mcp.close();
  }
});
