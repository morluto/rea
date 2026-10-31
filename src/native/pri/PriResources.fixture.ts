/**
 * Hand-assembled PRI bytes for tests, written from the documented container
 * layout and independent of the production decoder.
 */

/** Windows 10 (mrm_pri2) qualifier type codes, as makepri names them. */
const QUALIFIER_CODES = {
  Language: 0,
  Contrast: 1,
  Scale: 2,
  HomeRegion: 3,
  TargetSize: 4,
  LayoutDirection: 5,
  Theme: 6,
  AlternateForm: 7,
  DXFeatureLevel: 8,
  Configuration: 9,
  DeviceFamily: 10,
  Custom: 11,
} as const;

/** Windows 8.x (mrm_pri0, mrm_pri1) codes: Configuration is 6 and there is no Theme. */
const WINDOWS_8_QUALIFIER_CODES: Partial<
  Record<keyof typeof QUALIFIER_CODES, number>
> = {
  Language: 0,
  Contrast: 1,
  Scale: 2,
  HomeRegion: 3,
  TargetSize: 4,
  LayoutDirection: 5,
  Configuration: 6,
  AlternateForm: 7,
  DXFeatureLevel: 8,
};

const qualifierCode = (
  name: keyof typeof QUALIFIER_CODES,
  magic: NonNullable<PriFixtureOptions["magic"]>,
): number => {
  const code =
    magic === "mrm_pri0" || magic === "mrm_pri1"
      ? WINDOWS_8_QUALIFIER_CODES[name]
      : QUALIFIER_CODES[name];
  if (code === undefined)
    throw new TypeError(`${name} has no qualifier code in ${magic} fixtures`);
  return code;
};

const VALUE_TYPE_CODES = {
  String: 0,
  Path: 1,
  EmbeddedData: 2,
  AsciiString: 3,
  Utf8String: 4,
  AsciiPath: 5,
  Utf8Path: 6,
} as const;

export interface FixtureQualifier {
  readonly name: keyof typeof QUALIFIER_CODES;
  readonly value: string;
  readonly priority?: number;
  readonly fallback?: number;
}

export interface FixtureCandidate {
  readonly qualifiers?: readonly FixtureQualifier[];
  /** Stored value type, or a raw code outside the known table. */
  readonly type: keyof typeof VALUE_TYPE_CODES | number;
  /** Text is encoded for the type and NUL-terminated; a Buffer is stored verbatim. */
  readonly value: string | Buffer;
  /** Where the value lives; external candidates name a 0-based referenced file. */
  readonly storage?: "data-item" | "inline" | { readonly external: number };
}

export interface FixtureResource {
  /** Slash-separated full name, such as Resources/AppDisplayName. */
  readonly name: string;
  readonly candidates: readonly FixtureCandidate[];
}

export interface PriFixtureOptions {
  readonly magic?: "mrm_pri0" | "mrm_pri1" | "mrm_pri2" | "mrm_prif";
  readonly resources?: readonly FixtureResource[];
  /** Named items present in the schema without candidates in this map. */
  readonly namesWithoutCandidates?: readonly string[];
  /** extended: [mrm_hschemaex] with ASCII names; unicode: [mrm_hschema] with UTF-16 names. */
  readonly schema?: "extended" | "unicode";
  /** Map version 1 carries one environment reference; version 2 carries none. */
  readonly mapVersion?: 1 | 2;
  /** Encode each item through the one-item group shorthand instead of one shared group. */
  readonly singletonGroups?: boolean;
  /** Additional framed sections appended after the data item section. */
  readonly extraSections?: readonly {
    readonly identifier: string;
    readonly content: Buffer;
  }[];
}

/** File offsets of fixture structures that malformed-input tests overwrite. */
export interface PriFixture {
  bytes: Buffer;
  readonly sections: readonly {
    readonly identifier: string;
    readonly offset: number;
    readonly length: number;
    readonly content: number;
  }[];
  readonly tocOffset: number;
  readonly decision: {
    readonly qualifiers: number;
    readonly distinct: number;
    readonly indexTable: number;
    readonly data: number;
  };
  readonly schema: { readonly entries: number; readonly scopes: number };
  readonly map: {
    readonly valueTypes: number;
    readonly itemInfos: number;
    readonly candidates: number;
    readonly data: number;
  };
  readonly dataItems: { readonly table: number; readonly data: number };
}

