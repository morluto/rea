import { expect, it as test } from "vitest";

import { functionDossierSchema } from "../../../../src/domain/native/functionDossier.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import {
  ambiguousKunaNameMessage,
  KUNA_XREF_AMBIGUOUS_NAME_REMEDIATION,
  KUNA_XREF_MISSING_NAME_REMEDIATION,
  missingKunaXrefNameMessage,
} from "../../../../src/kuna/KunaSelectorGuidance.js";
import { fakeKunaCalls } from "./fakeKuna.js";
import {
  MACHO_FUNCTIONS,
  MACHO_INVENTORY_ENTRIES,
  machoInventoryImage,
} from "./kunaMachoFixture.js";
import { exportsOf, run, session } from "./kunaSessionFixture.js";

const it = test.skipIf(process.platform === "win32");

const machoSession = (
  prefix: string,
  image: Uint8Array = machoInventoryImage(),
) =>
  session(
    prefix,
    {
      functions: MACHO_FUNCTIONS,
      inventoryEntries: MACHO_INVENTORY_ENTRIES,
      inventoryImports: false,
    },
    {},
    undefined,
    undefined,
    { bytes: image, format: "mach-o", architecture: "arm64" },
  );

const PROCEDURES = [
  { address: "0x100000400", value: "main" },
  { address: "0x100000440", value: "helper" },
  { address: "0x100000480", value: "puts" },
  { address: "0x100004000", value: "puts" },
  { address: "0x10000c010", value: "linkedit_entry" },
];

const OMITTED =
  "Kuna's inventory also lists 5 entries in Mach-O data regions (Mach-O header and load commands: 1; __TEXT,__const: 1; __DATA,__data: 2; __DATA,__bss: 1): the header, or sections whose attributes declare no instructions. REA omits them as data rather than procedure entries; address_name and xrefs still accept their addresses.";
const UNPLACED =
  "1 Kuna inventory entry lies outside every Mach-O section and the header, so REA cannot tell whether it is code or data and keeps it.";

