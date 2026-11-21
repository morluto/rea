import { RasterCoverageIndex } from "./rasterCoverage.js";
import { BinaryReader } from "./binaryContainer.js";
import { MAX_RASTER_LOGICAL_SEGMENTS } from "./rasterLogicalSegments.js";
import {
  DEFAULT_STRUCTURED_RASTER_GRAMMAR,
  type StructuredRasterRange,
  type StructuredRasterReport,
  type StructuredRasterTable,
} from "./structuredRasterDiscovery.js";

export interface RasterRegistryBinding {
  descriptorOffset: number;
  format: number;
  width: number;
  height: number;
  layout: "indexed1" | "indexed2" | "indexed4" | "indexed8" | "rgb565le";
  bitsPerPixel: 1 | 2 | 4 | 8 | 16;
  offsetUnit: 1 | 2;
  stride: number;
  payloadRange: StructuredRasterRange;
  lookupRange: StructuredRasterRange | null;
  rowOrder: "bottom-up";
  bitOrder: "msb-first";
  provenance: "profile-declared";
}
export interface RasterRegistryRow {
  range: StructuredRasterRange;
  tableRange: StructuredRasterRange;
  recordCount: number;
  countSource: "static-u16" | "enclosed-dynamic";
  countRange: StructuredRasterRange | null;
  dynamicOwnerRange: StructuredRasterRange | null;
}
export interface RasterRegistryCandidate {
  range: StructuredRasterRange;
  pointerBias: number;
  rows: RasterRegistryRow[];
  bindings: RasterRegistryBinding[];
  bindingStatus: "unique" | "conflicting";
  palettePointerRange: StructuredRasterRange | null;
  palettes: { slot: number; range: StructuredRasterRange }[];
}
export interface RasterRegistryFamilyReport {
  family: "record12-lut-registry";
  provenance: "profile-declared";
  status: "unsupported" | "unique" | "ambiguous";
  registries: RasterRegistryCandidate[];
  coverage: {
    complete: boolean;
    work: number;
    maxWork: number;
    reason: "work-limit" | "row-limit" | "binding-limit" | null;
    nextOffset: number | null;
    discoveryComplete: boolean;
  };
  limitations: string[];
}
export interface RasterRegistryFamilyOptions {
  maxWork?: number;
}
type FamilyCoverage = RasterRegistryFamilyReport["coverage"];
type Context = {
  bytes: Uint8Array;
  reader: BinaryReader;
  covered(offset: number, length: number): boolean;
  spend(at: number): boolean;
  stop(reason: NonNullable<FamilyCoverage["reason"]>, at: number): void;
  coverage: FamilyCoverage;
};
type Link = {
  at: number;
  bias: number;
  row: RasterRegistryRow;
  bindings: RasterRegistryBinding[];
};

const layouts = new Map<
  number,
  {
    layout: RasterRegistryBinding["layout"];
    bits: 1 | 2 | 4 | 8 | 16;
    unit: 1 | 2;
  }
