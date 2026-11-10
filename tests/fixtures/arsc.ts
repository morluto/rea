/** Synthetic Android compiled resource table (resources.arsc) builders. */

const u16 = (value: number): Buffer => {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
};
const u32 = (value: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
};

export interface ArscEntry {
  /** Key pool name; entry ids are assigned in array order. */
  readonly name: string;
  /** Typed [dataType, data] for a simple entry; omit for 0x10/0. */
  readonly typed?: readonly [number, number];
  /** Complex (bag) items: [nameResId, dataType, data]. */
  readonly items?: readonly (readonly [number, number, number])[];
  /** Parent res id emitted on complex entries. */
  readonly parent?: number;
}

export interface ArscType {
  /** Type pool name, e.g. "attr" or "string". */
  readonly name: string;
  readonly entries: readonly ArscEntry[];
  /** ResTable_config fields: [configSize, sdkVersion, density, language, region]. */
  readonly config?: {
    readonly size?: number;
    readonly sdk?: number;
    readonly density?: number;
    readonly language?: string;
    readonly region?: string;
  };
  /** SPEC_PUBLIC flags per entry index. */
  readonly public?: readonly number[];
}

export interface ArscOptions {
  readonly packageId?: number;
  readonly packageName?: string;
  /** Global value-pool strings a TYPE_STRING datum indexes into. */
  readonly values?: readonly string[];
  readonly types?: readonly ArscType[];
  /** Override the declared document size. */
  readonly declaredSize?: number;
  /** Drop the final byte count to this length (truncation). */
  readonly truncate?: number;
  /** Extra chunks appended after the package body. */
  readonly tailChunks?: readonly Buffer[];
}

const stringPoolChunk = (
  strings: readonly string[],
): { chunk: Buffer; index: Map<string, number> } => {
  const index = new Map<string, number>();
  strings.forEach((s, i) => index.set(s, i));
  const offsets: number[] = [];
  let cursor = 0;
  const encoded = strings.map((text) => {
    const body = Buffer.concat([
      u16(text.length),
      Buffer.from(text, "utf16le"),
      Buffer.alloc(2),
    ]);
    offsets.push(cursor);
    cursor += body.length;
    return body;
  });
  const headerSize = 28;
  const stringsStart = headerSize + strings.length * 4;
  const body = Buffer.concat([
    u32(strings.length),
    u32(0),
    u32(0),
    u32(stringsStart),
    u32(0),
    ...offsets.map(u32),
    ...encoded,
  ]);
  const chunk = Buffer.concat([
    u16(0x0001),
    u16(headerSize),
    u32(8 + body.length),
    body,
  ]);
  return { chunk, index };
};

const configBytes = (cfg: ArscType["config"]): Buffer => {
  const size = cfg?.size ?? 28;
  const out = Buffer.alloc(size);
  out.writeUInt32LE(size, 0);
  if (cfg?.language && cfg.language.length === 2) {
    out.writeUInt8(cfg.language.charCodeAt(0), 8);
    out.writeUInt8(cfg.language.charCodeAt(1), 9);
  }
  if (cfg?.region && cfg.region.length === 2) {
    out.writeUInt8(cfg.region.charCodeAt(0), 10);
    out.writeUInt8(cfg.region.charCodeAt(1), 11);
  }
  if (cfg?.density !== undefined && size >= 16)
    out.writeUInt16LE(cfg.density, 14);
  if (cfg?.sdk !== undefined && size >= 28) out.writeUInt16LE(cfg.sdk, 24);
  return out;
};

/**
 * Build a resources.arsc document: ResTable header, a global string pool
 * (TYPE_STRING values index into it), then one package carrying its type
 * and key pools plus a typeSpec/type chunk pair per declared type.
 */