const DEFAULT_RESOURCES: readonly FixtureResource[] = [
  {
    name: "Files/Assets/Logo.png",
    candidates: [
      {
        qualifiers: [
          { name: "Scale", value: "100", priority: 200, fallback: 1000 },
        ],
        type: "AsciiPath",
        value: "Assets\\Logo.scale-100.png",
      },
      {
        qualifiers: [
          { name: "Scale", value: "200", priority: 200, fallback: 750 },
          { name: "Contrast", value: "HIGH", priority: 400, fallback: 0 },
        ],
        type: "Utf8Path",
        value: "Assets\\Logo.contrast-high_scale-200 ü.png",
      },
    ],
  },
  {
    name: "Files/Views/Main.xbf",
    candidates: [{ type: "EmbeddedData", value: Buffer.from("XBF\0embedded") }],
  },
  {
    name: "Resources/AppDisplayName",
    candidates: [
      {
        qualifiers: [
          { name: "Language", value: "EN-US", priority: 700, fallback: 1000 },
        ],
        type: "AsciiString",
        value: "Sample App",
      },
      {
        qualifiers: [
          { name: "Language", value: "ja-JP", priority: 700, fallback: 0 },
        ],
        type: "String",
        value: "サンプル 😀",
      },
      {
        qualifiers: [
          { name: "Language", value: "fr-FR", priority: 700, fallback: 0 },
        ],
        type: "Utf8String",
        value: "Application d'exemple à",
      },
    ],
  },
  {
    name: "Resources/Greeting/Text",
    candidates: [
      {
        qualifiers: [
          { name: "Language", value: "EN-US", priority: 700, fallback: 1000 },
        ],
        type: "String",
        value: "Hello & <welcome>",
      },
      {
        qualifiers: [
          { name: "Language", value: "EN-US", priority: 700, fallback: 1000 },
          {
            name: "Configuration",
            value: "RETAIL",
            priority: 900,
            fallback: 0,
          },
        ],
        type: "Path",
        value: "Text\\dark.txt",
      },
    ],
  },
];

const align = (value: number, alignment: number): number =>
  Math.ceil(value / alignment) * alignment;

const utf16z = (text: string): Buffer => Buffer.from(`${text}\0`, "utf16le");

const encodeValue = (candidate: FixtureCandidate): Buffer => {
  if (Buffer.isBuffer(candidate.value)) return candidate.value;
  const type = candidate.type;
  if (type === "String" || type === "Path") return utf16z(candidate.value);
  if (type === "Utf8String" || type === "Utf8Path")
    return Buffer.from(`${candidate.value}\0`, "utf8");
  return Buffer.from(`${candidate.value}\0`, "latin1");
};

const writer = () => {
  const parts: Buffer[] = [];
  let length = 0;
  const api = {
    get length() {
      return length;
    },
    u8(value: number) {
      parts.push(Buffer.from([value]));
      length += 1;
      return api;
    },
    u16(value: number) {
      const part = Buffer.alloc(2);
      part.writeUInt16LE(value);
      parts.push(part);
      length += 2;
      return api;
    },
    u32(value: number) {
      const part = Buffer.alloc(4);
      part.writeUInt32LE(value);
      parts.push(part);
      length += 4;
      return api;
    },
    bytes(value: Buffer) {
      parts.push(value);
      length += value.length;
      return api;
    },
    pad(alignment: number) {
      return api.bytes(Buffer.alloc(align(length, alignment) - length));
    },
    done: () => Buffer.concat(parts),
  };
  return api;
};

type Magic = NonNullable<PriFixtureOptions["magic"]>;

/** Deduplicate keyed rows, returning each key's stable index. */
const interner = <Row>(rows: Row[], keyOf: (row: Row) => string) => {
  const indices = new Map(rows.map((row, index) => [keyOf(row), index]));
  return (row: Row): number => {
    const key = keyOf(row);
    let index = indices.get(key);
    if (index === undefined) {
      index = rows.length;
      rows.push(row);
      indices.set(key, index);
    }
    return index;
  };
};

