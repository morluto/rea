import { ok, err, type Result } from "../result.js";

/**
 * USB HID Report Descriptor parser and domain model for peripheral reverse engineering.
 * Decodes raw HID descriptor bytes into structured collections, usage pages,
 * report IDs, and field layouts.
 */

export interface HidItem {
  readonly tag: number;
  readonly type: "main" | "global" | "local" | "long" | "reserved";
  readonly data: number;
  readonly byteLength: number;
}

export interface HidReportField {
  readonly usagePage: number;
  readonly usagePageHex: string;
  readonly usage: number | null;
  readonly usageHex: string | null;
  readonly usageMin: number | null;
  readonly usageMax: number | null;
  readonly reportSizeBits: number;
  readonly reportCount: number;
  readonly bitOffset: number;
  readonly bitLength: number;
}

export interface HidEndpointReport {
  readonly reportId: number | null;
  readonly reportType: "input" | "output" | "feature";
  readonly totalBits: number;
  readonly totalSizeBytes: number;
  readonly fields: readonly HidReportField[];
}

export interface ParsedHidDescriptor {
  readonly items: readonly HidItem[];
  readonly reports: readonly HidEndpointReport[];
  readonly vendorUsagePages: readonly string[];
}

export interface HidDescriptorFailure {
  readonly reason: string;
  readonly offset: number;
}

/** Human-readable names for standard USB HID Usage Pages. */
export const HID_USAGE_PAGE_NAMES: Record<number, string> = {
  0x01: "Generic Desktop Controls",
  0x02: "Simulation Controls",
  0x03: "VR Controls",
  0x04: "Sport Controls",
  0x05: "Game Controls",
  0x06: "Generic Device Controls",
  0x07: "Keyboard/Keypad",
  0x08: "LEDs",
  0x09: "Button",
  0x0c: "Consumer",
  0x0d: "Digitizers",
  0x0e: "Haptics",
};

interface HidGlobalState {
  usagePage: number;
  reportId: number | null;
  reportSize: number;
  reportCount: number;
}

interface HidLocalState {
  usages: number[];
  usageMin: number | null;
  usageMax: number | null;
}

interface MutableEndpointReport {
  reportId: number | null;
  reportType: "input" | "output" | "feature";
  totalBits: number;
  totalSizeBytes: number;
  fields: HidReportField[];
}

function handleGlobalItem(
  bTag: number,
  data: number,
  global: HidGlobalState,
  globalStack: HidGlobalState[],
  vendorUsagePages: Set<string>,
): void {
  switch (bTag) {
    case 0x00: // Usage Page
      global.usagePage = data;
      if (data >= 0xff00 && data <= 0xffff) {
        vendorUsagePages.add(`0x${data.toString(16).toUpperCase()}`);
      }
      break;
    case 0x07: // Report Size
      global.reportSize = data;
      break;
    case 0x08: // Report ID
      global.reportId = data;
      break;
    case 0x09: // Report Count
      global.reportCount = data;
      break;
    case 0x0a: // Push
      globalStack.push({ ...global });
      break;
    case 0x0b: // Pop
      if (globalStack.length > 0) {
        const popped = globalStack.pop();
        if (popped !== undefined) {
          Object.assign(global, popped);
        }
      }
      break;
  }
}

function handleLocalItem(
  bTag: number,
  data: number,
  local: HidLocalState,
): void {
  switch (bTag) {
    case 0x00: // Usage
      local.usages.push(data);
      break;
    case 0x01: // Usage Minimum
      local.usageMin = data;
      break;
    case 0x02: // Usage Maximum
      local.usageMax = data;
      break;
  }
}

