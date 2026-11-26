import type { Element } from "@xmldom/xmldom";
import {
  decodeLimit,
  malformedInput,
  type ParseFailureError,
} from "../parseFailure.js";
import { err, ok, type Result } from "../result.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import {
  parseXmlDocumentWithinNodeLimit,
  xmlChildrenNamed,
  xmlFirstChildNamed,
} from "../xmlDocument.js";
import {
  DEFAULT_LITERAL_POOL_MAX_SVD_XML_NODES,
  type FirmwareLiteralPoolIsa,
  type LiteralPoolAttributionBasis,
  type LiteralPoolRegionKind,
} from "./firmwareLiteralPools.js";

export interface SvdAddressInterval {
  readonly name: string;
  readonly peripheralBase: number;
  readonly startAddress: number;
  readonly endAddress: number;
}

export interface SvdDisjointSegment {
  readonly startAddress: number;
  readonly endAddress: number;
  /** Null when two distinct peripherals declare equal-width overlapping blocks. */
  readonly match: {
    readonly name: string;
    readonly baseAddress: number;
  } | null;
}

export interface SvdPeripheralProfile {
  readonly peripheralCount: number;
  readonly intervals: readonly SvdAddressInterval[];
  readonly segments: readonly SvdDisjointSegment[];
}

export const EMPTY_SVD_PERIPHERAL_PROFILE: SvdPeripheralProfile = Object.freeze(
  {
    peripheralCount: 0,
    intervals: [],
    segments: [],
  },
);

export type SvdPeripheralParseError =
  | ParseFailureError<"malformed">
  | ParseFailureError<"unsupported">
  | ParseFailureError<"limit">;

export interface ConstantClassification {
  readonly regionKind: LiteralPoolRegionKind;
  readonly basis: LiteralPoolAttributionBasis;
  readonly architecturalBlock: string | null;
  readonly svdPeripheral: string | null;
  readonly svdRegisterOffset: string | null;
  readonly mmioBaseAddress: number | null;
}

interface RelativeInterval {
  readonly offset: number;
  readonly size: number;
}

interface RawSvdPeripheral {
  readonly name: string;
  readonly baseAddress: number;
  readonly derivedFrom: string | null;
  readonly ownIntervals: readonly RelativeInterval[];
}

const CLASSIFICATION_CACHE_CAPACITY = 65_536;

export const formatHex32 = (value: number): string =>
  `0x${(value >>> 0).toString(16).padStart(8, "0")}`;

export const formatHexCompact = (value: number): string =>
  `0x${(value >>> 0).toString(16)}`;

const trimmedText = (element: Element | undefined): string | null => {
  if (element === undefined) return null;
  const text = (element.textContent ?? "").trim();
  return text.length > 0 ? `${text}` : null;
};

const parseUnsigned32 = (raw: string): number | null => {
  const normalized = raw.trim();
  const parsed = /^0x[0-9a-fA-F]+$/u.test(normalized)
    ? Number.parseInt(normalized.slice(2), 16)
    : /^[0-9]+$/u.test(normalized)
      ? Number.parseInt(normalized, 10)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    return null;
  }
  return parsed;
};

const extractAddressBlockIntervals = (
  peripheralEl: Element,
): RelativeInterval[] => {
  const blocks: RelativeInterval[] = [];
  for (const block of xmlChildrenNamed(peripheralEl, "addressBlock")) {
    const usage = (
      trimmedText(xmlFirstChildNamed(block, "usage")) ?? ""
    ).toLowerCase();
    if (usage === "reserved") continue;
    const offsetText = trimmedText(xmlFirstChildNamed(block, "offset"));
    const sizeText = trimmedText(xmlFirstChildNamed(block, "size"));
    if (offsetText === null || sizeText === null) continue;
    const blockOffset = parseUnsigned32(offsetText);
    const blockSize = parseUnsigned32(sizeText);
    if (blockOffset === null || blockSize === null || blockSize === 0) continue;
    blocks.push({ offset: blockOffset, size: blockSize });
  }
  return blocks;
};