>([
  [1, { layout: "indexed1", bits: 1, unit: 1 }],
  [2, { layout: "indexed2", bits: 2, unit: 1 }],
  [3, { layout: "indexed4", bits: 4, unit: 1 }],
  [4, { layout: "indexed8", bits: 8, unit: 1 }],
  [6, { layout: "rgb565le", bits: 16, unit: 2 }],
]);
function supportsGrammar(g: StructuredRasterReport["grammar"]): boolean {
  const d = DEFAULT_STRUCTURED_RASTER_GRAMMAR;
  return (
    g.recordStride === 12 &&
    g.endianness === "little" &&
    g.requireZeroReserved &&
    g.requireMonotonicOffsets &&
    g.payloadBase === "table-end" &&
    (["format", "width", "height", "payloadOffset", "reserved"] as const).every(
      (k) =>
        g.fields[k]?.offset === d.fields[k]?.offset &&
        g.fields[k]?.byteWidth === d.fields[k]?.byteWidth,
    )
  );
}
function validLookup(
  ctx: Context,
  range: StructuredRasterRange,
  at: number,
): boolean {
  if (!ctx.covered(range.offset, range.length)) return false;
  for (let i = 0; i < range.length; i += 2) {
    if (!ctx.spend(at)) return false;
    const value = ctx.reader.u16(range.offset + i);
    if (value > 255 && value !== 0x8000) return false;
  }
  return true;
}
function readBindings(
  ctx: Context,
  t: StructuredRasterTable,
  at: number,
  bias: number,
): RasterRegistryBinding[] | null {
  const shapes = new Map<number, string>(),
    bindings: RasterRegistryBinding[] = [];
  for (let i = 0; i < t.resources.length; i++) {
    if (!ctx.spend(at)) return null;
    const r = t.resources[i]!,
      definition = layouts.get(r.format),
      shape = `${r.format}:${r.width}:${r.height}`,
      old = shapes.get(r.payloadOffset);
    if (old !== undefined && old !== shape) return null;
    shapes.set(r.payloadOffset, shape);
    if (
      !definition ||
      r.descriptorOffset !== t.offset + i * 12 ||
      !ctx.covered(r.descriptorOffset, 12) ||
      !Number.isSafeInteger(r.width) ||
      !Number.isSafeInteger(r.height) ||
      r.width < 1 ||
      r.height < 1 ||
      r.width > 4096 ||
      r.height > 4096 ||
      !Number.isSafeInteger(r.payloadOffset) ||
      r.payloadOffset < 0
    )
      return null;
    const stride = Math.ceil((r.width * definition.bits) / 8),
      length = stride * r.height;
    const payloadRange = {
      offset: t.offset + t.length + r.payloadOffset * definition.unit,
      length,
    };
    if (!ctx.covered(payloadRange.offset, length)) return null;
    const lookupRange =
      r.format < 4
        ? {
            offset:
              ctx.reader.u32(at + r.format * 4) -
              bias +
              ctx.bytes[r.descriptorOffset + 1]! * (2 << definition.bits),
            length: 2 << definition.bits,
          }
        : null;
    if (lookupRange !== null && !validLookup(ctx, lookupRange, at)) return null;
    bindings.push({
      descriptorOffset: r.descriptorOffset,
      format: r.format,
      width: r.width,
      height: r.height,
      layout: definition.layout,
      bitsPerPixel: definition.bits,
      offsetUnit: definition.unit,
      stride,
      payloadRange,
      lookupRange,
      rowOrder: "bottom-up",
      bitOrder: "msb-first",
      provenance: "profile-declared",
    });
  }
  return bindings;
}
function readRow(
  ctx: Context,
  t: StructuredRasterTable,
  at: number,
  first: number,
): Link | null {
  const bias = first - t.offset,
    owner = ctx.reader.u32(at + 20),
    count = ctx.reader.u32(at + 24) - bias;
  if (
    owner === 0
      ? !ctx.covered(count, 2) || ctx.reader.u16(count) !== t.recordCount
      : !ctx.covered(owner - bias, 4)
  )
    return null;
  const bindings = readBindings(ctx, t, at, bias);
  if (bindings === null) return null;
  return {
    at,
    bias,
    bindings,
    row: {
      range: { offset: at, length: 28 },
      tableRange: { offset: t.offset, length: t.length },
      recordCount: t.recordCount,
      countSource: owner === 0 ? "static-u16" : "enclosed-dynamic",
      countRange: owner === 0 ? { offset: count, length: 2 } : null,
      dynamicOwnerRange:
        owner === 0 ? null : { offset: owner - bias, length: 4 },
    },
  };
}
function scanLinks(ctx: Context, tables: StructuredRasterTable[]): Link[] {
  const byLength = new Map<number, StructuredRasterTable[]>(),
    links: Link[] = [];
  for (const t of tables) {
    if (
      !ctx.covered(t.offset, t.length) ||
      t.length !== t.recordCount * 12 ||
      t.resources.length !== t.recordCount
    )
      continue;
    const list = byLength.get(t.length) ?? [];
    list.push(t);
    byLength.set(t.length, list);
  }
  let retainedBindings = 0;
  // Materialized zero may have any source alignment; the chain grid remains 28 bytes.
  for (let at = 0; at + 28 <= ctx.bytes.length; at++) {
    if (!ctx.spend(at)) break;
    if (!ctx.covered(at, 28)) continue;
    const first = ctx.reader.u32(at),
      end = ctx.reader.u32(at + 16);
    for (const t of byLength.get(end - first) ?? []) {
      if (!ctx.spend(at)) return links;
      const link = readRow(ctx, t, at, first);
      if (ctx.coverage.reason === "work-limit") return links;
      if (link === null) continue;
      if (links.length === 128) {
        ctx.stop("row-limit", at);
        return links;
      }
      if (retainedBindings + link.bindings.length > 4096) {
        ctx.stop("binding-limit", at);
        return links;
      }
      retainedBindings += link.bindings.length;
      links.push(link);
    }
  }
  return links;
}
function bindPalettes(ctx: Context, candidate: RasterRegistryCandidate): void {
  const base = candidate.range.offset - 72;
  if (!ctx.covered(base, 72)) return;
  const pointers: number[] = [];
  for (let i = 0; i < 9; i++) {
    if (!ctx.spend(base)) return;
    const p = ctx.reader.u32(base + i * 8),
      flag = ctx.reader.u32(base + i * 8 + 4);
    if (
      flag !== 1 ||
      (i === 8 ? p !== 0 : i >= 4 ? p !== pointers[i - 4] : false)
    )
      return;
    if (i < 4) pointers.push(p);
  }
  if (
    new Set(pointers).size !== 4 ||
    !pointers.every((p) => ctx.covered(p - candidate.pointerBias, 1024))
  )
    return;
  candidate.palettePointerRange = { offset: base, length: 72 };
  candidate.palettes = pointers.map((p, slot) => ({
    slot,
    range: { offset: p - candidate.pointerBias, length: 1024 },
  }));
}
function candidateFromRows(rows: Link[]): RasterRegistryCandidate {
  const first = rows[0]!,
    last = rows.at(-1)!,
    unique = new Map<number, RasterRegistryBinding>();
  let conflicting = false;
  for (const row of rows)
    for (const b of row.bindings) {
      const old = unique.get(b.descriptorOffset);
      if (old && JSON.stringify(old) !== JSON.stringify(b)) conflicting = true;
      else if (!old) unique.set(b.descriptorOffset, b);
    }
  return {
    range: { offset: first.at, length: last.at + 28 - first.at },
    pointerBias: first.bias,
    rows: rows.map((r) => r.row),
    bindings: conflicting ? [] : [...unique.values()],
    bindingStatus: conflicting ? "conflicting" : "unique",
    palettePointerRange: null,
    palettes: [],
  };
}
function groupRegistries(
  ctx: Context,
  links: Link[],
): RasterRegistryCandidate[] {
  const groups = new Map<string, Link[]>(),
    candidates: RasterRegistryCandidate[] = [];
  for (const link of links) {
    const key = `${link.bias}:${link.at % 28}`,
      list = groups.get(key) ?? [];
    list.push(link);
    groups.set(key, list);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.at - b.at);
    for (let start = 0; start < group.length;) {
      let end = start + 1;
      while (end < group.length && group[end]!.at === group[end - 1]!.at + 28)
        end++;
      const chain = group.slice(start, end),
        anchors = chain.filter((l) => l.row.countSource === "static-u16");
      start = end;
      if (anchors.length === 0) continue;
      const rows = chain.filter(
          (l) => l.at >= anchors[0]!.at && l.at <= anchors.at(-1)!.at,
        ),
        candidate = candidateFromRows(rows);
      bindPalettes(ctx, candidate);
      candidates.push(candidate);
    }
  }
  return candidates.sort(
    (a, b) => a.range.offset - b.range.offset || a.pointerBias - b.pointerBias,
  );
}
/** Explicit family post-pass, never automatic generic inference. Domain offsets
 * are relative to materialized bytes. Every scan position, table attempt,
 * descriptor and LUT entry spends separate family work. Retained alternatives
 * share 128 rows / 4096 bindings. No color, alpha or active theme is selected. */
