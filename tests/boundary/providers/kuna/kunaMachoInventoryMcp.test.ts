import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { AnalysisProviderRegistry } from "../../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../../src/application/binary/BinarySessionComposition.js";
import {
  DECOMPILE_DIRECTORY_INDEX_NAME,
  decompileDirectoryIndexSchema,
} from "../../../../src/contracts/decompileDirectory.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import { KunaProvider } from "../../../../src/kuna/KunaProvider.js";
import { createServer } from "../../../../src/server/createServer.js";
import { parseMcpToolError } from "../../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../../support/mcp/mcpFixture.js";
import { fakeKunaCalls, writeFakeKuna } from "./fakeKuna.js";
import {
  MACHO_FUNCTIONS,
  MACHO_INVENTORY_ENTRIES,
  machoInventoryImage,
} from "./kunaMachoFixture.js";

const test = mcpTest.skipIf(process.platform === "win32");

const UNPLACED =
  "1 Kuna inventory entry lies outside every Mach-O section and the header, so REA cannot tell whether it is code or data and keeps it.";
const UNREADABLE =
  "REA could not read the target's Mach-O section table (sections __TEXT,__text and __TEXT,__stubs overlap), so Kuna's inventory is kept unclassified and may include data symbols.";

const classificationCaveats = (limitations: readonly string[]) =>
  limitations.filter((limitation) => limitation.includes("Mach-O"));

/** An MCP session on a Kuna-backed synthetic Mach-O. */
const machoSession = async (
  mcp: TestMcp,
  prefix: string,
  image: Uint8Array = machoInventoryImage(),
) => {
  const root = await createTestTempDirectory(prefix);
  const kuna = await writeFakeKuna(root, {
    functions: MACHO_FUNCTIONS,
    inventoryEntries: MACHO_INVENTORY_ENTRIES,
    inventoryImports: false,
  });
  const target = join(root, "program");
  await writeFile(target, image);
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
  const client = await mcp.connect(createServer({ kind: "session", session }));
  const call = async (name: string, arguments_: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: arguments_ });
    if (response.isError === true)
      throw new Error(`${name} failed: ${JSON.stringify(response)}`);
    return response.structuredContent;
  };
  const observe = async (name: string, arguments_: Record<string, unknown>) =>
    parseEvidence(await call(name, arguments_));
  await call("open_binary", { path: target });
  return { root, kuna, client, observe };
};

test("keeps Mach-O data symbols out of listings, overviews and decompile_all", async ({
  mcp,
}) => {
  const { root, kuna, client, observe } = await machoSession(
    mcp,
    "rea-kuna-macho-mcp-",
  );
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
  // Each function's record keeps the caveats of the reads it used.
  const index = decompileDirectoryIndexSchema.parse(
    JSON.parse(
      await readFile(join(output, DECOMPILE_DIRECTORY_INDEX_NAME), "utf8"),
    ),
  );
  const records = new Map(
    index.functions.map((record) => [record.address, record]),
  );
  expect(records.get("0x10000c010")?.limitations).toContain(UNPLACED);
  expect(
    classificationCaveats(records.get("0x100000440")?.limitations ?? []),
  ).toEqual([]);
});

test("keeps an unplaced entry's classification caveat on direct answers", async ({
  mcp,
}) => {
  const { observe } = await machoSession(mcp, "rea-kuna-macho-unplaced-mcp-");
  // Waiting for assembly completes the export, so later text reads use it.
  const assembly = await observe("procedure_assembly", { procedure: "main" });
  expect(classificationCaveats(assembly.limitations)).toEqual([]);
  const code = await observe("procedure_pseudo_code", { procedure: "main" });
  expect(classificationCaveats(code.limitations)).toEqual([]);
  const helper = await observe("procedure_address", { procedure: "helper" });
  expect(classificationCaveats(helper.limitations)).toEqual([]);

  const unplaced = await observe("procedure_pseudo_code", {
    procedure: "linkedit_entry",
  });
  expect(unplaced.normalized_result).toBeNull();
  expect(classificationCaveats(unplaced.limitations)).toEqual([UNPLACED]);
  const located = await observe("procedure_address", {
    procedure: "0x10000c010",
  });
  expect(located.normalized_result).toBe("0x10000c010");
  expect(classificationCaveats(located.limitations)).toEqual([UNPLACED]);
});

test("keeps an unreadable section table's caveat on direct answers", async ({
  mcp,
}) => {
  // Admission accepts the image, but its section table claims __text runs
  // into __stubs, so REA cannot say which content an address holds.
  const image = machoInventoryImage();
  const text = image.indexOf("__text\0", 0, "latin1");
  image.writeBigUInt64LE(0x90n, text + 40);
  const { observe } = await machoSession(
    mcp,
    "rea-kuna-macho-unreadable-mcp-",
    image,
  );
  for (const [operation, procedure] of [
    ["procedure_pseudo_code", "main"],
    ["procedure_assembly", "main"],
    ["procedure_address", "helper"],
    ["procedure_callers", "main"],
  ] as const) {
    const answer = await observe(operation, { procedure });
    expect(classificationCaveats(answer.limitations), operation).toEqual([
      UNREADABLE,
    ]);
  }
});