it("keeps code, stubs and import slots but omits Mach-O data symbols from procedures", async () => {
  const { kuna, open } = await machoSession("rea-kuna-macho-inventory-");
  const client = open();
  try {
    const listed = await run(client, "list_procedures");
    expect(listed.result).toEqual(PROCEDURES);
    expect(listed.limitations).toEqual(
      expect.arrayContaining([OMITTED, UNPLACED]),
    );
    expect(listed.rawResult).toBeNull();

    // A search reports only the omissions its own query matched.
    const searched = await run(client, "search_procedures", {
      pattern: "^(global|main)",
      mode: "regex",
    });
    expect(searched.result).toEqual([
      { address: "0x100000400", value: "main" },
    ]);
    expect(searched.limitations).toContain(
      "Kuna's inventory also lists 1 entry in Mach-O data regions (__DATA,__data: 1): the header, or sections whose attributes declare no instructions. REA omits it as data rather than a procedure entry; address_name and xrefs still accept its address.",
    );
    expect(searched.limitations).not.toContain(UNPLACED);
    const unmatched = await run(client, "search_procedures", {
      pattern: "helper",
    });
    expect(
      unmatched.limitations.filter((limitation) =>
        limitation.startsWith("Kuna's inventory also lists"),
      ),
    ).toEqual([]);

    // Procedure operations refuse a data symbol by name or by address,
    // without running Kuna on its bytes.
    for (const procedure of ["global_count", "0x100008000"])
      expect(
        await client.execute("procedure_pseudo_code", { procedure }),
      ).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisInputError",
          userMessage:
            "global_count (0x100008000) lies in __DATA,__data, a Mach-O section whose attributes declare no instructions, so it is data that Kuna lists, not a procedure. address_name and xrefs accept its address.",
        },
      });
    expect(
      await client.execute("procedure_address", {
        procedure: "_mh_execute_header",
      }),
    ).toMatchObject({
      ok: false,
      error: {
        userMessage:
          "_mh_execute_header (0x100000000) lies in the Mach-O header and load commands, so it is data that Kuna lists, not a procedure. address_name and xrefs accept its address.",
      },
    });
    // An exact data address is not handed to the graph as a procedure.
    expect(
      await client.execute("procedure_address", { procedure: "0x100008010" }),
    ).toMatchObject({
      ok: false,
      error: { userMessage: expect.stringContaining("__DATA,__bss") },
    });
    expect(
      await client.execute("procedure_callers", { procedure: "table" }),
    ).toMatchObject({
      ok: false,
      error: { userMessage: expect.stringContaining("__TEXT,__const") },
    });
    expect(
      (await fakeKunaCalls(kuna)).filter(
        ({ argv }) => argv[0] === "decompile" || argv[0] === "decompile-graph",
      ),
    ).toEqual([]);

    // The name stays available for the address it names.
    const named = await run(client, "address_name", { address: "0x100008008" });
    expect(named.result).toBe("message");
    expect(named.limitations).toContain(
      "Kuna lists message in its function inventory, but 0x100008008 lies in __DATA,__data, a Mach-O section whose attributes declare no instructions, so the name labels data.",
    );
    expect(
      (await run(client, "address_name", { address: "0x100000440" })).result,
    ).toBe("helper");

    // Import slots keep their documented ambiguity; real code still resolves.
    expect(
      await client.execute("procedure_address", { procedure: "puts" }),
    ).toMatchObject({
      ok: false,
      error: {
        userMessage:
          "puts names 2 Kuna entries (0x100000480, 0x100004000); select one by address.",
      },
    });
    expect(
      (await run(client, "procedure_address", { procedure: "helper" })).result,
    ).toBe("0x100000440");
    expect(
      (await run(client, "procedure_pseudo_code", { procedure: "main" }))
        .result,
    ).toEqual(expect.stringContaining("int main(void)"));
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it("resolves a data symbol's name for xrefs, which accept data addresses", async () => {
  const { kuna, open } = await machoSession("rea-kuna-macho-xrefs-");
  const client = open();
  try {
    const references = await run(client, "xrefs", { address: "global_count" });
    expect(references.locations).toContainEqual({
      kind: "address",
      address: "0x100008000",
    });
    expect(
      (await fakeKunaCalls(kuna)).find(({ argv }) => argv[0] === "xrefs")?.argv,
    ).toContain("0x100008000");
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it("guides valid ambiguous and missing procedure selectors without schema repair", async () => {
  const { open } = await machoSession("rea-kuna-procedure-recovery-");
  const client = open();
  try {
    for (const [procedure, expected] of [
      ["puts", "address"],
      ["missing_procedure", "search_procedures"],
      ["0x00000001", "list_procedures"],
    ] as const) {
      const result = await client.execute("procedure_address", { procedure });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected unresolved procedure");
      const projected = projectAnalysisError(result.error);
      expect(projected.recovery).toBeUndefined();
      expect(projected.remediation.action).toContain(expected);
      expect(projected.details?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ observed: { procedure } }),
        ]),
      );
      if (procedure === "puts") {
        expect(projected.message).toContain("0x100000480");
        expect(projected.message).toContain("0x100004000");
      }
    }
    expect(
      (await run(client, "procedure_address", { procedure: "helper" })).result,
    ).toBe("0x100000440");
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it("reports missing and ambiguous xref names within Kuna's inventory", async () => {
  const { open } = await machoSession("rea-kuna-macho-xref-recovery-");
  const client = open();
  try {
    const missing = await client.execute("xrefs", { address: "missing_data" });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("Expected missing inventory name");
    expect(projectAnalysisError(missing.error)).toMatchObject({
      code: "invalid_request",
      message: missingKunaXrefNameMessage("missing_data"),
      remediation: { action: KUNA_XREF_MISSING_NAME_REMEDIATION },
    });
    expect(projectAnalysisError(missing.error).recovery).toBeUndefined();
    expect(projectAnalysisError(missing.error).message).toContain(
      "missing_data",
    );

    const ambiguous = await client.execute("xrefs", { address: "puts" });
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) throw new Error("Expected ambiguous inventory name");
    expect(projectAnalysisError(ambiguous.error)).toMatchObject({
      code: "invalid_request",
      message: ambiguousKunaNameMessage("puts", ["0x100000480", "0x100004000"]),
      remediation: { action: KUNA_XREF_AMBIGUOUS_NAME_REMEDIATION },
    });
    expect(projectAnalysisError(ambiguous.error).message).toContain(
      "0x100000480",
    );
    expect(projectAnalysisError(ambiguous.error).message).toContain(
      "0x100004000",
    );
    expect(projectAnalysisError(ambiguous.error).recovery).toBeUndefined();
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it("classifies the published export's inventory with the section table it read", async () => {
  const { kuna, open } = await machoSession("rea-kuna-macho-warm-");
  const cold = open();
  try {
    await run(cold, "procedure_assembly", { procedure: "main" });
  } finally {
    expect(await cold.close()).toEqual({ ok: true, value: null });
  }
  expect(await exportsOf(kuna)).toHaveLength(1);
  const warm = open();
  try {
    expect((await run(warm, "list_procedures")).result).toEqual(PROCEDURES);
    expect(await exportsOf(kuna)).toHaveLength(1);
  } finally {
    expect(await warm.close()).toEqual({ ok: true, value: null });
  }
});

it("keeps every entry with an explicit limitation when the section table is unreadable", async () => {
  const image = machoInventoryImage();
  // Declare one more load command than the table holds.
  image.writeUInt32LE(image.readUInt32LE(16) + 1, 16);
  const { open } = await machoSession("rea-kuna-macho-unreadable-", image);
  const client = open();
  try {
    const listed = await run(client, "list_procedures");
    expect(listed.result).toHaveLength(
      MACHO_FUNCTIONS.length + MACHO_INVENTORY_ENTRIES.length,
    );
    const unreadable = listed.limitations.find((limitation) =>
      /^REA could not read the target's Mach-O section table \(.+\), so Kuna's inventory is kept unclassified and may include data symbols\.$/u.test(
        limitation,
      ),
    );
    expect(unreadable).toBeDefined();
    const named = await run(client, "address_name", { address: "0x100008000" });
    expect(named.result).toBe("global_count");
    // Direct answers keep the same caveat, including the dossier's own list.
    const dossier = await run(client, "analyze_function", {
      procedure: "main",
    });
    for (const limitations of [
      named.limitations,
      dossier.limitations,
      functionDossierSchema.parse(dossier.result).limitations,
    ])
      expect(limitations).toContain(unreadable);
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it("keeps an ELF inventory exactly as Kuna reports it", async () => {
  const { open } = await session("rea-kuna-elf-inventory-", {
    inventoryEntries: [{ name: "false_func", addr: "0x34a0", size: 0 }],
  });
  const client = open();
  try {
    const listed = await run(client, "list_procedures");
    expect(listed.result).toContainEqual({
      address: "0x34a0",
      value: "false_func",
    });
    expect(
      listed.limitations.some((limitation) => limitation.includes("Mach-O")),
    ).toBe(false);
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});