export function discoverRasterRegistryFamily(
  bytes: Uint8Array,
  report: StructuredRasterReport,
  coverage: StructuredRasterRange[],
  options: RasterRegistryFamilyOptions = {},
  signal?: AbortSignal,
): RasterRegistryFamilyReport {
  signal?.throwIfAborted();
  const maxWork = options.maxWork ?? 10000000;
  if (
    bytes.length < 1 ||
    bytes.length > 16 * 1024 * 1024 ||
    coverage.length > MAX_RASTER_LOGICAL_SEGMENTS ||
    report.tables.length > 128 ||
    report.tables.reduce((n, t) => n + t.resources.length, 0) > 4096 ||
    !Number.isSafeInteger(maxWork) ||
    maxWork < 1 ||
    maxWork > 50000000
  )
    throw new RangeError("Invalid family input or work budget");
  const preparedCoverage = RasterCoverageIndex.prepare(bytes.length, coverage);
  if (!preparedCoverage.ok) throw new RangeError("Invalid family coverage");
  const covered = (offset: number, length: number) =>
    preparedCoverage.value.covers(offset, length);
  const result: RasterRegistryFamilyReport = {
    family: "record12-lut-registry",
    provenance: "profile-declared",
    status: "unsupported",
    registries: [],
    coverage: {
      complete: report.coverage.complete,
      work: 0,
      maxWork,
      reason: null,
      nextOffset: null,
      discoveryComplete: report.coverage.complete,
    },
    limitations: [
      "Explicit family declarations, not inferred original image identity. Structurally equivalent non-image registries and numerical palettes can pass.",
      "Tight rows, enums 1/2/3/4/6, bottom-up and MSB-first packing are profile-declared. Formats 0/5 and other unsupported records receive no family binding.",
      "Static count references are observed; dynamic counts are family assumptions admitted only between static anchors on the same contiguous bias/grid.",
      "Palette slots are alternatives, not active themes. No color precision, alpha, sentinel policy, key, runtime override or final composition is selected.",
      "Conflicting aliases and missing, unsupported or uncovered row members withhold family bindings. Generic observations remain unchanged; incomplete discovery does not prove absence.",
      "Family work is an independently bounded post-pass additional to generic discovery work. Every admitted source range requires complete coverage.",
    ],
  };
  if (!supportsGrammar(report.grammar)) return result;
  const stop = (reason: NonNullable<FamilyCoverage["reason"]>, at: number) => {
    result.coverage.complete = false;
    result.coverage.reason = reason;
    result.coverage.nextOffset = at;
  };
  const spend = (at: number) => {
    signal?.throwIfAborted();
    if (result.coverage.work === maxWork) {
      stop("work-limit", at);
      return false;
    }
    result.coverage.work++;
    return true;
  };
  const ctx: Context = {
    bytes,
    reader: new BinaryReader(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      true,
      "record12-lut-registry",
    ),
    covered,
    spend,
    stop,
    coverage: result.coverage,
  };
  result.registries = groupRegistries(ctx, scanLinks(ctx, report.tables));
  result.status =
    result.registries.length === 0
      ? "unsupported"
      : result.registries.length === 1 &&
          result.registries[0]!.bindingStatus === "unique"
        ? "unique"
        : "ambiguous";
  return result;
}
