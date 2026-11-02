import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { AnalysisProviderRegistry } from "../../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../../src/application/binary/BinarySessionComposition.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import { KunaProvider } from "../../../../src/kuna/KunaProvider.js";
import { elfNoteFixture } from "../../../../src/native/elf/ElfNotes.fixture.js";
import { createServer } from "../../../../src/server/createServer.js";
import { parseMcpToolError } from "../../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../../support/mcp/mcpFixture.js";
import { writeFakeKuna, type FakeKunaBehavior } from "./fakeKuna.js";
import {
  MACHO_FUNCTIONS,
  MACHO_INVENTORY_ENTRIES,
  machoInventoryImage,
} from "./kunaMachoFixture.js";

const test = mcpTest.skipIf(process.platform === "win32");

/**
 * Kuna's inventory for the versioned ELF in #8330: two entries share the
 * source-export alias `audit_transform`, each has a generated `sub_` alias,
 * and one repeats its primary name among its aliases.
 */
const VERSIONED = [
  { name: "main", addr: "0x1000" },
  {
    name: "audit_v1",
    addr: "0x1334",
    aliases: ["audit_transform", "sub_1334"],
  },
  {
    name: "audit_v2",
    addr: "0x133a",
    aliases: ["audit_transform", "sub_133a", "audit_v2", "sub_133a"],
  },
];

const aliasSession = async (
  mcp: TestMcp,
  prefix: string,
  behavior: FakeKunaBehavior,
  image: Uint8Array = elfNoteFixture({ bits: 64, type: 2 }),
) => {
  const root = await createTestTempDirectory(prefix);
  const kuna = await writeFakeKuna(root, behavior);
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
  const search = async (arguments_: Record<string, unknown>) =>
    (await observe("search_procedures", arguments_)).normalized_result;
  return { client, call, observe, search };
};

const audit = (
  version: 1 | 2,
  matched_aliases?: readonly string[],
): Record<string, unknown> => ({
  address: version === 1 ? "0x1334" : "0x133a",
  value: `audit_v${String(version)}`,
  ...(matched_aliases === undefined ? {} : { matched_aliases }),
});

test("searches the aliases exact lookup accepts without listing them as procedures", async ({
  mcp,
}) => {
  const { client, call, observe, search } = await aliasSession(
    mcp,
    "rea-kuna-alias-search-",
    { functions: VERSIONED },
  );
  // The listing keeps one row per entry under its primary name.
  expect((await observe("list_procedures", {})).normalized_result).toEqual([
    { address: "0x1000", value: "main" },
    audit(1),
    audit(2),
    { address: "0x2000", value: "puts" },
  ]);

  const shared = [audit(1, ["audit_transform"]), audit(2, ["audit_transform"])];
  expect(await search({ pattern: "audit_transform" })).toEqual(shared);
  expect(
    await search({
      pattern: "^audit_transform$",
      mode: "regex",
      case_sensitive: true,
    }),
  ).toEqual(shared);
  expect(await search({ pattern: "SUB_1334" })).toEqual([
    audit(1, ["sub_1334"]),
  ]);
  expect(await search({ pattern: "SUB_1334", case_sensitive: true })).toEqual(
    [],
  );
  // A primary-name match carries no alias; one also matching an alias keeps
  // the primary value, and an alias repeating the primary name is not listed.
  expect(await search({ pattern: "audit_v1" })).toEqual([audit(1)]);
  expect(await search({ pattern: "audit" })).toEqual(shared);
  expect(await search({ pattern: "^sub_", mode: "regex" })).toEqual([
    audit(1, ["sub_1334"]),
    audit(2, ["sub_133a"]),
  ]);
  expect(await search({ pattern: "absent_alias" })).toEqual([]);

  // Exact lookup and search agree: a unique alias resolves, and a shared one
  // stays ambiguous with both entries.
  expect(
    (await observe("procedure_address", { procedure: "sub_1334" }))
      .normalized_result,
  ).toBe("0x1334");
  const ambiguous = await client.callTool({
    name: "procedure_address",
    arguments: { procedure: "audit_transform" },
  });
  expect(parseMcpToolError(ambiguous).error.message).toContain(
    "0x1334, 0x133a",
  );

  // Retained summary pages carry which name matched.
  const summary = (await call("search_procedures", {
    pattern: "audit_transform",
    detail: "summary",
  })) as {
    normalized_result: {
      parent_evidence_id: string;
      summary: { row_count: number; selectable_fields: string[] };
    };
  };
  expect(summary.normalized_result.summary.row_count).toBe(2);
  expect(summary.normalized_result.summary.selectable_fields).toContain(
    "matched_aliases",
  );
  const page = await observe("inspect_analysis_view", {
    source: {
      kind: "retained-evidence",
      evidence_id: summary.normalized_result.parent_evidence_id,
    },
    view: { kind: "native-inventory", fields: ["matched_aliases"] },
  });
  expect(page.normalized_result).toMatchObject({
    rows: [
      {
        source_index: 0,
        record: { address: "0x1334", matched_aliases: ["audit_transform"] },
      },
      {
        source_index: 1,
        record: { address: "0x133a", matched_aliases: ["audit_transform"] },
      },
    ],
  });
});

test("traces a procedure found only by its alias through the composed feature trace", async ({
  mcp,
}) => {
  const { observe } = await aliasSession(mcp, "rea-kuna-alias-trace-", {
    functions: VERSIONED,
  });
  const traced = await observe("trace_feature", { query: "sub_1334" });
  expect(traced.normalized_result).toMatchObject({
    matches: [{ type: "procedure", ...audit(1, ["sub_1334"]) }],
    references: [
      {
        target_address: "0x1334",
        source_address: "0x1004",
        containing_procedure: { status: "unavailable" },
      },
    ],
  });
  const primary = await observe("trace_feature", { query: "audit_v1" });
  expect(primary.normalized_result).toMatchObject({
    matches: [{ type: "procedure", ...audit(1) }],
  });
});

test("omits a data entry an alias names while keeping the code entry that shares it", async ({
  mcp,
}) => {
  const { search, observe } = await aliasSession(
    mcp,
    "rea-kuna-alias-macho-",
    {
      functions: [
        MACHO_FUNCTIONS[0]!,
        { ...MACHO_FUNCTIONS[1]!, aliases: ["shared_symbol"] },
      ],
      inventoryEntries: MACHO_INVENTORY_ENTRIES.map((entry) =>
        entry.name === "global_count"
          ? { ...entry, aliases: ["shared_symbol"] }
          : entry,
      ),
      inventoryImports: false,
    },
    machoInventoryImage(),
  );
  const searched = await observe("search_procedures", {
    pattern: "shared_symbol",
  });
  expect(searched.normalized_result).toEqual([
    {
      address: "0x100000440",
      value: "helper",
      matched_aliases: ["shared_symbol"],
    },
  ]);
  expect(searched.limitations).toContainEqual(
    expect.stringContaining(
      "Kuna's inventory also lists 1 entry in Mach-O data regions (__DATA,__data: 1)",
    ),
  );
  expect(await search({ pattern: "global_count" })).toEqual([]);
});