/** Qualifiers, sets and decisions; qualifier 0 is makepri's empty Language placeholder. */
const buildDecisionInfo = (
  resources: readonly FixtureResource[],
  magic: Magic,
) => {
  const qualifiers: {
    code: number;
    value: string;
    priority: number;
    fallback: number;
  }[] = [];
  const qualifierIndex = interner(
    qualifiers,
    ({ code, value, priority, fallback }) =>
      `${String(code)}\0${value}\0${String(priority)}\0${String(fallback)}`,
  );
  const fixtureQualifier = (qualifier: FixtureQualifier) =>
    qualifierIndex({
      code: qualifierCode(qualifier.name, magic),
      value: qualifier.value,
      priority: qualifier.priority ?? 500,
      fallback: qualifier.fallback ?? 0,
    });
  fixtureQualifier({ name: "Language", value: "", priority: 0, fallback: 0 });
  const sets: number[][] = [[]];
  const setIndex = interner(sets, (members) => members.join(","));
  const decisions: number[][] = [[], [0]];
  const decisionIndex = interner(decisions, (members) => members.join(","));
  const decisionOf = resources.map((resource) =>
    decisionIndex(
      resource.candidates.map((candidate) =>
        setIndex((candidate.qualifiers ?? []).map(fixtureQualifier)),
      ),
    ),
  );
  const indexTable: number[] = [];
  const range = (members: readonly number[]) => {
    const first = indexTable.length;
    indexTable.push(...members);
    return [first, members.length] as const;
  };
  const setRanges = sets.map(range);
  const decisionRanges = decisions.map(range);
  const pool = writer();
  const valueOffsets = qualifiers.map(({ value }) => {
    const offset = pool.length / 2;
    pool.bytes(utf16z(value));
    return offset;
  });
  const section = writer()
    .u16(qualifiers.length)
    .u16(qualifiers.length)
    .u16(sets.length)
    .u16(decisions.length)
    .u16(indexTable.length)
    .u16(pool.length / 2);
  for (const [first, count] of [...decisionRanges, ...setRanges])
    section.u16(first).u16(count);
  const qualifiersAt = section.length;
  qualifiers.forEach(({ priority, fallback }, index) =>
    section.u16(index).u16(priority).u16(fallback).u16(0),
  );
  const distinctAt = section.length;
  qualifiers.forEach(({ code }, index) =>
    section
      .u16(index === 0 ? 0 : 2)
      .u16(code)
      .u16(0)
      .u16(index === 0 ? 1 : 10)
      .u32(valueOffsets[index] ?? 0),
  );
  const indexTableAt = section.length;
  for (const entry of indexTable) section.u16(entry);
  const dataAt = section.length;
  section.bytes(pool.done()).pad(8);
  return {
    content: section.done(),
    offsets: {
      qualifiers: qualifiersAt,
      distinct: distinctAt,
      indexTable: indexTableAt,
      data: dataAt,
    },
    decisionOf,
  };
};

interface Tree {
  readonly name: string;
  readonly children: Map<string, Tree>;
  item?: number;
}

interface SchemaEntry {
  readonly node: Tree;
  readonly parent: number;
  readonly full: string;
  readonly scope: boolean;
  readonly index: number;
}