function handleMainItem(
  bTag: number,
  global: HidGlobalState,
  local: HidLocalState,
  reportMap: Map<string, MutableEndpointReport>,
  reportsList: MutableEndpointReport[],
): void {
  if (bTag === 0x0a || bTag === 0x0c) {
    // Collection or End Collection: consumes active local usage
    local.usages = [];
    local.usageMin = null;
    local.usageMax = null;
    return;
  }

  if (bTag !== 0x08 && bTag !== 0x09 && bTag !== 0x0b) return;

  const reportType =
    bTag === 0x08 ? "input" : bTag === 0x09 ? "output" : "feature";
  const reportKey = `${String(global.reportId)}:${reportType}`;

  let report = reportMap.get(reportKey);
  if (!report) {
    report = {
      reportId: global.reportId,
      reportType,
      totalBits: 0,
      totalSizeBytes: 0,
      fields: [],
    };
    reportMap.set(reportKey, report);
    reportsList.push(report);
  }

  const bitLength = global.reportSize * global.reportCount;
  const bitOffset = report.totalBits;
  report.totalBits += bitLength;
  report.totalSizeBytes =
    Math.ceil(report.totalBits / 8) + (report.reportId !== null ? 1 : 0);

  report.fields.push({
    usagePage: global.usagePage,
    usagePageHex: `0x${global.usagePage.toString(16).toUpperCase()}`,
    usage: local.usages[0] ?? null,
    usageHex:
      local.usages[0] !== undefined
        ? `0x${local.usages[0].toString(16).toUpperCase()}`
        : null,
    usageMin: local.usageMin,
    usageMax: local.usageMax,
    reportSizeBits: global.reportSize,
    reportCount: global.reportCount,
    bitOffset,
    bitLength,
  });

  local.usages = [];
  local.usageMin = null;
  local.usageMax = null;
}

/** Parse raw USB HID Report Descriptor bytes. */
export function parseHidReportDescriptor(
  rawBytes: Uint8Array | readonly number[],
): Result<ParsedHidDescriptor, HidDescriptorFailure> {
  const bytes = Array.from(rawBytes);

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > 255) {
      return err({
        reason: `invalid byte value at index ${String(i)}: expected integer 0..255, got ${String(b)}`,
        offset: i,
      });
    }
  }

  const items: HidItem[] = [];
  const vendorUsagePages = new Set<string>();
  const reportMap = new Map<string, MutableEndpointReport>();
  const reportsList: MutableEndpointReport[] = [];
  const globalStack: HidGlobalState[] = [];

  const global: HidGlobalState = {
    usagePage: 0,
    reportId: null,
    reportSize: 0,
    reportCount: 0,
  };

  const local: HidLocalState = {
    usages: [],
    usageMin: null,
    usageMax: null,
  };

  let offset = 0;
  while (offset < bytes.length) {
    const itemStart = offset;
    const prefix = bytes[offset] ?? 0;
    offset++;

    // Long item: prefix 0xFE
    if (prefix === 0xfe) {
      if (offset + 2 > bytes.length) {
        return err({
          reason: `truncated long item header at offset ${String(itemStart)}`,
          offset: itemStart,
        });
      }
      const bDataSize = bytes[offset] ?? 0;
      offset++;
      const bLongItemTag = bytes[offset] ?? 0;
      offset++;
      if (offset + bDataSize > bytes.length) {
        return err({
          reason: `truncated long item payload at offset ${String(itemStart)}: expected ${String(bDataSize)} bytes`,
          offset: itemStart,
        });
      }
      offset += bDataSize;
      items.push({
        tag: bLongItemTag,
        type: "long",
        data: 0,
        byteLength: 3 + bDataSize,
      });
      continue;
    }

    const bSize = prefix & 0x03;
    const bType = (prefix >> 2) & 0x03;
    const bTag = (prefix >> 4) & 0x0f;
    const dataLength = bSize === 3 ? 4 : bSize;

    if (offset + dataLength > bytes.length) {
      return err({
        reason: `truncated item 0x${prefix.toString(16).toUpperCase().padStart(2, "0")} at offset ${String(itemStart)}: expected ${String(dataLength)} byte(s) but got ${String(bytes.length - offset)}`,
        offset: itemStart,
      });
    }

    let data = 0;
    for (let i = 0; i < dataLength; i++) {
      data = (data | ((bytes[offset] ?? 0) << (i * 8))) >>> 0;
      offset++;
    }

    const typeName =
      bType === 0
        ? "main"
        : bType === 1
          ? "global"
          : bType === 2
            ? "local"
            : "reserved";

    items.push({
      tag: bTag,
      type: typeName,
      data,
      byteLength: 1 + dataLength,
    });

    if (typeName === "global") {
      handleGlobalItem(bTag, data, global, globalStack, vendorUsagePages);
    } else if (typeName === "local") {
      handleLocalItem(bTag, data, local);
    } else if (typeName === "main") {
      handleMainItem(bTag, global, local, reportMap, reportsList);
    }
  }

  return ok({
    items,
    reports: reportsList,
    vendorUsagePages: Array.from(vendorUsagePages).sort(),
  });
}