const registerByteSize = (
  regEl: Element,
  defaultBitWidth: number | null,
): number | null => {
  const ownSizeText = trimmedText(xmlFirstChildNamed(regEl, "size"));
  const bitWidth =
    ownSizeText !== null ? parseUnsigned32(ownSizeText) : defaultBitWidth;
  if (bitWidth === null || bitWidth === 0) return null;
  const singleBytes = Math.ceil(bitWidth / 8);
  const dimText = trimmedText(xmlFirstChildNamed(regEl, "dim"));
  if (dimText === null) return singleBytes;
  const dim = parseUnsigned32(dimText);
  const incText = trimmedText(xmlFirstChildNamed(regEl, "dimIncrement"));
  const inc = incText !== null ? parseUnsigned32(incText) : singleBytes;
  if (dim === null || dim === 0 || inc === null || inc === 0)
    return singleBytes;
  return (dim - 1) * inc + singleBytes;
};

const extractRegisterIntervals = (
  peripheralEl: Element,
  deviceDefaultBits: number | null,
): RelativeInterval[] => {
  const registersEl = xmlFirstChildNamed(peripheralEl, "registers");
  if (registersEl === undefined) return [];
  const periphSizeText = trimmedText(xmlFirstChildNamed(peripheralEl, "size"));
  const defaultBits =
    periphSizeText !== null
      ? parseUnsigned32(periphSizeText)
      : deviceDefaultBits;
  const intervals: RelativeInterval[] = [];
  for (const regEl of xmlChildrenNamed(registersEl, "register")) {
    const offsetText = trimmedText(xmlFirstChildNamed(regEl, "addressOffset"));
    if (offsetText === null) continue;
    const offset = parseUnsigned32(offsetText);
    const size = registerByteSize(regEl, defaultBits);
    if (offset === null || size === null || size === 0) continue;
    intervals.push({ offset, size });
  }
  return intervals;
};

const resolvePeripheralIntervals = (
  name: string,
  byName: ReadonlyMap<string, RawSvdPeripheral>,
  visiting: Set<string>,
  memo: Map<string, readonly RelativeInterval[]>,
): readonly RelativeInterval[] => {
  const cached = memo.get(name);
  if (cached !== undefined) return cached;
  const entry = byName.get(name);
  if (entry === undefined) return [];
  if (entry.ownIntervals.length > 0) {
    memo.set(name, entry.ownIntervals);
    return entry.ownIntervals;
  }
  if (entry.derivedFrom === null || visiting.has(name)) return [];
  visiting.add(name);
  const inherited = resolvePeripheralIntervals(
    entry.derivedFrom,
    byName,
    visiting,
    memo,
  );
  visiting.delete(name);
  memo.set(name, inherited);
  return inherited;
};

interface HeapItem {
  readonly name: string;
  readonly peripheralBase: number;
  readonly endAddress: number;
  readonly span: number;
}

const compareHeapItems = (a: HeapItem, b: HeapItem): number =>
  a.span - b.span || compareUnicodeCodePoints(a.name, b.name);

class MinSpanHeap {
  readonly #items: HeapItem[] = [];

  get size(): number {
    return this.#items.length;
  }

  peek(): HeapItem | undefined {
    return this.#items[0];
  }