/** Breadth-first entries keep each scope's children contiguous. */
const schemaEntries = (itemNames: readonly string[]) => {
  const root: Tree = { name: "", children: new Map() };
  itemNames.forEach((name, item) => {
    let node = root;
    for (const part of name.split("/")) {
      let child = node.children.get(part);
      if (child === undefined) {
        child = { name: part, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.item = item;
  });
  const entries: SchemaEntry[] = [
    { node: root, parent: 0, full: "", scope: true, index: 0 },
  ];
  const childRanges: [number, number][] = [];
  let scopeCount = 1;
  for (let position = 0; position < entries.length; position++) {
    const entry = entries[position];
    if (entry === undefined || !entry.scope) continue;
    const first = entries.length;
    for (const child of entry.node.children.values()) {
      const scope = child.item === undefined;
      entries.push({
        node: child,
        parent: position,
        full: entry.full === "" ? child.name : `${entry.full}/${child.name}`,
        scope,
        index: scope ? scopeCount++ : (child.item ?? 0),
      });
    }
    childRanges[entry.index] = [first, entries.length - first];
  }
  return { entries, childRanges, scopeCount };
};

/** Printable ASCII names go to the ASCII pool of an extended schema, others to UTF-16. */
const namePools = (entries: readonly SchemaEntry[], unicode: boolean) => {
  const unicodePool = writer();
  const asciiPool = writer();
  if (unicode) unicodePool.bytes(utf16z(""));
  else asciiPool.u8(0);
  const offsets = entries.map(({ node }, position) => {
    if (position === 0) return { offset: 0, ascii: !unicode };
    const ascii = !unicode && /^[\x20-\x7e]*$/u.test(node.name);
    const pool = ascii ? asciiPool : unicodePool;
    const offset = ascii ? pool.length : pool.length / 2;
    pool.bytes(
      ascii ? Buffer.from(`${node.name}\0`, "latin1") : utf16z(node.name),
    );
    return { offset, ascii };
  });
  return { unicodePool, asciiPool, offsets };
};

const buildSchema = (itemNames: readonly string[], unicode: boolean) => {
  const { entries, childRanges, scopeCount } = schemaEntries(itemNames);
  const { unicodePool, asciiPool, offsets } = namePools(entries, unicode);
  const uniqueName = "ms-appx://Sample.App/";
  const mapName = "Sample.App";
  const schema = writer()
    .u16(1)
    .u16(uniqueName.length + 1)
    .u16(mapName.length + 1)
    .u16(0);
  if (!unicode) schema.bytes(Buffer.from("[def_hnamesx]  \0", "latin1"));
  schema.u16(1).u16(0).u32(0).u32(0x2a2a2a2a);
  schema.u32(scopeCount).u32(itemNames.length);
  schema.bytes(utf16z(uniqueName)).bytes(utf16z(mapName));
  schema
    .u16(0)
    .u16(Math.max(0, ...entries.map(({ full }) => full.length)))
    .u16(0)
    .u32(entries.length)
    .u32(scopeCount)
    .u32(itemNames.length)
    .u32(unicodePool.length / 2)
    .u32(0);
  if (!unicode) schema.u32(asciiPool.length);
  const entriesAt = schema.length;
  entries.forEach(({ node, parent, full, scope, index }, position) => {
    const name = offsets[position] ?? { offset: 0, ascii: false };
    schema
      .u16(parent)
      .u16(full.length)
      .u16(node.name.toUpperCase().charCodeAt(0) || 0)
      .u8(node.name.length & 0xff)
      .u8(
        (scope ? 0x10 : 0) |
          (name.ascii ? 0x20 : 0) |
          ((name.offset >> 16) & 0x0f),
      )
      .u16(name.offset & 0xffff)
      .u16(index);
  });
  const scopesAt = schema.length;
  const positions: { scopes: number[]; items: number[] } = {
    scopes: [],
    items: [],
  };
  entries.forEach(({ scope, index }, position) => {
    (scope ? positions.scopes : positions.items)[index] = position;
  });
  for (let scope = 0; scope < scopeCount; scope++) {
    const [first, count] = childRanges[scope] ?? [0, 0];
    schema
      .u16(positions.scopes[scope] ?? 0)
      .u16(count)
      .u16(first)
      .u16(0);
  }
  for (let item = 0; item < itemNames.length; item++)
    schema.u16(positions.items[item] ?? 0);
  schema.bytes(unicodePool.done()).bytes(asciiPool.done()).pad(8);
  return {
    content: schema.done(),
    offsets: { entries: entriesAt, scopes: scopesAt },
  };
};

interface CandidateRecord {
  readonly kind: 0 | 1;
  readonly type: number;
  /** Inline length, or source file (0 = this file). */
  readonly a: number;
  /** Inline offset, or data item index. */
  b: number;
  /** Data item section. */
  readonly c: number;
}

/** Store values: text in the 16-bit string table while it fits, other data as blobs. */
const placeValues = (resources: readonly FixtureResource[], magic: Magic) => {
  const strings: Buffer[] = [];
  const blobs: Buffer[] = [];
  const inline = writer();
  const records: CandidateRecord[] = [];
  const typeCodes = [0, 1, 2, 3, 4, 5, 6];
  let stringBytes = 0;
  const fitsStringTable = (bytes: Buffer): boolean => {
    const end = align(stringBytes, 4) + bytes.length;
    if (end > 0xffff) return false;
    stringBytes = end;
    return true;
  };
  for (const candidate of resources.flatMap(({ candidates }) => candidates)) {
    const bytes = encodeValue(candidate);
    const code =
      typeof candidate.type === "number"
        ? candidate.type
        : VALUE_TYPE_CODES[candidate.type];
    if (!typeCodes.includes(code)) typeCodes.push(code);
    const type = typeCodes.indexOf(code);
    const storage =
      candidate.storage ?? (magic === "mrm_pri0" ? "inline" : "data-item");
    const text = code <= 6 && code !== VALUE_TYPE_CODES.EmbeddedData;
    if (storage === "inline") {
      inline.pad(2);
      records.push({ kind: 0, type, a: bytes.length, b: inline.length, c: 0 });
      inline.bytes(bytes);
    } else if (typeof storage === "object")
      records.push({ kind: 1, type, a: storage.external + 1, b: 0, c: 0 });
    else if (text && fitsStringTable(bytes))
      records.push({ kind: 1, type, a: 0, b: strings.push(bytes) - 1, c: 4 });
    // Blob numbers are provisional until the string count is final.
    else records.push({ kind: 1, type, a: 0, b: -blobs.push(bytes), c: 4 });
  }
  // Blob items follow the string items in the data item index space.
  for (const record of records)
    if (record.kind === 1 && record.b < 0)
      record.b = strings.length - record.b - 1;
  return { strings, blobs, inline: inline.done(), records, typeCodes };
};

const buildDataItems = (
  strings: readonly Buffer[],
  blobs: readonly Buffer[],
) => {
  const pool = writer();
  const place = (bytes: Buffer) => {
    pool.pad(4);
    const offset = pool.length;
    pool.bytes(bytes);
    return [offset, bytes.length] as const;
  };
  const stringRanges = strings.map(place);
  const blobRanges = blobs.map(place);
  const section = writer()
    .u32(0)
    .u16(strings.length)
    .u16(blobs.length)
    .u32(pool.length);
  const tableAt = section.length;
  for (const [offset, length] of stringRanges) section.u16(offset).u16(length);
  for (const [offset, length] of blobRanges) section.u32(offset).u32(length);
  const dataAt = section.length;
  section.bytes(pool.done()).pad(8);
  return { content: section.done(), offsets: { table: tableAt, data: dataAt } };
};

const buildMap = (
  options: PriFixtureOptions,
  resources: readonly FixtureResource[],
  decisionOf: readonly number[],
  values: ReturnType<typeof placeValues>,
) => {
  const environment =
    options.mapVersion === 1
      ? Buffer.concat([utf16z("win://Windows/1"), Buffer.alloc(16)])
      : Buffer.alloc(0);
  const items = resources.length;
  const singleton = options.singletonGroups === true;
  const map = writer()
    .u16(environment.length)
    .u16(options.mapVersion === 1 ? 1 : 0)
    .u16(2)
    .u16(0)
    .u16(0)
    .u16(values.typeCodes.length)
    .u16(singleton ? items : Math.min(items, 1))
    .u16(singleton ? 0 : Math.min(items, 1))
    .u32(items)
    .u32(values.records.length)
    .u32(values.inline.length)
    .u32(0)
    .bytes(environment);
  const valueTypesAt = map.length;
  for (const code of values.typeCodes) map.u32(4).u32(code);
  if (singleton)
    for (let item = 0; item < items; item++) map.u16(item).u16(item);
  else if (items > 0) map.u16(0).u16(0).u16(items).u16(0);
  const itemInfosAt = map.length;
  let nextCandidate = 0;
  resources.forEach((resource, item) => {
    map.u16(decisionOf[item] ?? 0).u16(nextCandidate);
    nextCandidate += resource.candidates.length;
  });
  const candidatesAt = map.length;
  for (const { kind, type, a, b, c } of values.records) {
    map.u8(kind).u8(type).u16(a);
    if (kind === 0) map.u32(b);
    else map.u16(b).u16(c);
  }
  const dataAt = map.length;
  map.bytes(values.inline).pad(8);
  return {
    content: map.done(),
    offsets: {
      valueTypes: valueTypesAt,
      itemInfos: itemInfosAt,
      candidates: candidatesAt,
      data: dataAt,
    },
  };
};

/** Descriptor naming schema 2, decisions 0, map 3 and data items 4 when present. */
const buildDescriptor = (magic: Magic): Buffer => {
  const dataItems = magic === "mrm_pri0" ? 0 : 1;
  const descriptor = writer()
    .u16(2)
    .u16(0xffff)
    .u16(0)
    .u16(1)
    .u16(1)
    .u16(1)
    .u16(3)
    .u16(0)
    .u16(dataItems)
    .u16(0)
    .u16(2)
    .u16(0)
    .u16(3);
  if (dataItems > 0) descriptor.u16(4);
  return descriptor.pad(8).done();
};

/** Frame sections with a header, table of contents and footer. */
const frame = (
  magic: Magic,
  contents: readonly { identifier: string; content: Buffer }[],
) => {
  const tocOffset = 32;
  const sectionsOffset = tocOffset + contents.length * 32;
  let cursor = sectionsOffset;
  const sections = contents.map(({ identifier, content }) => {
    const length = 32 + align(content.length, 8) + 8;
    const section = {
      identifier,
      offset: cursor,
      length,
      content: cursor + 32,
    };
    cursor += length;
    return section;
  });
  const total = cursor + 16;
  const bytes = Buffer.alloc(total);
  bytes.write(magic, 0, "latin1");
  bytes.writeUInt16LE(1, 10);
  bytes.writeUInt32LE(total, 12);
  bytes.writeUInt32LE(tocOffset, 16);
  bytes.writeUInt32LE(sectionsOffset, 20);
  bytes.writeUInt16LE(contents.length, 24);
  bytes.writeUInt16LE(0xffff, 26);
  sections.forEach(({ identifier, offset, length }, index) => {
    const entry = tocOffset + index * 32;
    bytes.write(identifier, entry, 16, "latin1");
    bytes.writeUInt32LE(offset - sectionsOffset, entry + 24);
    bytes.writeUInt32LE(length, entry + 28);
    bytes.write(identifier, offset, 16, "latin1");
    bytes.writeUInt32LE(length, offset + 24);
    contents[index]?.content.copy(bytes, offset + 32);
    bytes.writeUInt32LE(0xdef5fade, offset + length - 8);
    bytes.writeUInt32LE(length, offset + length - 4);
  });
  bytes.writeUInt32LE(0xdefffade, total - 16);
  bytes.writeUInt32LE(total, total - 12);
  bytes.write(magic, total - 8, "latin1");
  return { bytes, sections, tocOffset };
};

/** Assemble a complete PRI file from resources, deterministic for a given input. */
export const priFixture = (options: PriFixtureOptions = {}): PriFixture => {
  const magic = options.magic ?? "mrm_pri2";
  const resources = options.resources ?? DEFAULT_RESOURCES;
  const decision = buildDecisionInfo(resources, magic);
  const schema = buildSchema(
    [
      ...resources.map(({ name }) => name),
      ...(options.namesWithoutCandidates ?? []),
    ],
    options.schema === "unicode",
  );
  const values = placeValues(resources, magic);
  const map = buildMap(options, resources, decision.decisionOf, values);
  const dataItems = buildDataItems(values.strings, values.blobs);
  const framed = frame(magic, [
    { identifier: "[mrm_decn_info]\0", content: decision.content },
    { identifier: "[mrm_pridescex]\0", content: buildDescriptor(magic) },
    {
      identifier:
        options.schema === "unicode" ? "[mrm_hschema]  \0" : "[mrm_hschemaex] ",
      content: schema.content,
    },
    {
      identifier:
        options.mapVersion === 1 ? "[mrm_res_map__]\0" : "[mrm_res_map2_]\0",
      content: map.content,
    },
    ...(magic === "mrm_pri0"
      ? []
      : [{ identifier: "[mrm_dataitem] \0", content: dataItems.content }]),
    ...(options.extraSections ?? []),
  ]);
  const at = (index: number, offsets: Readonly<Record<string, number>>) =>
    Object.fromEntries(
      Object.entries(offsets).map(([key, offset]) => [
        key,
        (framed.sections[index]?.content ?? 0) + offset,
      ]),
    );
  return {
    ...framed,
    decision: at(0, decision.offsets) as PriFixture["decision"],
    schema: at(2, schema.offsets) as PriFixture["schema"],
    map: at(3, map.offsets) as PriFixture["map"],
    dataItems: at(4, dataItems.offsets) as PriFixture["dataItems"],
  };
};
