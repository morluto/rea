import { createHash } from "node:crypto";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  inspectPriResourcesInputSchema,
  priResourcesSchema,
  type PriCandidateRow,
  type PriResources,
} from "../../domain/native/priResources.js";
import { SectionContent } from "./PriLayout.js";
import { parsePriResources } from "./PriResourceParser.js";
import {
  priFixture,
  type FixtureResource,
  type PriFixture,
  type PriFixtureOptions,
} from "./PriResources.fixture.js";
import { readDecisionInfo } from "./PriSections.js";
import { TextBudget } from "./PriText.js";

const PATH = "/fixtures/resources.pri";
const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

const inspect = async (
  bytes: Buffer,
  selection: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<PriResources> =>
  priResourcesSchema.parse(
    await parsePriResources(
      bytes,
      { path: PATH, bytes: bytes.length, sha256: sha256(bytes) },
      inspectPriResourcesInputSchema.parse({ path: PATH, ...selection }),
      signal,
    ),
  );

const candidates = async (
  bytes: Buffer,
  selection: Record<string, unknown> = {},
): Promise<PriCandidateRow[]> => {
  const { page } = await inspect(bytes, {
    collection: "candidates",
    ...selection,
  });
  if (page.collection !== "candidates") throw new Error(page.collection);
  return page.candidates;
};

const texts = (rows: readonly PriCandidateRow[]) =>
  rows.map(({ name, value }) => [
    name,
    value?.kind === "text" ? value.text : value?.kind,
  ]);

const layouts: readonly [string, PriFixtureOptions][] = [
  ["mrm_pri2 extended schema and data items", {}],
  [
    "mrm_pri1 UTF-16 schema and version 1 map",
    { magic: "mrm_pri1", schema: "unicode", mapVersion: 1 },
  ],
  [
    "mrm_pri0 inline values",
    { magic: "mrm_pri0", schema: "unicode", mapVersion: 1 },
  ],
];

describe("PRI resource index decoding", () => {
  it.each(layouts)(
    "decodes names, qualifiers and every stored value encoding (%s)",
    async (_name, options) => {
      const { bytes } = priFixture(options);
      const report = await inspect(bytes);
      expect(report.header).toMatchObject({
        magic: options.magic ?? "mrm_pri2",
        declared_bytes: bytes.length,
      });
      expect(report.resource_maps).toMatchObject([
        {
          version: options.mapVersion ?? 2,
          primary: true,
          name: "Sample.App",
          unique_name: "ms-appx://Sample.App/",
          schema: { extended: options.schema !== "unicode", items: 4 },
          environment_references: { count: options.mapVersion === 1 ? 1 : 0 },
          items_with_candidates: 4,
          candidates: 8,
          top_level_scopes: [
            { name: "Files", items: 2 },
            { name: "Resources", items: 2 },
          ],
        },
      ]);
      expect(report.page).toMatchObject({
        collection: "items",
        total: 4,
        items: [
          { item: 0, name: "Files/Assets/Logo.png", candidates: 2 },
          { item: 1, name: "Files/Views/Main.xbf", candidates: 1 },
          { item: 2, name: "Resources/AppDisplayName", candidates: 3 },
          { item: 3, name: "Resources/Greeting/Text", candidates: 2 },
        ],
      });
      const rows = await candidates(bytes);
      expect(texts(rows)).toEqual([
        ["Files/Assets/Logo.png", "Assets\\Logo.scale-100.png"],
        ["Files/Assets/Logo.png", "Assets\\Logo.contrast-high_scale-200 ü.png"],
        ["Files/Views/Main.xbf", "bytes"],
        ["Resources/AppDisplayName", "Sample App"],
        ["Resources/AppDisplayName", "サンプル 😀"],
        ["Resources/AppDisplayName", "Application d'exemple à"],
        ["Resources/Greeting/Text", "Hello & <welcome>"],
        ["Resources/Greeting/Text", "Text\\dark.txt"],
      ]);
      expect(rows.map(({ value_type }) => value_type)).toEqual([
        "AsciiPath",
        "Utf8Path",
        "EmbeddedData",
        "AsciiString",
        "String",
        "Utf8String",
        "String",
        "Path",
      ]);
      for (const row of rows) {
        if (row.source.kind === "external") throw new Error("external");
        expect(row.source.kind).toBe(
          options.magic === "mrm_pri0" ? "inline" : "data-item",
        );
        const { offset, bytes: size } = row.source.location;
        const stored = bytes.subarray(offset, offset + size);
        if (row.value?.kind === "text") {
          expect(row.value.well_formed).toBe(true);
          const encoding =
            row.value.encoding === "utf-8"
              ? "utf8"
              : row.value.encoding === "ascii"
                ? "latin1"
                : "utf16le";
          expect(stored.toString(encoding)).toBe(`${row.value.text}\0`);
        } else
          expect(row.value).toEqual({
            kind: "bytes",
            sha256: sha256("XBF\0embedded"),
          });
      }
      expect(rows[1]?.qualifiers).toEqual([
        { index: 2, name: "Scale", value: "200" },
        { index: 3, name: "Contrast", value: "HIGH" },
      ]);
      expect(
        rows[7]?.qualifiers.map(({ name, value }) => [name, value]),
      ).toEqual([
        ["Language", "EN-US"],
        ["Configuration", "RETAIL"],
      ]);
      expect(report.qualifier_values).toEqual([
        { name: "Language", values: ["EN-US", "ja-JP", "fr-FR"] },
        { name: "Contrast", values: ["HIGH"] },
        { name: "Scale", values: ["100", "200"] },
        { name: "Configuration", values: ["RETAIL"] },
      ]);
      const qualifiers = await inspect(bytes, { collection: "qualifiers" });
      expect(qualifiers.page).toMatchObject({
        collection: "qualifiers",
        qualifiers: expect.arrayContaining([
          {
            decision_info_section: 0,
            index: 0,
            name: "Language",
            type_code: 0,
            value: "",
            priority: 0,
            fallback_score: 0,
            referenced: false,
          },
          expect.objectContaining({
            name: "Configuration",
            // Windows 8.x generations store Configuration as code 6, Windows 10 as 9.
            type_code: options.magic === undefined ? 9 : 6,
            priority: 900,
          }),
        ]),
      });
      expect(report.coverage).toEqual({
        status: "complete",
        sections: report.header.section_count,
        interpreted_sections: report.header.section_count,
        items: 4,
        items_without_candidates: 0,
        candidates: 8,
        external_candidates: 0,
      });
      expect(report.unknowns).toEqual(
        options.mapVersion === 1
          ? [
              "Resource map section 3 carries 1 environment references (48 bytes) that were not decoded.",
            ]
          : [],
      );
    },
  );
});

describe("PRI qualifier names", () => {
  it("names Windows 10 qualifiers and leaves mrm_prif codes unnamed", async () => {
    const resources: FixtureResource[] = [
      {
        name: "Files/Image.png",
        candidates: (
          [
            ["Theme", "DARK"],
            ["DeviceFamily", "DESKTOP"],
            ["Custom", "XYZ"],
            ["HomeRegion", "US"],
            ["TargetSize", "16"],
            ["LayoutDirection", "RTL"],
            ["AlternateForm", "UNPLATED"],
            ["DXFeatureLevel", "DX11"],
          ] as const
        ).map(([name, value]) => ({
          qualifiers: [{ name, value }],
          type: "AsciiPath" as const,
          value: `Files\\Image.${value}.png`,
        })),
      },
    ];
    const windows10 = await inspect(priFixture({ resources }).bytes);
    expect(windows10.qualifier_values.map(({ name }) => name)).toEqual([
      "HomeRegion",
      "TargetSize",
      "LayoutDirection",
      "Theme",
      "AlternateForm",
      "DXFeatureLevel",
      "DeviceFamily",
      "Custom",
    ]);
    const phone = await inspect(
      priFixture({ magic: "mrm_prif", resources }).bytes,
    );
    expect(phone.qualifier_values).toEqual([
      {
        name: "Unknown",
        values: [
          "DARK",
          "DESKTOP",
          "XYZ",
          "US",
          "16",
          "RTL",
          "UNPLATED",
          "DX11",
        ],
      },
    ]);
    expect(phone.unknowns).toContain(
      "Some qualifier type codes have no established name for this PRI format generation and are named Unknown; their stored type_code is reported.",
    );
  });
});

describe("PRI values held elsewhere", () => {
  it("keeps values held elsewhere and uninterpreted sections explicit", async () => {
    const { bytes } = priFixture({
      resources: [
        {
          name: "Resources/Linked",
          candidates: [
            {
              qualifiers: [{ name: "Language", value: "en-US" }],
              type: "String",
              value: "unused",
              storage: { external: 2 },
            },
          ],
        },
      ],
      namesWithoutCandidates: ["Resources/InResourcePack"],
      extraSections: [
        { identifier: "[mrm_rev_map]  \0", content: Buffer.alloc(24) },
        { identifier: "[zzz_future]   \0", content: Buffer.alloc(8, 0xaa) },
      ],
    });
    const report = await inspect(bytes);
    expect(report.page).toMatchObject({
      items: [
        { name: "Resources/Linked", decision: 2, candidates: 1 },
        { name: "Resources/InResourcePack", decision: null, candidates: 0 },
      ],
    });
    expect(await candidates(bytes)).toMatchObject([
      {
        name: "Resources/Linked",
        value_type: "String",
        source: { kind: "external", referenced_file: 2, section: 0, index: 0 },
        value: null,
      },
    ]);
    expect(report.coverage).toMatchObject({
      sections: 7,
      interpreted_sections: 5,
      items: 2,
      items_without_candidates: 1,
      candidates: 1,
      external_candidates: 1,
    });
    expect(report.unknowns).toEqual([
      "1 of 2 named resources have no candidates in this file; other PRI files, such as resource packs, may supply their values.",
      "1 candidate values are stored in files listed by [def_file_list] sections; those files were not read.",
      'Sections reported but not interpreted (2): 5 "[mrm_rev_map]" (reverse-map), 6 "[zzz_future]" (unrecognized).',
    ]);
    const sections = await inspect(bytes, {
      collection: "sections",
      offset: 5,
    });
    expect(sections.page).toMatchObject({
      total: 7,
      sections: [
        {
          index: 5,
          identifier: "[mrm_rev_map]  \0",
          kind: "reverse-map",
          interpreted: false,
        },
        {
          index: 6,
          identifier: "[zzz_future]   \0",
          kind: "unrecognized",
          interpreted: false,
        },
      ],
    });
    expect(report.section_summary.at(-1)).toEqual({
      kind: "unrecognized",
      identifier: "[zzz_future]   \0",
      sections: 1,
      interpreted: 0,
      bytes: 48,
    });
  });
});

describe("PRI value decoding faults", () => {
  it("records malformed text and unknown value types without rejecting the index", async () => {
    const value = (
      type: "String" | "Utf8String" | "AsciiString" | number,
      stored: number[],
    ) => ({
      name: `Resources/${typeof type === "number" ? `Code${String(type)}` : type}${String(stored.length)}`,
      candidates: [{ type, value: Buffer.from(stored) }],
    });
    const { bytes } = priFixture({
      resources: [
        value("String", [0x00, 0xd8, 0x41, 0x00, 0x00, 0x00]),
        value("Utf8String", [0x41, 0xc3, 0x28, 0x00]),
        value("AsciiString", [0x41, 0xff, 0x00]),
        value("String", [0x41, 0x00]),
        value(9, [1, 2, 3]),
      ],
    });
    const rows = await candidates(bytes);
    expect(
      rows.map(({ value_type, value_type_code, value }) => [
        value_type,
        value_type_code,
        value,
      ]),
    ).toEqual([
      [
        "String",
        0,
        {
          kind: "text",
          encoding: "utf-16le",
          text: "\uFFFDA",
          truncated: false,
          well_formed: false,
        },
      ],
      [
        "Utf8String",
        4,
        {
          kind: "text",
          encoding: "utf-8",
          text: "A\uFFFD(",
          truncated: false,
          well_formed: false,
        },
      ],
      [
        "AsciiString",
        3,
        {
          kind: "text",
          encoding: "ascii",
          text: "A\uFFFD",
          truncated: false,
          well_formed: false,
        },
      ],
      [
        "String",
        0,
        {
          kind: "text",
          encoding: "utf-16le",
          text: "A",
          truncated: false,
          well_formed: false,
        },
      ],
      ["Unknown", 9, { kind: "bytes", sha256: sha256(Buffer.from([1, 2, 3])) }],
    ]);
    const report = await inspect(bytes);
    expect(report.value_types).toEqual([
      { value_type: "String", candidates: 2 },
      { value_type: "AsciiString", candidates: 1 },
      { value_type: "Utf8String", candidates: 1 },
      { value_type: "Unknown", candidates: 1 },
    ]);
    expect(report.unknowns).toContain(
      "1 candidates use value type codes outside 0-6 (9); their values are reported as opaque bytes.",
    );
  });
});

describe("PRI resource selection", () => {
  it("selects exact names, case-insensitive queries, qualifier values and value types", async () => {
    const { bytes } = priFixture({
      namesWithoutCandidates: ["Resources/Unvalued"],
    });
    const names = async (selection: Record<string, unknown>) =>
      (await candidates(bytes, selection)).map(
        ({ name, candidate }) => `${name}#${String(candidate)}`,
      );
    expect(
      await names({
        names: ["Resources/AppDisplayName", "resources/greeting/text"],
      }),
    ).toEqual([
      "Resources/AppDisplayName#3",
      "Resources/AppDisplayName#4",
      "Resources/AppDisplayName#5",
    ]);
    expect(await names({ query: "GREETING" })).toEqual([
      "Resources/Greeting/Text#6",
      "Resources/Greeting/Text#7",
    ]);
    expect(
      await names({ qualifiers: [{ name: "Language", value: "en-us" }] }),
    ).toEqual([
      "Resources/AppDisplayName#3",
      "Resources/Greeting/Text#6",
      "Resources/Greeting/Text#7",
    ]);
    expect(
      await names({
        qualifiers: [
          { name: "Language", value: "EN-US" },
          { name: "Language", value: "fr-fr" },
        ],
      }),
    ).toHaveLength(4);
    expect(
      await names({
        qualifiers: [
          { name: "Language", value: "EN-US" },
          { name: "Configuration", value: "retail" },
        ],
      }),
    ).toEqual(["Resources/Greeting/Text#7"]);
    expect(
      await names({ qualifiers: [{ name: "Scale", value: "200" }] }),
    ).toEqual(["Files/Assets/Logo.png#1"]);
    expect(await names({ value_types: ["EmbeddedData"] })).toEqual([
      "Files/Views/Main.xbf#2",
    ]);
    expect(
      await names({
        query: "resources/",
        value_types: ["String", "AsciiString", "Utf8String"],
      }),
    ).toHaveLength(4);
    const items = await inspect(bytes, {
      qualifiers: [{ name: "Language", value: "EN-US" }],
    });
    expect(items.page).toMatchObject({
      total: 2,
      items: [
        {
          name: "Resources/AppDisplayName",
          candidates: 1,
          value_types: ["AsciiString"],
        },
        {
          name: "Resources/Greeting/Text",
          candidates: 2,
          value_types: ["String", "Path"],
        },
      ],
    });
    expect((await inspect(bytes, { query: "unvalued" })).page).toMatchObject({
      total: 1,
      items: [{ name: "Resources/Unvalued", decision: null, candidates: 0 }],
    });
  });
});

describe("PRI paging", () => {
  it("pages stable rows with totals and continuation offsets", async () => {
    const { bytes } = priFixture();
    const all = await candidates(bytes);
    const first = await inspect(bytes, { collection: "candidates", limit: 3 });
    expect(first.page).toMatchObject({
      offset: 0,
      limit: 3,
      total: 8,
      returned: 3,
      next_offset: 3,
      end: "limit",
    });
    const last = await inspect(bytes, {
      collection: "candidates",
      offset: 6,
      limit: 3,
    });
    expect(last.page).toMatchObject({
      total: 8,
      returned: 2,
      next_offset: null,
      end: "exhausted",
    });
    const pages: PriCandidateRow[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const { page } = await inspect(bytes, {
        collection: "candidates",
        offset,
        limit: 3,
      });
      if (page.collection !== "candidates") throw new Error(page.collection);
      pages.push(...page.candidates);
      offset = page.next_offset;
    }
    expect(pages).toEqual(all);
    expect(
      (await inspect(bytes, { collection: "candidates", offset: 50 })).page,
    ).toMatchObject({
      total: 8,
      returned: 0,
      next_offset: null,
      end: "exhausted",
    });
    expect(
      (await inspect(bytes, { collection: "sections", limit: 2 })).page,
    ).toMatchObject({
      total: 5,
      returned: 2,
      next_offset: 2,
    });
  });

  it("ends a page at its serialized-row budget and continues without truncating values", async () => {
    const text = "x".repeat(50_000);
    const { bytes } = priFixture({
      resources: Array.from({ length: 30 }, (_unused, index) => ({
        name: `Resources/Long${String(index).padStart(2, "0")}`,
        candidates: [{ type: "AsciiString" as const, value: text }],
      })),
    });
    const first = await inspect(bytes, { collection: "candidates" });
    if (first.page.collection !== "candidates")
      throw new Error(first.page.collection);
    expect(first.page).toMatchObject({ total: 30, end: "byte_budget" });
    expect(first.page.returned).toBeGreaterThan(10);
    expect(first.page.returned).toBeLessThan(30);
    expect(first.page.next_offset).toBe(first.page.returned);
    expect(
      first.page.candidates.every(
        ({ value }) =>
          value?.kind === "text" && value.text === text && !value.truncated,
      ),
    ).toBe(true);
    const second = await inspect(bytes, {
      collection: "candidates",
      offset: first.page.next_offset,
    });
    expect(second.page.offset).toBe(first.page.returned);
  });

  it("decodes the one-item group shorthand like an explicit group", async () => {
    // Only file offsets move with the larger group table.
    const withoutLocations = (rows: readonly PriCandidateRow[]) =>
      rows.map(({ source, ...row }) => ({ ...row, source: source.kind }));
    expect(
      withoutLocations(
        await candidates(priFixture({ singletonGroups: true }).bytes),
      ),
    ).toEqual(withoutLocations(await candidates(priFixture().bytes)));
  });

  it("allows cancellation while decoding", async () => {
    const controller = new AbortController();
    const parsing = inspect(priFixture().bytes, {}, controller.signal);
    controller.abort();
    await expect(parsing).rejects.toThrow();
  });
});

type Mutation = (fixture: PriFixture) => Buffer | void;

const section = (fixture: PriFixture, index: number) => {
  const found = fixture.sections[index];
  if (found === undefined)
    throw new Error(`Missing fixture section ${String(index)}`);
  return found;
};

const malformed: readonly [string, PriFixtureOptions, Mutation][] = [
  [
    "unknown magic",
    {},
    ({ bytes }) => void bytes.write("mrm_pri9", 0, "latin1"),
  ],
  [
    "unsupported header fields",
    {},
    ({ bytes }) => void bytes.writeUInt16LE(2, 10),
  ],
  [
    "declared size",
    {},
    ({ bytes }) => void bytes.writeUInt32LE(bytes.length + 8, 12),
  ],
  ["truncated footer", {}, ({ bytes }) => bytes.subarray(0, bytes.length - 8)],
  [
    "footer magic",
    {},
    ({ bytes }) => void bytes.write("mrm_pri1", bytes.length - 8, "latin1"),
  ],
  [
    "table of contents past the footer",
    {},
    ({ bytes }) => void bytes.writeUInt32LE(bytes.length, 16),
  ],
  [
    "section header disagreeing with its entry",
    {},
    (fixture) =>
      void fixture.bytes.writeUInt32LE(
        section(fixture, 2).length + 8,
        section(fixture, 2).offset + 24,
      ),
  ],
  [
    "section trailer",
    {},
    (fixture) =>
      void fixture.bytes.writeUInt32LE(
        0,
        section(fixture, 3).offset + section(fixture, 3).length - 8,
      ),
  ],
  [
    "overlapping sections",
    {},
    ({ bytes, tocOffset }) =>
      void bytes.copy(bytes, tocOffset + 4 * 32, tocOffset, tocOffset + 32),
  ],
  [
    "missing descriptor",
    {},
    (fixture) => {
      fixture.bytes.write(
        "[mrm_future_x]\0\0",
        fixture.tocOffset + 32,
        "latin1",
      );
      fixture.bytes.write(
        "[mrm_future_x]\0\0",
        section(fixture, 1).offset,
        "latin1",
      );
    },
  ],
  [
    "descriptor listing a decision section as the schema",
    {},
    (fixture) =>
      void fixture.bytes.writeUInt16LE(0, section(fixture, 1).content + 20),
  ],
  [
    "decision range outside the index table",
    {},
    (fixture) =>
      void fixture.bytes.writeUInt16LE(
        0xfff0,
        section(fixture, 0).content + 12,
      ),
  ],
  [
    "qualifier value outside its pool",
    {},
    ({ bytes, decision }) =>
      void bytes.writeUInt32LE(0xffff, decision.distinct + 12 + 8),
  ],
  [
    "qualifier values without terminators",
    {},
    (fixture) =>
      void fixture.bytes.fill(
        0x41,
        fixture.decision.data,
        section(fixture, 0).offset + section(fixture, 0).length - 8,
      ),
  ],
  [
    "schema parent after its child",
    {},
    ({ bytes, schema }) => void bytes.writeUInt16LE(5, schema.entries + 12),
  ],
  [
    "schema full name length",
    {},
    ({ bytes, schema }) =>
      void bytes.writeUInt16LE(
        bytes.readUInt16LE(schema.entries + 14) + 1,
        schema.entries + 14,
      ),
  ],
  [
    "schema scope child range",
    {},
    ({ bytes, schema }) =>
      void bytes.writeUInt16LE(
        bytes.readUInt16LE(schema.scopes + 2) + 1,
        schema.scopes + 2,
      ),
  ],
  [
    "non-ASCII byte in an ASCII name",
    {},
    (fixture) => {
      const at = fixture.bytes.indexOf(
        Buffer.from("Files\0", "latin1"),
        section(fixture, 2).content,
      );
      fixture.bytes[at] = 0xc6;
    },
  ],
  [
    "unpaired surrogate in a UTF-16 name",
    { schema: "unicode" },
    (fixture) => {
      const at = fixture.bytes.indexOf(
        Buffer.from("Files\0", "utf16le"),
        section(fixture, 2).content,
      );
      fixture.bytes.writeUInt16LE(0xd800, at);
    },
  ],
  [
    "unsupported names table",
    {},
    (fixture) =>
      void fixture.bytes.write(
        "[def_hnamesz]",
        section(fixture, 2).content + 8,
        "latin1",
      ),
  ],
  [
    "item assigned twice",
    { singletonGroups: true },
    ({ bytes, map }) => void bytes.writeUInt16LE(0, map.valueTypes + 7 * 8 + 4),
  ],
  [
    "overlapping candidate ranges",
    {},
    ({ bytes, map }) => void bytes.writeUInt16LE(0, map.itemInfos + 4 + 2),
  ],
  [
    "value type descriptor",
    {},
    ({ bytes, map }) => void bytes.writeUInt32LE(5, map.valueTypes),
  ],
  [
    "value type outside the table",
    {},
    ({ bytes, map }) => void (bytes[map.candidates + 1] = 200),
  ],
  [
    "unsupported candidate kind",
    {},
    ({ bytes, map }) => void (bytes[map.candidates] = 7),
  ],
  [
    "missing data item",
    {},
    ({ bytes, map }) => void bytes.writeUInt16LE(999, map.candidates + 4),
  ],
  [
    "data item outside its data area",
    {},
    ({ bytes, dataItems }) =>
      void bytes.writeUInt16LE(0xffff, dataItems.table + 2),
  ],
  [
    "partially overlapping data items",
    {},
    ({ bytes, dataItems }) =>
      void bytes.writeUInt16LE(
        bytes.readUInt16LE(dataItems.table) + 2,
        dataItems.table + 4,
      ),
  ],
  [
    "inline value outside the map data",
    { magic: "mrm_pri0", schema: "unicode", mapVersion: 1 },
    ({ bytes, map }) => void bytes.writeUInt32LE(0xfffff, map.candidates + 4),
  ],
  [
    "large table length disagreeing with its counts",
    {},
    (fixture) =>
      void fixture.bytes.writeUInt32LE(12, section(fixture, 3).content + 28),
  ],
];

describe("malformed PRI input", () => {
  it.each(malformed)(
    "rejects %s without partial success",
    async (_name, options, mutate) => {
      const fixture = priFixture(options);
      const bytes = mutate(fixture) ?? fixture.bytes;
      await expect(inspect(bytes)).rejects.toMatchObject({ reason: "format" });
    },
  );

  it("bounds structural decoding before allocation", () => {
    // 17 decisions each spanning a 65,535-entry index table expand past the bound.
    const decisions = 17;
    const indexEntries = 0xffff;
    const content = Buffer.alloc(
      12 + decisions * 4 + 4 + 8 + 12 + indexEntries * 2 + 2,
    );
    [1, 1, 1, decisions, indexEntries, 1].forEach((value, index) =>
      content.writeUInt16LE(value, index * 2),
    );
    for (let decision = 0; decision < decisions; decision++)
      content.writeUInt16LE(indexEntries, 12 + decision * 4 + 2);
    const section = {
      index: 0,
      identifier: "[mrm_decn_info]\0",
      kind: "decision-info" as const,
      qualifier: 0,
      flags: 0,
      sectionFlags: 0,
      offset: 0,
      length: content.length + 40,
      content: new SectionContent(
        content,
        0,
        content.length,
        "test decision info",
      ),
    };
    expect(() =>
      readDecisionInfo(section, "mrm_pri2", new TextBudget()),
    ).toThrow(expect.objectContaining({ reason: "limit" }));
    expect(() => new TextBudget().consume((1 << 24) + 1, "names")).toThrow(
      expect.objectContaining({ reason: "limit" }),
    );
  });
});

describe("corrupted PRI bytes", () => {
  test.prop(
    [
      fc.constantFrom(...layouts.map(([, options]) => options)),
      fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), {
        minLength: 1,
        maxLength: 8,
      }),
    ],
    { numRuns: 150 },
  )(
    "either decode to a valid report or fail with a typed format or limit failure",
    async (options, edits) => {
      const { bytes } = priFixture(options);
      for (const [at, value] of edits) bytes[at % bytes.length] = value;
      for (const collection of ["items", "candidates"] as const)
        await inspect(bytes, { collection }).catch((error: unknown) => {
          expect(error).toBeInstanceOf(ArtifactReaderFailure);
          expect(["format", "limit"]).toContain(
            (error as ArtifactReaderFailure).reason,
          );
        });
    },
  );
});