  push(item: HeapItem): void {
    this.#items.push(item);
    let idx = this.#items.length - 1;
    while (idx > 0) {
      const parent = (idx - 1) >>> 1;
      if (compareHeapItems(this.#items[idx]!, this.#items[parent]!) >= 0) break;
      const tmp = this.#items[parent]!;
      this.#items[parent] = this.#items[idx]!;
      this.#items[idx] = tmp;
      idx = parent;
    }
  }

  pop(): HeapItem | undefined {
    if (this.#items.length === 0) return undefined;
    const top = this.#items[0]!;
    const last = this.#items.pop()!;
    if (this.#items.length > 0) {
      this.#items[0] = last;
      this.#siftDown(0);
    }
    return top;
  }

  #siftDown(start: number): void {
    let idx = start;
    const len = this.#items.length;
    while (true) {
      const left = idx * 2 + 1;
      const right = left + 1;
      let smallest = idx;
      if (
        left < len &&
        compareHeapItems(this.#items[left]!, this.#items[smallest]!) < 0
      ) {
        smallest = left;
      }
      if (
        right < len &&
        compareHeapItems(this.#items[right]!, this.#items[smallest]!) < 0
      ) {
        smallest = right;
      }
      if (smallest === idx) break;
      const tmp = this.#items[idx]!;
      this.#items[idx] = this.#items[smallest]!;
      this.#items[smallest] = tmp;
      idx = smallest;
    }
  }
}

const activeSegmentMatch = (
  heap: MinSpanHeap,
  segStart: number,
): SvdDisjointSegment["match"] | "empty" => {
  while (heap.peek() !== undefined && heap.peek()!.endAddress <= segStart) {
    heap.pop();
  }
  const first = heap.pop();
  if (first === undefined) return "empty";
  while (
    heap.peek() !== undefined &&
    (heap.peek()!.endAddress <= segStart || heap.peek()!.name === first.name)
  ) {
    if (heap.peek()!.endAddress <= segStart) {
      heap.pop();
    } else {
      // Duplicate block from the same peripheral with identical or wider span.
      break;
    }
  }
  const second = heap.peek();
  heap.push(first);
  if (
    second !== undefined &&
    second.name !== first.name &&
    second.span === first.span
  ) {
    return null;
  }
  return { name: first.name, baseAddress: first.peripheralBase };
};

const buildDisjointSegments = (
  intervals: readonly SvdAddressInterval[],
): SvdDisjointSegment[] => {
  if (intervals.length === 0) return [];
  const sortedStarts = [...intervals].sort(
    (a, b) => a.startAddress - b.startAddress || a.endAddress - b.endAddress,
  );
  const coords = new Set<number>();
  for (const iv of sortedStarts) {
    coords.add(iv.startAddress);
    coords.add(iv.endAddress);
  }
  const points = [...coords].sort((a, b) => a - b);
  const heap = new MinSpanHeap();
  const segments: SvdDisjointSegment[] = [];
  let ivIndex = 0;

  for (let i = 0; i + 1 < points.length; i += 1) {
    const segStart = points[i]!;
    const segEnd = points[i + 1]!;
    while (
      ivIndex < sortedStarts.length &&
      sortedStarts[ivIndex]!.startAddress <= segStart
    ) {
      const iv = sortedStarts[ivIndex]!;
      if (iv.endAddress > segStart) {
        heap.push({
          name: iv.name,
          peripheralBase: iv.peripheralBase,
          endAddress: iv.endAddress,
          span: iv.endAddress - iv.startAddress,
        });
      }
      ivIndex += 1;
    }
    const match = activeSegmentMatch(heap, segStart);
    if (match === "empty") continue;
    const prev = segments[segments.length - 1];
    const sameMatch =
      prev !== undefined &&
      prev.endAddress === segStart &&
      ((prev.match === null && match === null) ||
        (prev.match !== null &&
          match !== null &&
          prev.match.name === match.name &&
          prev.match.baseAddress === match.baseAddress));
    if (sameMatch && prev !== undefined) {
      segments[segments.length - 1] = {
        startAddress: prev.startAddress,
        endAddress: segEnd,
        match: prev.match,
      };
    } else {
      segments.push({ startAddress: segStart, endAddress: segEnd, match });
    }
  }
  return segments;
};

/** Parse CMSIS-SVD `<peripheral>` address blocks and multi-hop `derivedFrom` chains. */
export const parseSvdPeripheralSpans = (
  svdXml: string,
  maxSvdNodes: number = DEFAULT_LITERAL_POOL_MAX_SVD_XML_NODES,
): Result<SvdPeripheralProfile, SvdPeripheralParseError> => {
  const docResult = parseXmlDocumentWithinNodeLimit(svdXml, {
    maximumNodes: maxSvdNodes,
    lineEndings: "normalize",
  });
  if (!docResult.ok) {
    const failure = docResult.error;
    if ("kind" in failure && failure.kind === "node-limit") {
      return err(
        decodeLimit(
          "cmsis-svd",
          `svd_xml exceeded the ${String(failure.maximum)}-node XML budget`,
          { name: "max_svd_nodes", maximum: failure.maximum },
        ),
      );
    }
    return err(failure);
  }

  const root = docResult.value.documentElement;
  if (root === null || root.localName !== "device") {
    return err(
      malformedInput("cmsis-svd", "CMSIS-SVD root element must be <device>."),
    );
  }

  const peripheralsEl = xmlFirstChildNamed(root, "peripherals");
  if (peripheralsEl === undefined) return ok(EMPTY_SVD_PERIPHERAL_PROFILE);

  const devSizeText = trimmedText(xmlFirstChildNamed(root, "size"));
  const deviceDefaultBits =
    devSizeText !== null ? parseUnsigned32(devSizeText) : null;

  const rawEntries: RawSvdPeripheral[] = [];
  const byName = new Map<string, RawSvdPeripheral>();

  for (const periphEl of xmlChildrenNamed(peripheralsEl, "peripheral")) {
    const name = trimmedText(xmlFirstChildNamed(periphEl, "name"));
    const baseText = trimmedText(xmlFirstChildNamed(periphEl, "baseAddress"));
    if (name === null || baseText === null) continue;
    const baseAddress = parseUnsigned32(baseText);
    if (baseAddress === null) continue;
    const rawDerived = periphEl.getAttribute("derivedFrom") as string | null;
    const derivedAttr = (rawDerived ?? "").trim();
    const derivedFrom = derivedAttr.length > 0 ? derivedAttr : null;
    const blockIntervals = extractAddressBlockIntervals(periphEl);
    const ownIntervals =
      blockIntervals.length > 0
        ? blockIntervals
        : extractRegisterIntervals(periphEl, deviceDefaultBits);
    const entry: RawSvdPeripheral = {
      name,
      baseAddress,
      derivedFrom,
      ownIntervals,
    };
    rawEntries.push(entry);
    byName.set(name, entry);
  }

  const memo = new Map<string, readonly RelativeInterval[]>();
  const visiting = new Set<string>();
  const intervals: SvdAddressInterval[] = [];

  for (const entry of rawEntries) {
    const relList = resolvePeripheralIntervals(
      entry.name,
      byName,
      visiting,
      memo,
    );
    for (const rel of relList) {
      const startAddress = entry.baseAddress + rel.offset;
      if (startAddress >= 0x1_0000_0000) continue;
      const endAddress = Math.min(0x1_0000_0000, startAddress + rel.size);
      if (endAddress <= startAddress) continue;
      intervals.push({
        name: entry.name,
        peripheralBase: entry.baseAddress,
        startAddress,
        endAddress,
      });
    }
  }

  return ok({
    peripheralCount: rawEntries.length,
    intervals,
    segments: buildDisjointSegments(intervals),
  });
};

const CORTEX_M_EXACT_REGISTERS: ReadonlyMap<number, string> = new Map([
  [0xe000_ed08, "SCB.VTOR"],
  [0xe000_ed0c, "SCB.AIRCR"],
  [0xe000_ed88, "SCB.CPACR"],
]);

/** Architecturally defined ARMv7-M / ARMv8-M PPB & SCS register blocks; reserved gaps stay unnamed. */
const CORTEX_M_PPB_RANGES: readonly {
  readonly start: number;
  readonly end: number;
  readonly name: string;
}[] = [
  { start: 0xe000_0000, end: 0xe000_0fff, name: "ITM" },
  { start: 0xe000_1000, end: 0xe000_1fff, name: "DWT" },
  { start: 0xe000_2000, end: 0xe000_2fff, name: "FPB" },
  { start: 0xe000_e004, end: 0xe000_e00f, name: "SCB" },
  { start: 0xe000_e010, end: 0xe000_e01f, name: "SysTick" },
  { start: 0xe000_e100, end: 0xe000_e13f, name: "NVIC" },
  { start: 0xe000_e180, end: 0xe000_e1bf, name: "NVIC" },
  { start: 0xe000_e200, end: 0xe000_e23f, name: "NVIC" },
  { start: 0xe000_e280, end: 0xe000_e2bf, name: "NVIC" },
  { start: 0xe000_e300, end: 0xe000_e33f, name: "NVIC" },
  { start: 0xe000_e380, end: 0xe000_e3bf, name: "NVIC" },
  { start: 0xe000_e400, end: 0xe000_e5ef, name: "NVIC" },
  { start: 0xe000_ed00, end: 0xe000_ed8f, name: "SCB" },
  { start: 0xe000_ed90, end: 0xe000_edbb, name: "MPU" },
  { start: 0xe000_edc0, end: 0xe000_edc7, name: "MPU" },
  { start: 0xe000_edd0, end: 0xe000_ede3, name: "SAU" },
  { start: 0xe000_edf0, end: 0xe000_edff, name: "CoreDebug" },
  { start: 0xe000_ef00, end: 0xe000_ef03, name: "NVIC" },
  { start: 0xe000_ef34, end: 0xe000_ef4b, name: "FPU" },
  { start: 0xe000_ef50, end: 0xe000_ef7b, name: "SCB" },
  { start: 0xe004_0000, end: 0xe004_0fff, name: "TPIU" },
  { start: 0xe004_1000, end: 0xe004_1fff, name: "ETM" },
];

const classifyCortexMPpbBlock = (value: number): string | null => {
  const exact = CORTEX_M_EXACT_REGISTERS.get(value);
  if (exact !== undefined) return exact;
  let low = 0;
  let high = CORTEX_M_PPB_RANGES.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const range = CORTEX_M_PPB_RANGES[mid]!;
    if (value < range.start) {
      high = mid - 1;
    } else if (value > range.end) {
      low = mid + 1;
    } else {
      return range.name;
    }
  }
  return null;
};

export const findSvdMatch = (
  value: number,
  svdProfile: SvdPeripheralProfile,
): { readonly name: string; readonly baseAddress: number } | undefined => {
  const segments = svdProfile.segments;
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const seg = segments[mid]!;
    if (value < seg.startAddress) {
      high = mid - 1;
    } else if (value >= seg.endAddress) {
      low = mid + 1;
    } else {
      return seg.match ?? undefined;
    }
  }
  return undefined;
};

const nonMmioClassification = (
  regionKind: LiteralPoolRegionKind,
  basis: LiteralPoolAttributionBasis,
): ConstantClassification => ({
  regionKind,
  basis,
  architecturalBlock: null,
  svdPeripheral: null,
  svdRegisterOffset: null,
  mmioBaseAddress: null,
});

const classifyExplicitSvdMatch = (
  u32: number,
  isa: FirmwareLiteralPoolIsa,
  svdMatch: { readonly name: string; readonly baseAddress: number },
): ConstantClassification => {
  const svdRegisterOffset = formatHexCompact(u32 - svdMatch.baseAddress);
  if (isa === "arm-thumb" && u32 >= 0xe000_0000 && u32 <= 0xe00f_ffff) {
    return {
      regionKind: "cortex_m_ppb_scs",
      basis: "explicit_profile",
      architecturalBlock: classifyCortexMPpbBlock(u32),
      svdPeripheral: svdMatch.name,
      svdRegisterOffset,
      mmioBaseAddress: svdMatch.baseAddress,
    };
  }
  const regionKind: LiteralPoolRegionKind =
    isa === "arm-thumb"
      ? "cortex_m_peripheral"
      : isa === "xtensa"
        ? "esp_peripheral"
        : "svd_peripheral";
  return {
    regionKind,
    basis: "explicit_profile",
    architecturalBlock: null,
    svdPeripheral: svdMatch.name,
    svdRegisterOffset,
    mmioBaseAddress: svdMatch.baseAddress,
  };
};

const classifyThumbArchitecturalFallback = (
  u32: number,
): ConstantClassification | null => {
  const fallbackPage = (u32 & 0xffff_f000) >>> 0;
  if (u32 >= 0xe000_0000 && u32 <= 0xe00f_ffff) {
    return {
      regionKind: "cortex_m_ppb_scs",
      basis: "architecture_manual",
      architecturalBlock: classifyCortexMPpbBlock(u32),
      svdPeripheral: null,
      svdRegisterOffset: null,
      mmioBaseAddress: fallbackPage,
    };
  }
  if (u32 >= 0x4000_0000 && u32 <= 0x5fff_ffff) {
    return {
      regionKind: "cortex_m_peripheral",
      basis: "address_map_convention",
      architecturalBlock: null,
      svdPeripheral: null,
      svdRegisterOffset: null,
      mmioBaseAddress: fallbackPage,
    };
  }
  if (u32 >= 0x2000_0000 && u32 <= 0x3fff_ffff) {
    return nonMmioClassification("cortex_m_sram", "address_map_convention");
  }
  return null;
};

const classifyXtensaArchitecturalFallback = (
  u32: number,
): ConstantClassification | null => {
  const isEspPeriphBus =
    (u32 >= 0x3ff0_0000 && u32 <= 0x3ff7_ffff) ||
    (u32 >= 0x6000_0000 && u32 <= 0x600f_ffff);
  if (isEspPeriphBus) {
    return {
      regionKind: "esp_peripheral",
      basis: "address_map_convention",
      architecturalBlock: null,
      svdPeripheral: null,
      svdRegisterOffset: null,
      mmioBaseAddress: (u32 & 0xffff_f000) >>> 0,
    };
  }
  if (u32 >= 0x3ff8_0000 && u32 <= 0x3fff_ffff) {
    return nonMmioClassification("esp_sram_rtc", "address_map_convention");
  }
  return null;
};

const isWithinMappedImage = (
  value: number,
  isa: FirmwareLiteralPoolIsa,
  baseAddress: number,
  fileBytes: number,
): boolean => {
  const candidate = isa === "arm-thumb" ? (value & ~1) >>> 0 : value >>> 0;
  const start = BigInt(baseAddress >>> 0);
  const end = start + BigInt(fileBytes);
  const target = BigInt(candidate);
  return target >= start && target < end;
};

/** Classify a 32-bit literal-pool constant by SVD profile, mapped bounds, and ISA memory map. */
export const classifyLoadedConstant = (options: {
  readonly value: number;
  readonly isa: FirmwareLiteralPoolIsa;
  readonly baseAddress: number;
  readonly fileBytes: number;
  readonly svdProfile: SvdPeripheralProfile;
}): ConstantClassification => {
  const u32 = options.value >>> 0;
  const svdMatch = findSvdMatch(u32, options.svdProfile);
  if (svdMatch !== undefined) {
    return classifyExplicitSvdMatch(u32, options.isa, svdMatch);
  }
  if (
    isWithinMappedImage(
      u32,
      options.isa,
      options.baseAddress,
      options.fileBytes,
    )
  ) {
    return nonMmioClassification("mapped_image", "observed_bounds");
  }
  if (options.isa === "arm-thumb") {
    const thumbMatch = classifyThumbArchitecturalFallback(u32);
    if (thumbMatch !== null) return thumbMatch;
  } else if (options.isa === "xtensa") {
    const xtensaMatch = classifyXtensaArchitecturalFallback(u32);
    if (xtensaMatch !== null) return xtensaMatch;
  }
  return nonMmioClassification("other", "unclassified");
};

/** Create a bounded per-scan memoizing constant classifier. */
export const createConstantClassifier = (context: {
  readonly isa: FirmwareLiteralPoolIsa;
  readonly baseAddress: number;
  readonly fileBytes: number;
  readonly svdProfile: SvdPeripheralProfile;
}): ((value: number) => ConstantClassification) => {
  const cache = new Map<number, ConstantClassification>();
  return (value: number): ConstantClassification => {
    const u32 = value >>> 0;
    const hit = cache.get(u32);
    if (hit !== undefined) return hit;
    const computed = classifyLoadedConstant({
      value: u32,
      isa: context.isa,
      baseAddress: context.baseAddress,
      fileBytes: context.fileBytes,
      svdProfile: context.svdProfile,
    });
    if (cache.size >= CLASSIFICATION_CACHE_CAPACITY) cache.clear();
    cache.set(u32, computed);
    return computed;
  };
};