export const buildArsc = (options: ArscOptions = {}): Buffer => {
  const packageId = options.packageId ?? 0x7f;
  const types = options.types ?? [];
  const { chunk: globalPool } = stringPoolChunk(options.values ?? []);

  const typeNames = types.map((t) => t.name);
  const { chunk: typePool, index: typeIndex } = stringPoolChunk(typeNames);
  const allKeys = types.flatMap((t) => t.entries.map((e) => e.name));
  const { chunk: keyPool, index: keyIndex } = stringPoolChunk(allKeys);

  const packageHeaderSize = 288;
  const typePoolAt = packageHeaderSize;
  const keyPoolAt = packageHeaderSize + typePool.length;

  const inner: Buffer[] = [];
  for (const t of types) {
    const typeId = (typeIndex.get(t.name) ?? 0) + 1;
    const specBody = Buffer.concat([
      Buffer.from([typeId, 0]),
      u16(0),
      u32(t.entries.length),
      ...t.entries.map((_, i) => u32(t.public?.[i] ?? 0)),
    ]);
    inner.push(
      Buffer.concat([u16(0x0202), u16(16), u32(8 + specBody.length), specBody]),
    );

    const cfg = configBytes(t.config);
    const typeHeaderSize = 20 + cfg.length;
    const entriesStart = typeHeaderSize + t.entries.length * 4;
    let entryCursor = 0;
    const offsets: Buffer[] = [];
    const entryBytes: Buffer[] = [];
    for (const e of t.entries) {
      offsets.push(u32(entryCursor));
      const key = keyIndex.get(e.name) ?? 0;
      if (e.items) {
        const maps = e.items.map(([name, dtype, data]) =>
          Buffer.concat([
            u32(name),
            u16(8),
            Buffer.from([0, dtype]),
            u32(data >>> 0),
          ]),
        );
        const header = Buffer.concat([
          u16(16),
          u16(1),
          u32(key),
          u32(e.parent ?? 0),
          u32(e.items.length),
        ]);
        const blob = Buffer.concat([header, ...maps]);
        entryBytes.push(blob);
        entryCursor += blob.length;
        continue;
      }
      const [dtype, data] = e.typed ?? [0x10, 0];
      const datum = data >>> 0;
      const blob = Buffer.concat([
        u16(8),
        u16(0),
        u32(key),
        u16(8),
        Buffer.from([0, dtype]),
        u32(datum),
      ]);
      entryBytes.push(blob);
      entryCursor += blob.length;
    }
    const typeBody = Buffer.concat([
      Buffer.from([typeId, 0]),
      u16(0),
      u32(t.entries.length),
      u32(entriesStart),
      cfg,
      ...offsets,
      ...entryBytes,
    ]);
    inner.push(
      Buffer.concat([
        u16(0x0201),
        u16(typeHeaderSize),
        u32(8 + typeBody.length),
        typeBody,
      ]),
    );
  }

  const name = Buffer.alloc(256);
  Buffer.from(options.packageName ?? "com.example.app", "utf16le").copy(name);
  const tails = options.tailChunks ?? [];
  const packageBody = Buffer.concat([
    u32(packageId),
    name,
    u32(typePoolAt),
    u32(typeNames.length),
    u32(keyPoolAt),
    u32(allKeys.length),
    u32(0),
  ]);
  const packageChunk = Buffer.concat([
    u16(0x0200),
    u16(packageHeaderSize),
    u32(
      packageHeaderSize +
        typePool.length +
        keyPool.length +
        inner.reduce((n, b) => n + b.length, 0) +
        tails.reduce((n, b) => n + b.length, 0),
    ),
    packageBody,
    typePool,
    keyPool,
    ...inner,
    ...tails,
  ]);

  const body = Buffer.concat([globalPool, packageChunk]);
  const declared = options.declaredSize ?? 12 + body.length;
  let file = Buffer.concat([u16(0x0002), u16(12), u32(declared), u32(1), body]);
  if (options.truncate !== undefined) file = file.subarray(0, options.truncate);
  return file;
};

/** A minimal table: attr + string type with simple, typed and bag entries. */
export const ARSC_BASIC_TYPES: readonly ArscType[] = [
  {
    name: "attr",
    entries: [
      { name: "versionCode", typed: [0x10, 3] },
      {
        name: "gravityBag",
        parent: 0x7f010001,
        items: [
          [0x01010000, 0x10, 0x11],
          [0x01010001, 0x12, 1],
        ],
      },
    ],
    public: [0x40000000, 0],
  },
  {
    name: "string",
    config: { sdk: 35, language: "en", region: "US", density: 480 },
    entries: [
      { name: "app_name", typed: [0x03, 0] },
      { name: "theme", typed: [0x01, 0x7f0d0001] },
    ],
  },
];

export const ARSC_BASIC_VALUES = ["Fanqie Novel"];
