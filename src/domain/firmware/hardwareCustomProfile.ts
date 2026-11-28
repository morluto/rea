import type { Element, Node } from "@xmldom/xmldom";
import { z } from "zod";
import type {
  BoardDeviceAttachment,
  BoardMemoryWindow,
} from "./boardPeripheralProfile.js";
import type { Devicetree } from "./devicetree.js";
import { firstKeyed, keyedBy, uniqueKeyed } from "../keyedCollection.js";
import { err, ok, type Result } from "../result.js";
import { parseXmlDocumentWithinNodeLimit } from "../xmlDocument.js";

export const CUSTOM_HARDWARE_SOURCES = [
  "devicetree",
  "cmsis_svd",
  "explicit",
] as const;
export type CustomHardwareSource = (typeof CUSTOM_HARDWARE_SOURCES)[number];

export interface CustomPeripheralRegister {
  readonly offset: bigint;
  readonly mnemonic: string;
  readonly name: string;
}

export interface CustomPeripheralAddressBlock {
  readonly offset: bigint;
  readonly sizeBytes: number;
}

export interface CustomPeripheralWindow {
  readonly name: string;
  readonly controllerId?: string | null;
  readonly baseAddress: string;
  readonly baseAddressValue: bigint;
  readonly sizeBytes: number;
  readonly addressBlocks?: readonly CustomPeripheralAddressBlock[];
  readonly bus: string | null;
  readonly compatible: readonly string[];
  readonly status: string | null;
  readonly registers: readonly CustomPeripheralRegister[];
}

export interface CustomDeviceControllerBinding {
  readonly deviceId: string;
  readonly controllerId: string;
}

export interface CustomHardwareProfile {
  readonly id: string;
  readonly sourceKind: CustomHardwareSource;
  readonly sourceSha256: string | null;
  readonly model: string | null;
  readonly memory: readonly BoardMemoryWindow[];
  readonly peripherals: readonly CustomPeripheralWindow[];
  readonly devices: readonly BoardDeviceAttachment[];
  readonly deviceBindings?: readonly CustomDeviceControllerBinding[];
  readonly limitations: readonly string[];
}

const customPeripheralRegisterSchema = z.strictObject({
  offset: z.bigint().nonnegative(),
  mnemonic: z.string().min(1),
  name: z.string().min(1),
});

const customPeripheralAddressBlockSchema = z.strictObject({
  offset: z.bigint().nonnegative(),
  sizeBytes: z.number().int().positive(),
});

const customPeripheralWindowSchema = z.strictObject({
  name: z.string().min(1),
  controllerId: z.string().nullable().optional(),
  baseAddress: z.string(),
  baseAddressValue: z.bigint().nonnegative(),
  sizeBytes: z.number().int().positive(),
  addressBlocks: z.array(customPeripheralAddressBlockSchema).optional(),
  bus: z.string().nullable(),
  compatible: z.array(z.string()),
  status: z.string().nullable(),
  registers: z.array(customPeripheralRegisterSchema),
});

export const customHardwareProfileSchema = z.strictObject({
  id: z.string().min(1),
  sourceKind: z.enum(CUSTOM_HARDWARE_SOURCES),
  sourceSha256: z.string().nullable(),
  model: z.string().nullable(),
  memory: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      kind: z.enum([
        "code",
        "sram",
        "peripheral_mmio",
        "external_device",
        "system_control",
        "reserved",
      ]),
      baseAddress: z.string(),
      baseAddressValue: z.bigint(),
      sizeBytes: z.number().int().positive(),
      evidence: z.string(),
    }),
  ),
  peripherals: z.array(customPeripheralWindowSchema),
  devices: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      kind: z.enum(["listed_resource", "bsp_option"]),
      peripheralName: z.string().nullable(),
      role: z.string(),
      kconfigDefault: z.boolean().nullable(),
      pins: z.array(z.string()),
      evidence: z.string(),
      uncertainty: z.string().optional(),
      partNames: z.array(z.string()).optional(),
    }),
  ),
  deviceBindings: z
    .array(
      z.strictObject({
        deviceId: z.string().min(1),
        controllerId: z.string().min(1),
      }),
    )
    .optional(),
  limitations: z.array(z.string()),
});

const SVD_REGISTER_PRECEDENCE =
  "CMSIS-SVD alternate registers may share an addressOffset; select primary declaration";
const FDT_PROPERTY_PRECEDENCE =
  "Devicetree specification v0.4 §2.2.4 requires unique property names per node; first declaration selected";

export type CustomPeripheralLookupResult =
  | {
      readonly kind: "matched";
      readonly peripheral: CustomPeripheralWindow;
      readonly register: CustomPeripheralRegister | null;
    }
  | {
      readonly kind: "ambiguous";
      readonly baseAddress: string;
      readonly baseAddressValue: bigint;
      readonly candidates: readonly CustomPeripheralWindow[];
    };

export const formatAmbiguousPeripheralCandidates = (
  candidates: readonly CustomPeripheralWindow[],
): readonly string[] => {
  const nameCounts = new Map<string, number>();
  const nameBusCounts = new Map<string, number>();
  for (const item of candidates) {
    nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1);
    const nameBusKey = `${item.name}\u0000${item.bus ?? ""}`;
    nameBusCounts.set(nameBusKey, (nameBusCounts.get(nameBusKey) ?? 0) + 1);
  }
  return candidates
    .map((item) => {
      if ((nameCounts.get(item.name) ?? 0) <= 1) return item.name;
      const nameBusKey = `${item.name}\u0000${item.bus ?? ""}`;
      if ((nameBusCounts.get(nameBusKey) ?? 0) <= 1 && item.bus !== null) {
        return `${item.name} (${item.bus})`;
      }
      if (item.controllerId && item.controllerId !== item.name) {
        return `${item.name} (${item.controllerId})`;
      }
      return item.bus !== null ? `${item.name} (${item.bus})` : item.name;
    })
    .sort();
};

const peripheralRegisterIndexCache = new WeakMap<
  CustomPeripheralWindow,
  ReturnType<typeof keyedBy<CustomPeripheralRegister, string>>
>();

const keyedPeripheralRegisters = (
  peripheral: CustomPeripheralWindow,
): ReturnType<typeof keyedBy<CustomPeripheralRegister, string>> => {
  const cached = peripheralRegisterIndexCache.get(peripheral);
  if (cached !== undefined) return cached;
  const built = keyedBy(peripheral.registers, (entry) =>
    entry.offset.toString(16),
  );
  peripheralRegisterIndexCache.set(peripheral, built);
  return built;
};

/**
 * Look up the most specific peripheral window and optional register offset in a
 * custom profile. When a parent bus/syscon window contains a smaller child
 * controller window, the narrower child window wins; equal-sized overlapping
 * windows return `kind: "ambiguous"` so MMIO semantics survive while controller
 * naming stays unresolved.
 */
export const lookupCustomPeripheral = (
  address: bigint,
  profile: CustomHardwareProfile,
): CustomPeripheralLookupResult | null => {
  const containing: {
    readonly peripheral: CustomPeripheralWindow;
    readonly matchedSize: number;
    readonly matchedStart: bigint;
  }[] = [];

  for (const peripheral of profile.peripherals) {
    const outerEnd = peripheral.baseAddressValue + BigInt(peripheral.sizeBytes);
    if (address < peripheral.baseAddressValue || address >= outerEnd) {
      continue;
    }
    if (peripheral.addressBlocks !== undefined) {
      let bestBlock: CustomPeripheralAddressBlock | undefined;
      for (const block of peripheral.addressBlocks) {
        const start = peripheral.baseAddressValue + block.offset;
        const end = start + BigInt(block.sizeBytes);
        if (address >= start && address < end) {
          if (
            bestBlock === undefined ||
            block.sizeBytes < bestBlock.sizeBytes
          ) {
            bestBlock = block;
          }
        }
      }
      if (bestBlock !== undefined) {
        containing.push({
          peripheral,
          matchedSize: bestBlock.sizeBytes,
          matchedStart: peripheral.baseAddressValue + bestBlock.offset,
        });
      }
      continue;
    }
    containing.push({
      peripheral,
      matchedSize: peripheral.sizeBytes,
      matchedStart: peripheral.baseAddressValue,
    });
  }
  if (containing.length === 0) return null;

  let minSize = containing[0]?.matchedSize ?? 0;
  for (const candidate of containing) {
    if (candidate.matchedSize < minSize) minSize = candidate.matchedSize;
  }
  const narrowest = containing.filter((item) => item.matchedSize === minSize);
  const selected = narrowest[0];
  if (selected === undefined) return null;
  if (narrowest.length > 1) {
    let baseAddressValue = selected.matchedStart;
    for (const item of narrowest) {
      if (item.matchedStart > baseAddressValue) {
        baseAddressValue = item.matchedStart;
      }
    }
    return {
      kind: "ambiguous",
      baseAddress: `0x${baseAddressValue.toString(16)}`,
      baseAddressValue,
      candidates: narrowest.map((item) => item.peripheral),
    };
  }

  const offset = address - selected.peripheral.baseAddressValue;
  const keyedRegs = keyedPeripheralRegisters(selected.peripheral);
  const register =
    firstKeyed(keyedRegs, offset.toString(16), SVD_REGISTER_PRECEDENCE) ?? null;
  return {
    kind: "matched",
    peripheral: selected.peripheral,
    register,
  };
};

interface RangeTuple {
  readonly childStart: bigint;
  readonly parentStart: bigint;
  readonly length: bigint;
}

type BusMapping =
  | { readonly kind: "identity" }
  | { readonly kind: "translated"; readonly tuples: readonly RangeTuple[] }
  | { readonly kind: "untranslated"; readonly reason: string }
  | { readonly kind: "device_bus" };

const UNSIGNED_INT_TEXT = /^(?:0x[0-9a-fA-F]+|\d+)$/u;
const MAX_NUMERIC_LITERAL_CHARS = 128;
const MAX_FDT_CELL_WIDTH = 4;
const MAX_FDT_RANGE_CELLS = 4096;
const MAX_FDT_DEPTH = 256;

const parseUnsignedBigInt = (raw: string | null): bigint | null => {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NUMERIC_LITERAL_CHARS) {
    return null;
  }
  if (!UNSIGNED_INT_TEXT.test(trimmed)) return null;
  try {
    const parsed = BigInt(trimmed);
    return parsed < 0n ? null : parsed;
  } catch {
    return null;
  }
};

const readUintCells = (
  cells: readonly number[],
  cellOffset: number,
  cellCount: number,
): bigint => {
  let value = 0n;
  for (let index = 0; index < cellCount; index += 1) {
    value = (value << 32n) | BigInt((cells[cellOffset + index] ?? 0) >>> 0);
  }
  return value;
};

const readHexCells = (
  hex: string,
  cellOffset: number,
  cellCount: number,
): bigint => {
  let value = 0n;
  for (let index = 0; index < cellCount; index += 1) {
    const start = (cellOffset + index) * 8;
    value = (value << 32n) | BigInt(`0x${hex.slice(start, start + 8)}`);
  }
  return value;
};

const nodeShortName = (path: string): string => {
  const leaf = path.split("/").at(-1) ?? path;
  const base = leaf.split("@")[0];
  return (base && base.length > 0 ? base : leaf).toUpperCase();
};

const nodeProperty = (
  node: Devicetree["nodes"][number],
  name: string,
): Devicetree["nodes"][number]["properties"][number] | undefined =>
  firstKeyed(
    keyedBy(node.properties, (prop) => prop.name),
    name,
    FDT_PROPERTY_PRECEDENCE,
  );

const validateAcyclicDevicetree = (
  nodes: Devicetree["nodes"],
  byPath: ReadonlyMap<string, Devicetree["nodes"][number]>,
): Result<void, string> => {
  const depthByPath = new Map<string, number>([["/", 0]]);
  for (const node of nodes) {
    if (node.path === "/") {
      if (node.parent !== null) {
        return err("Devicetree root node '/' must have a null parent");
      }
      continue;
    }
    if (node.parent === null) {
      return err(`Devicetree non-root node '${node.path}' is missing a parent`);
    }
    const chain: string[] = [node.path];
    const seen = new Set<string>([node.path]);
    let cursor: string | null = node.parent;
    let baseDepth = 0;
    while (cursor !== null) {
      const knownDepth = depthByPath.get(cursor);
      if (knownDepth !== undefined) {
        baseDepth = knownDepth;
        break;
      }
      if (seen.has(cursor)) {
        return err(
          `Devicetree contains a cyclic parent link involving '${node.path}'`,
        );
      }
      if (chain.length >= MAX_FDT_DEPTH) {
        return err(
          `Devicetree node '${node.path}' exceeds maximum depth ${MAX_FDT_DEPTH}`,
        );
      }
      seen.add(cursor);
      chain.push(cursor);
      const parentNode = byPath.get(cursor);
      if (parentNode === undefined) {
        return err(
          `Devicetree node '${node.path}' references missing parent '${cursor}'`,
        );
      }
      cursor = parentNode.parent;
    }
    for (let idx = chain.length - 1; idx >= 0; idx -= 1) {
      baseDepth += 1;
      if (baseDepth > MAX_FDT_DEPTH) {
        return err(
          `Devicetree node '${node.path}' exceeds maximum depth ${MAX_FDT_DEPTH}`,
        );
      }
      depthByPath.set(chain[idx]!, baseDepth);
    }
  }
  return ok(undefined);
};

const readFdtCellWidth = (
  node: Devicetree["nodes"][number] | undefined,
  name: string,
  fallback: number,
): number | null => {
  if (node === undefined) return fallback;
  const prop = nodeProperty(node, name);
  if (prop === undefined) return fallback;
  if (
    prop.bytes !== 4 ||
    prop.derived.cells === null ||
    prop.derived.cells.length !== 1
  ) {
    return null;
  }
  const width = prop.derived.cells[0]!;
  return width >= 0 && width <= MAX_FDT_CELL_WIDTH ? width : null;
};

const parseBusMapping = (
  node: Devicetree["nodes"][number],
  byPath: ReadonlyMap<string, Devicetree["nodes"][number]>,
): BusMapping => {
  if (node.path === "/") return { kind: "identity" };
  const ranges = nodeProperty(node, "ranges");
  if (ranges === undefined) return { kind: "device_bus" };
  if (ranges.bytes === 0) {
    return ranges.derived.cells !== null && ranges.derived.cells.length > 0
      ? {
          kind: "untranslated",
          reason: `ranges at ${node.path} has mismatched cell and byte counts.`,
        }
      : { kind: "identity" };
  }
  const cells = ranges.derived.cells;
  if (cells !== null && cells.length * 4 !== ranges.bytes) {
    return {
      kind: "untranslated",
      reason: `ranges at ${node.path} has mismatched cell and byte counts.`,
    };
  }
  if (
    cells === null &&
    (ranges.truncated ||
      ranges.hex.length < ranges.bytes * 2 ||
      !/^[0-9a-fA-F]*$/u.test(ranges.hex))
  ) {
    return {
      kind: "untranslated",
      reason: `ranges at ${node.path} exceeds 256-byte preview; child reg addresses were not mapped to CPU space.`,
    };
  }
  const childAddrCells = readFdtCellWidth(node, "#address-cells", 2);
  const childSizeCells = readFdtCellWidth(node, "#size-cells", 1);
  const parentNode = node.parent === null ? undefined : byPath.get(node.parent);
  const parentAddrCells = readFdtCellWidth(parentNode, "#address-cells", 2);
  if (
    childAddrCells === null ||
    childSizeCells === null ||
    parentAddrCells === null
  ) {
    return {
      kind: "untranslated",
      reason: `ranges at ${node.path} has unsupported cell widths.`,
    };
  }
  const tupleCells = childAddrCells + parentAddrCells + childSizeCells;
  const totalCells = cells !== null ? cells.length : ranges.bytes / 4;
  if (
    tupleCells === 0 ||
    childSizeCells === 0 ||
    totalCells > MAX_FDT_RANGE_CELLS ||
    ranges.bytes % (tupleCells * 4) !== 0 ||
    (cells !== null && cells.length % tupleCells !== 0)
  ) {
    return {
      kind: "untranslated",
      reason: `ranges at ${node.path} has unsupported cell widths.`,
    };
  }
  const tuples: RangeTuple[] = [];
  const readRangeCells = (offset: number, count: number): bigint =>
    cells !== null
      ? readUintCells(cells, offset, count)
      : readHexCells(ranges.hex, offset, count);
  for (let cell = 0; cell < totalCells; cell += tupleCells) {
    tuples.push({
      childStart: readRangeCells(cell, childAddrCells),
      parentStart: readRangeCells(cell + childAddrCells, parentAddrCells),
      length: readRangeCells(
        cell + childAddrCells + parentAddrCells,
        childSizeCells,
      ),
    });
  }
  return { kind: "translated", tuples };
};

const translateToCpuAddress = (
  startParentPath: string | null,
  rawAddress: bigint,
  rawSize: bigint,
  ctx: {
    readonly byPath: ReadonlyMap<string, Devicetree["nodes"][number]>;
    readonly mappings: ReadonlyMap<string, BusMapping>;
  },
): Result<bigint, "device_bus" | string> => {
  let currentPath = startParentPath;
  let currentAddr = rawAddress;
  while (currentPath !== null) {
    const mapping = ctx.mappings.get(currentPath);
    const busNode = ctx.byPath.get(currentPath);
    if (mapping === undefined || busNode === undefined) {
      return err(`Missing parent node ${currentPath}`);
    }
    if (mapping.kind === "device_bus") return err("device_bus");
    if (mapping.kind === "untranslated") return err(mapping.reason);
    if (mapping.kind === "translated") {
      let matchedTuple: RangeTuple | undefined;
      for (const tuple of mapping.tuples) {
        if (
          currentAddr >= tuple.childStart &&
          currentAddr + rawSize <= tuple.childStart + tuple.length
        ) {
          matchedTuple = tuple;
          break;
        }
      }
      if (matchedTuple === undefined) {
        return err(
          `Address 0x${currentAddr.toString(16)} is outside ranges of ${currentPath}.`,
        );
      }
      currentAddr =
        matchedTuple.parentStart + (currentAddr - matchedTuple.childStart);
    }
    currentPath = busNode.parent;
  }
  return ok(currentAddr);
};

const NON_MMIO_PREFIXES = [
  "/cpus",
  "/chosen",
  "/aliases",
  "/reserved-memory",
  "/__symbols__",
] as const;

/**
 * Build a dynamic hardware peripheral, memory, and child-device profile from a
 * parsed Flattened Devicetree (`Devicetree`), validating parent links and `reg`
 * encodings before translating bus `ranges`.
 */
export const hardwareProfileFromDevicetree = (
  dt: Devicetree,
): Result<CustomHardwareProfile, string> => {
  const byPath = new Map(dt.nodes.map((node) => [node.path, node]));
  const treeCheck = validateAcyclicDevicetree(dt.nodes, byPath);
  if (!treeCheck.ok) return treeCheck;

  const mappings = new Map(
    dt.nodes.map((node) => [node.path, parseBusMapping(node, byPath)]),
  );
  const memory: BoardMemoryWindow[] = [];
  const peripherals: CustomPeripheralWindow[] = [];
  const devices: BoardDeviceAttachment[] = [];
  const limitations = [...dt.limitations];
  const controllerNameByPath = new Map<string, string>();
  const deviceBindings: CustomDeviceControllerBinding[] = [];
  const pendingBusChildren: {
    readonly node: Devicetree["nodes"][number];
    readonly parentPath: string;
    readonly firstAddr: string;
    readonly compatible: readonly string[];
    readonly status: string | null;
  }[] = [];

  for (const node of dt.nodes) {
    if (
      node.path === "/" ||
      NON_MMIO_PREFIXES.some(
        (prefix) => node.path === prefix || node.path.startsWith(`${prefix}/`),
      )
    ) {
      continue;
    }
    const regEntries = nodeProperty(node, "reg")?.derived.reg ?? null;
    if (regEntries === null || regEntries.length === 0) continue;

    const compatible = nodeProperty(node, "compatible")?.derived.strings ?? [];
    const status = nodeProperty(node, "status")?.derived.strings?.[0] ?? null;
    if (status === "disabled") continue;
    const isMemory =
      node.path === "/memory" ||
      node.path.startsWith("/memory@") ||
      compatible.includes("mmio-sram");

    if (
      node.parent !== null &&
      mappings.get(node.parent)?.kind === "device_bus"
    ) {
      const firstAddr = regEntries[0]?.address ?? null;
      if (firstAddr !== null) {
        if (parseUnsignedBigInt(firstAddr) === null) {
          return err(
            `Devicetree node '${node.path}' has invalid reg address '${firstAddr}'`,
          );
        }
        pendingBusChildren.push({
          node,
          parentPath: node.parent,
          firstAddr,
          compatible,
          status,
        });
      }
      continue;
    }

    for (const [regIndex, reg] of regEntries.entries()) {
      if (reg.address === null || reg.size === null) continue;
      const rawAddr = parseUnsignedBigInt(reg.address);
      const rawSize = parseUnsignedBigInt(reg.size);
      if (rawAddr === null || rawSize === null) {
        return err(
          `Devicetree node '${node.path}' has invalid reg entry (${String(reg.address)}, ${String(reg.size)})`,
        );
      }
      if (rawSize <= 0n || rawSize > BigInt(Number.MAX_SAFE_INTEGER)) continue;

      const translated = translateToCpuAddress(node.parent, rawAddr, rawSize, {
        byPath,
        mappings,
      });
      if (!translated.ok) {
        if (translated.error !== "device_bus") {
          limitations.push(translated.error);
        }
        continue;
      }

      const cpuAddr = translated.value;
      const sizeBytes = Number(rawSize);
      if (isMemory) {
        memory.push({
          id: regIndex === 0 ? node.path : `${node.path}#${regIndex}`,
          name: node.path,
          kind: "sram",
          baseAddress: `0x${cpuAddr.toString(16)}`,
          baseAddressValue: cpuAddr,
          sizeBytes,
          evidence: `DTB ${dt.artifact.sha256} memory node ${node.path}`,
        });
        continue;
      }

      const baseLabel = nodeShortName(node.path);
      const name =
        regEntries.length > 1
          ? `${baseLabel}@0x${cpuAddr.toString(16)}#${regIndex}`
          : `${baseLabel}@0x${cpuAddr.toString(16)}`;
      if (!controllerNameByPath.has(node.path)) {
        controllerNameByPath.set(node.path, name);
      }
      peripherals.push({
        name,
        controllerId: node.path,
        baseAddress: `0x${cpuAddr.toString(16)}`,
        baseAddressValue: cpuAddr,
        sizeBytes,
        bus: node.parent,
        compatible,
        status,
        registers: [],
      });
    }
  }

  for (const child of pendingBusChildren) {
    const controllerName = controllerNameByPath.get(child.parentPath) ?? null;
    if (controllerName !== null) {
      deviceBindings.push({
        deviceId: child.node.path,
        controllerId: child.parentPath,
      });
    }
    devices.push({
      id: child.node.path,
      name: child.compatible[0] ?? nodeShortName(child.node.path),
      kind: "listed_resource",
      peripheralName: controllerName,
      role: `Devicetree child at ${child.firstAddr}`,
      kconfigDefault: child.status === null || child.status === "okay",
      pins: [],
      evidence: `DTB ${dt.artifact.sha256} node ${child.node.path}`,
    });
  }

  return ok({
    id: dt.summary.model ?? dt.summary.compatible?.[0] ?? dt.artifact.path,
    sourceKind: "devicetree",
    sourceSha256: dt.artifact.sha256,
    model: dt.summary.model,
    memory,
    peripherals,
    devices,
    deviceBindings,
    limitations,
  });
};

const MAX_SVD_CHARS = 16 * 1024 * 1024;
const MAX_SVD_XML_NODES = 500_000;
const MAX_SVD_DIM_ELEMENTS = 1024;
const MAX_SVD_TOTAL_REGISTERS = 32768;
const MAX_SVD_EXPANSION_STEPS = 65536;
const MAX_SVD_EXPANDED_TEXT_CHARS = 16 * 1024 * 1024;
const MAX_SVD_CLUSTER_DEPTH = 64;

interface SvdExpansionBudget {
  remainingRegisters: number;
  remainingSteps: number;
  remainingTextChars: number;
}

const chargeSvdTextBudget = (
  budget: SvdExpansionBudget,
  chars: number,
): Result<null, string> => {
  budget.remainingTextChars -= chars;
  if (budget.remainingTextChars < 0) {
    return err(
      "CMSIS-SVD expanded text exceeds maximum 16 MiB character budget",
    );
  }
  return ok(null);
};

const elementTagLower = (element: Element): string =>
  (element.localName ?? element.tagName).toLowerCase();

const directChildElements = (parent: Element, tagLower?: string): Element[] => {
  const out: Element[] = [];
  for (
    let child: Node | null = parent.firstChild;
    child !== null;
    child = child.nextSibling
  ) {
    if (child.nodeType !== 1) continue;
    const element = child as Element;
    if (tagLower === undefined || elementTagLower(element) === tagLower) {
      out.push(element);
    }
  }
  return out;
};

const directChildText = (parent: Element, tagLower: string): string | null => {
  for (
    let child: Node | null = parent.firstChild;
    child !== null;
    child = child.nextSibling
  ) {
    if (child.nodeType !== 1) continue;
    const element = child as Element;
    if (elementTagLower(element) !== tagLower) continue;
    const trimmed = (element.textContent ?? "").trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
};

const elementAttributeCaseInsensitive = (
  element: Element,
  attrLower: string,
): string | null => {
  for (let idx = 0; idx < element.attributes.length; idx += 1) {
    const attr = element.attributes.item(idx);
    if (attr === null) continue;
    if ((attr.localName ?? attr.name).toLowerCase() === attrLower) {
      const trimmed = attr.value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }
  return null;
};

const parseSvdInt = (raw: string | null): bigint | null => {
  if (raw === null || raw.length === 0) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NUMERIC_LITERAL_CHARS) {
    return null;
  }
  const normalized = trimmed.startsWith("#")
    ? `0b${trimmed.slice(1)}`
    : trimmed;
  if (!/^(?:0x[0-9a-fA-F]+|0b[01]+|\d+)$/u.test(normalized)) return null;
  try {
    const val = BigInt(normalized);
    return val < 0n ? null : val;
  } catch {
    return null;
  }
};

const expandDimIndices = (
  dim: number,
  dimIndexRaw: string | null,
): string[] => {
  if (dimIndexRaw !== null && dimIndexRaw.length > 0) {
    if (dimIndexRaw.includes(",")) {
      const rawParts = dimIndexRaw.split(",", dim + 1);
      if (rawParts.length === dim) {
        return rawParts.map((part) => part.trim());
      }
    }
    const rangeMatch = /^(\d+)-(\d+)$/u.exec(dimIndexRaw.trim());
    if (rangeMatch?.[1] && rangeMatch[2]) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (end >= start && end - start + 1 === dim) {
        return Array.from({ length: dim }, (_, idx) => String(start + idx));
      }
    }
    const alphaRangeMatch = /^([A-Za-z])-([A-Za-z])$/u.exec(dimIndexRaw.trim());
    if (alphaRangeMatch?.[1] && alphaRangeMatch[2]) {
      const startCode = alphaRangeMatch[1].codePointAt(0)!;
      const endCode = alphaRangeMatch[2].codePointAt(0)!;
      if (endCode >= startCode && endCode - startCode + 1 === dim) {
        return Array.from({ length: dim }, (_, idx) =>
          String.fromCodePoint(startCode + idx),
        );
      }
    }
  }
  return Array.from({ length: dim }, (_, idx) => String(idx));
};

const countDimPlaceholders = (template: string): number => {
  let count = 0;
  let cursor = 0;
  while (true) {
    const found = template.indexOf("%s", cursor);
    if (found < 0) return count;
    count += 1;
    cursor = found + 2;
  }
};

const projectedDimNameLength = (
  template: string,
  placeholderCount: number,
  indexToken: string,
): number =>
  placeholderCount > 0
    ? template.length + placeholderCount * (indexToken.length - 2)
    : template.length + indexToken.length;

const resolveSvdDimTokens = (
  element: Element,
  dim: number,
  budget: SvdExpansionBudget,
  cache: WeakMap<Element, readonly string[]>,
): Result<readonly string[], string> => {
  const cached = cache.get(element);
  if (cached !== undefined) return ok(cached);
  const dimIndexRaw = directChildText(element, "dimindex");
  if (dimIndexRaw !== null && dimIndexRaw.length > 0) {
    const rawCharge = chargeSvdTextBudget(budget, dimIndexRaw.length);
    if (!rawCharge.ok) return rawCharge;
  }
  const tokens = expandDimIndices(dim, dimIndexRaw);
  cache.set(element, tokens);
  return ok(tokens);
};

const formatDimName = (template: string, indexToken: string): string =>
  template.includes("%s")
    ? template.replaceAll("%s", () => indexToken)
    : `${template}${indexToken}`;

const parseSvdBitWidthToBytes = (raw: string | null): number | null => {
  const bits = parseSvdInt(raw);
  if (bits === null || bits <= 0n || bits > 1024n) return null;
  return Math.max(1, Math.ceil(Number(bits) / 8));
};

interface RawSvdRegister extends CustomPeripheralRegister {
  readonly explicitByteWidth: number | null;
}

const normalizedSvdDescription = (
  element: Element,
  cache: WeakMap<Element, string | null>,
): string | null => {
  if (cache.has(element)) return cache.get(element) ?? null;
  const raw = directChildText(element, "description");
  const normalized = raw === null ? null : raw.replace(/\s+/gu, " ");
  cache.set(element, normalized);
  return normalized;
};

const svdElementMatchesName = (
  element: Element,
  targetName: string,
  budget: SvdExpansionBudget,
  dimTokenCache: WeakMap<Element, readonly string[]>,
): Result<boolean, string> => {
  budget.remainingSteps -= 1;
  if (budget.remainingSteps < 0) {
    return err(
      `CMSIS-SVD expanded peripheral/register count exceeds maximum ${MAX_SVD_EXPANSION_STEPS} steps`,
    );
  }
  const rawName = directChildText(element, "name");
  if (rawName === null) return ok(false);
  if (rawName === targetName) return ok(true);
  const dimRaw = directChildText(element, "dim");
  const dimVal = dimRaw === null ? null : parseSvdInt(dimRaw);
  const dimInc = parseSvdInt(directChildText(element, "dimincrement"));
  if (
    dimVal === null ||
    dimVal <= 0n ||
    dimVal > BigInt(MAX_SVD_DIM_ELEMENTS) ||
    dimInc === null
  ) {
    return ok(false);
  }
  const placeholder = rawName.indexOf("%s");
  const prefix = placeholder >= 0 ? rawName.slice(0, placeholder) : rawName;
  if (!targetName.startsWith(prefix)) return ok(false);
  const count = Number(dimVal);
  budget.remainingSteps -= count;
  if (budget.remainingSteps < 0) {
    return err(
      `CMSIS-SVD expanded peripheral/register count exceeds maximum ${MAX_SVD_EXPANSION_STEPS} steps`,
    );
  }
  const tokensResult = resolveSvdDimTokens(
    element,
    count,
    budget,
    dimTokenCache,
  );
  if (!tokensResult.ok) return tokensResult;
  const tokens = tokensResult.value;
  const placeholderCount = countDimPlaceholders(rawName);
  for (let idx = 0; idx < count; idx += 1) {
    const token = tokens[idx] ?? String(idx);
    const expandedLen = projectedDimNameLength(
      rawName,
      placeholderCount,
      token,
    );
    const lenCharge = chargeSvdTextBudget(budget, expandedLen);
    if (!lenCharge.ok) return lenCharge;
    if (expandedLen !== targetName.length) continue;
    if (formatDimName(rawName, token) === targetName) {
      return ok(true);
    }
  }
  return ok(false);
};

const findSvdChildByName = (
  children: readonly Element[],
  targetName: string,
  budget: SvdExpansionBudget,
  dimTokenCache: WeakMap<Element, readonly string[]>,
): Result<Element | undefined, string> => {
  for (const child of children) {
    const tag = elementTagLower(child);
    if (tag !== "register" && tag !== "cluster") continue;
    const matched = svdElementMatchesName(
      child,
      targetName,
      budget,
      dimTokenCache,
    );
    if (!matched.ok) return matched;
    if (matched.value) return ok(child);
  }
  return ok(undefined);
};

const findSvdPeripheralRegistersByName = (
  peripheralElements: readonly Element[],
  targetName: string,
  budget: SvdExpansionBudget,
  dimTokenCache: WeakMap<Element, readonly string[]>,
): Result<Element | undefined, string> => {
  for (const periphEl of peripheralElements) {
    const matched = svdElementMatchesName(
      periphEl,
      targetName,
      budget,
      dimTokenCache,
    );
    if (!matched.ok) return matched;
    if (matched.value) {
      return ok(directChildElements(periphEl, "registers")[0]);
    }
  }
  return ok(undefined);
};

const owningRegistersRoot = (element: Element): Element | null => {
  let cursor: Node | null = element.parentNode;
  while (cursor !== null && cursor.nodeType === 1) {
    const parentEl = cursor as Element;
    if (elementTagLower(parentEl) === "registers") return parentEl;
    cursor = parentEl.parentNode;
  }
  return null;
};

const lookupSvdDerivedElement = (
  ref: string,
  ctx: {
    readonly currentChildren: readonly Element[];
    readonly rootRegistersEl: Element;
    readonly peripheralElements: readonly Element[];
    readonly budget: SvdExpansionBudget;
    readonly dimTokenCache: WeakMap<Element, readonly string[]>;
  },
): Result<Element | null, string> => {
  if (!ref.includes(".")) {
    const localHit = findSvdChildByName(
      ctx.currentChildren,
      ref,
      ctx.budget,
      ctx.dimTokenCache,
    );
    if (!localHit.ok) return localHit;
    if (localHit.value !== undefined) return ok(localHit.value);
    const rootHit = findSvdChildByName(
      directChildElements(ctx.rootRegistersEl),
      ref,
      ctx.budget,
      ctx.dimTokenCache,
    );
    if (!rootHit.ok) return rootHit;
    return ok(rootHit.value ?? null);
  }
  const parts = ref.split(".").filter((part) => part.length > 0);
  if (parts.length === 0) return ok(null);
  let container: Element | undefined;
  let startIndex = 0;
  const siblingClusterResult = findSvdChildByName(
    ctx.currentChildren,
    parts[0]!,
    ctx.budget,
    ctx.dimTokenCache,
  );
  if (!siblingClusterResult.ok) return siblingClusterResult;
  const siblingCluster = siblingClusterResult.value;
  if (
    siblingCluster !== undefined &&
    elementTagLower(siblingCluster) === "cluster"
  ) {
    if (parts.length === 1) return ok(siblingCluster);
    container = siblingCluster;
    startIndex = 1;
  } else {
    const localFirstResult = findSvdChildByName(
      directChildElements(ctx.rootRegistersEl),
      parts[0]!,
      ctx.budget,
      ctx.dimTokenCache,
    );
    if (!localFirstResult.ok) return localFirstResult;
    const localFirst = localFirstResult.value;
    if (localFirst !== undefined && elementTagLower(localFirst) === "cluster") {
      if (parts.length === 1) return ok(localFirst);
      container = localFirst;
      startIndex = 1;
    } else {
      const periphHit = findSvdPeripheralRegistersByName(
        ctx.peripheralElements,
        parts[0]!,
        ctx.budget,
        ctx.dimTokenCache,
      );
      if (!periphHit.ok) return periphHit;
      container = periphHit.value;
      startIndex = 1;
    }
  }
  if (container === undefined || startIndex >= parts.length) return ok(null);
  let cursorEl: Element | undefined = container;
  for (let idx = startIndex; idx < parts.length; idx += 1) {
    const matchResult = findSvdChildByName(
      directChildElements(cursorEl),
      parts[idx]!,
      ctx.budget,
      ctx.dimTokenCache,
    );
    if (!matchResult.ok) return matchResult;
    const match = matchResult.value;
    if (match === undefined) return ok(null);
    if (idx < parts.length - 1) {
      if (elementTagLower(match) !== "cluster") return ok(null);
      cursorEl = match;
    } else {
      return ok(match);
    }
  }
  return ok(null);
};

const mergeClusterChildren = (
  chainOldestFirst: readonly Element[],
): readonly Element[] => {
  if (chainOldestFirst.length === 1) {
    return directChildElements(chainOldestFirst[0]!).filter((el) => {
      const t = elementTagLower(el);
      return t === "register" || t === "cluster";
    });
  }
  const merged: Element[] = [];
  const indexByName = new Map<string, number>();
  for (const clusterEl of chainOldestFirst) {
    for (const child of directChildElements(clusterEl)) {
      const tag = elementTagLower(child);
      if (tag !== "register" && tag !== "cluster") continue;
      const childName = directChildText(child, "name");
      if (childName === null) continue;
      const existingIdx = indexByName.get(childName);
      if (existingIdx !== undefined) {
        merged[existingIdx] = child;
      } else {
        indexByName.set(childName, merged.length);
        merged.push(child);
      }
    }
  }
  return merged;
};

const resolveSvdTreeTemplate = (
  itemEl: Element,
  tag: "register" | "cluster",
  rawName: string,
  ctx: {
    readonly currentChildren: readonly Element[];
    readonly rootRegistersEl: Element;
    readonly peripheralElements: readonly Element[];
    readonly descCache: WeakMap<Element, string | null>;
    readonly dimTokenCache: WeakMap<Element, readonly string[]>;
    readonly budget: SvdExpansionBudget;
  },
): Result<
  {
    readonly explicitByteWidth: number | null;
    readonly description: string | null;
    readonly clusterChildren: readonly Element[];
  },
  string
> => {
  const firstDerived = elementAttributeCaseInsensitive(itemEl, "derivedfrom");
  if (firstDerived === null) {
    return ok({
      explicitByteWidth: parseSvdBitWidthToBytes(
        directChildText(itemEl, "size"),
      ),
      description: normalizedSvdDescription(itemEl, ctx.descCache),
      clusterChildren:
        tag === "cluster"
          ? directChildElements(itemEl).filter((el) => {
              const t = elementTagLower(el);
              return t === "register" || t === "cluster";
            })
          : [],
    });
  }

  const chainNewestFirst: Element[] = [itemEl];
  const visited = new Set<Element>([itemEl]);
  let nextRef: string | null = firstDerived;
  let scopeChildren: readonly Element[] = ctx.currentChildren;
  let scopeRootRegistersEl: Element =
    owningRegistersRoot(itemEl) ?? ctx.rootRegistersEl;

  while (nextRef !== null) {
    ctx.budget.remainingSteps -= 1;
    if (ctx.budget.remainingSteps < 0) {
      return err(
        `CMSIS-SVD expanded cluster/register count exceeds maximum ${MAX_SVD_EXPANSION_STEPS} steps`,
      );
    }
    if (chainNewestFirst.length > MAX_SVD_CLUSTER_DEPTH) {
      return err(
        `CMSIS-SVD ${tag} '${rawName}' derivedFrom chain exceeds maximum depth ${MAX_SVD_CLUSTER_DEPTH}`,
      );
    }
    const targetResult = lookupSvdDerivedElement(nextRef, {
      currentChildren: scopeChildren,
      rootRegistersEl: scopeRootRegistersEl,
      peripheralElements: ctx.peripheralElements,
      budget: ctx.budget,
      dimTokenCache: ctx.dimTokenCache,
    });
    if (!targetResult.ok) return targetResult;
    const target = targetResult.value;
    if (target === null || elementTagLower(target) !== tag) {
      return err(
        `CMSIS-SVD ${tag} '${rawName}' references unknown derivedFrom '${nextRef}'`,
      );
    }
    if (visited.has(target)) {
      return err(
        `CMSIS-SVD ${tag} '${rawName}' has cyclic derivedFrom '${nextRef}'`,
      );
    }
    visited.add(target);
    chainNewestFirst.push(target);
    scopeChildren =
      target.parentNode !== null && target.parentNode.nodeType === 1
        ? directChildElements(target.parentNode as Element)
        : [];
    scopeRootRegistersEl = owningRegistersRoot(target) ?? scopeRootRegistersEl;
    nextRef = elementAttributeCaseInsensitive(target, "derivedfrom");
  }

  let explicitByteWidth: number | null = null;
  let description: string | null = null;
  for (const el of chainNewestFirst) {
    explicitByteWidth ??= parseSvdBitWidthToBytes(directChildText(el, "size"));
    description ??= normalizedSvdDescription(el, ctx.descCache);
  }
  const clusterChildren =
    tag === "cluster"
      ? mergeClusterChildren([...chainNewestFirst].reverse())
      : [];
  return ok({
    explicitByteWidth,
    description,
    clusterChildren,
  });
};

type SvdRegisterWorkItem =
  | {
      readonly kind: "container";
      readonly children: readonly Element[];
      readonly baseOffset: bigint;
      readonly prefix: string;
      readonly inheritedByteWidth: number | null;
      readonly depth: number;
    }
  | {
      readonly kind: "register";
      readonly value: RawSvdRegister;
    };

const parseSvdRegisterTree = (
  registersContainer: Element,
  ctx: {
    readonly limitations: string[];
    readonly budget: SvdExpansionBudget;
    readonly peripheralElements: readonly Element[];
    readonly descCache: WeakMap<Element, string | null>;
    readonly dimTokenCache: WeakMap<Element, readonly string[]>;
  },
): Result<RawSvdRegister[], string> => {
  const results: RawSvdRegister[] = [];
  const stack: SvdRegisterWorkItem[] = [
    {
      kind: "container",
      children: directChildElements(registersContainer),
      baseOffset: 0n,
      prefix: "",
      inheritedByteWidth: null,
      depth: 0,
    },
  ];

  while (stack.length > 0) {
    const work = stack.pop()!;
    if (work.kind === "register") {
      results.push(work.value);
      continue;
    }
    if (work.depth > MAX_SVD_CLUSTER_DEPTH) {
      return err(
        `CMSIS-SVD cluster nesting exceeds maximum depth ${MAX_SVD_CLUSTER_DEPTH}`,
      );
    }

    const emitted: SvdRegisterWorkItem[] = [];
    for (const itemEl of work.children) {
      const tag = elementTagLower(itemEl);
      if (tag !== "cluster" && tag !== "register") continue;

      const rawName = directChildText(itemEl, "name");
      const offset = parseSvdInt(directChildText(itemEl, "addressoffset"));
      if (rawName === null || offset === null) continue;

      const resolvedTemplate = resolveSvdTreeTemplate(itemEl, tag, rawName, {
        currentChildren: work.children,
        rootRegistersEl: registersContainer,
        peripheralElements: ctx.peripheralElements,
        descCache: ctx.descCache,
        dimTokenCache: ctx.dimTokenCache,
        budget: ctx.budget,
      });
      if (!resolvedTemplate.ok) return resolvedTemplate;

      const itemByteWidth =
        resolvedTemplate.value.explicitByteWidth ?? work.inheritedByteWidth;

      const dimRaw = directChildText(itemEl, "dim");
      const dimVal = dimRaw === null ? null : parseSvdInt(dimRaw);
      const dimInc = parseSvdInt(directChildText(itemEl, "dimincrement"));
      if (dimRaw !== null) {
        if (
          dimVal === null ||
          dimVal <= 0n ||
          dimVal > BigInt(MAX_SVD_DIM_ELEMENTS) ||
          dimInc === null
        ) {
          ctx.limitations.push(
            `Skipped SVD ${tag} '${rawName}' with unsupported dim/dimIncrement bounds.`,
          );
          continue;
        }
      }

      const count = dimVal === null ? 1 : Number(dimVal);
      ctx.budget.remainingSteps -= count;
      if (ctx.budget.remainingSteps < 0) {
        return err(
          `CMSIS-SVD expanded cluster/register count exceeds maximum ${MAX_SVD_EXPANSION_STEPS} steps`,
        );
      }
      if (tag === "register") {
        ctx.budget.remainingRegisters -= count;
        if (ctx.budget.remainingRegisters < 0) {
          return err(
            `CMSIS-SVD expanded register count exceeds maximum ${MAX_SVD_TOTAL_REGISTERS} registers`,
          );
        }
      }

      let tokens: readonly string[] = [""];
      if (dimVal !== null) {
        const tokensResult = resolveSvdDimTokens(
          itemEl,
          count,
          ctx.budget,
          ctx.dimTokenCache,
        );
        if (!tokensResult.ok) return tokensResult;
        tokens = tokensResult.value;
      }
      const placeholderCount =
        dimVal === null ? 0 : countDimPlaceholders(rawName);
      const normalizedDesc = resolvedTemplate.value.description;

      let projectedChars = 0;
      for (let idx = 0; idx < count; idx += 1) {
        const token = tokens[idx] ?? String(idx);
        const instanceNameLen =
          dimVal === null
            ? rawName.length
            : projectedDimNameLength(rawName, placeholderCount, token);
        if (tag === "cluster") {
          projectedChars += work.prefix.length + instanceNameLen + 4;
        } else {
          const descLen =
            normalizedDesc !== null ? normalizedDesc.length : instanceNameLen;
          projectedChars += work.prefix.length + instanceNameLen + descLen + 8;
        }
      }
      const textCharge = chargeSvdTextBudget(ctx.budget, projectedChars);
      if (!textCharge.ok) return textCharge;

      const step = dimInc ?? 0n;

      for (let idx = 0; idx < count; idx += 1) {
        const token = tokens[idx] ?? String(idx);
        const instanceName =
          dimVal === null ? rawName : formatDimName(rawName, token);
        const instanceOffset = work.baseOffset + offset + BigInt(idx) * step;
        if (tag === "cluster") {
          const cleanPrefix = instanceName.replace(/[^\w]/gu, "_");
          emitted.push({
            kind: "container",
            children: resolvedTemplate.value.clusterChildren,
            baseOffset: instanceOffset,
            prefix: `${work.prefix}${cleanPrefix}_`,
            inheritedByteWidth: itemByteWidth,
            depth: work.depth + 1,
          });
        } else {
          const desc =
            normalizedDesc !== null
              ? normalizedDesc
              : instanceName.replace(/\s+/gu, " ");
          emitted.push({
            kind: "register",
            value: {
              offset: instanceOffset,
              mnemonic: `${work.prefix}${instanceName}`,
              name: desc,
              explicitByteWidth: itemByteWidth,
            },
          });
        }
      }
    }

    for (let idx = emitted.length - 1; idx >= 0; idx -= 1) {
      stack.push(emitted[idx]!);
    }
  }
  return ok(results);
};

interface RawSvdPeripheral {
  readonly name: string;
  readonly derivedFrom: string | null;
  readonly base: bigint;
  readonly hasDeclaredAddressBlocks: boolean;
  readonly addressBlocks: readonly CustomPeripheralAddressBlock[];
  readonly declaredMaxBlockEnd: number;
  readonly declaredByteWidth: number | null;
  readonly group: string | null;
  readonly registers: readonly RawSvdRegister[];
}

interface ResolvedSvdEntry {
  readonly window: CustomPeripheralWindow;
  readonly hasDeclaredAddressBlocks: boolean;
  readonly addressBlocks: readonly CustomPeripheralAddressBlock[];
  readonly maxBlockEnd: number;
  readonly defaultRegBytes: number;
  readonly rawRegisters: readonly RawSvdRegister[];
}

const stripLiteralPrefix = (value: string, prefix: string | null): string =>
  prefix !== null && value.startsWith(prefix)
    ? value.slice(prefix.length)
    : value;

const buildResolvedSvdEntry = (
  item: RawSvdPeripheral,
  parentEntry: ResolvedSvdEntry | null,
  budget: SvdExpansionBudget,
  deviceDefaultRegBytes: number,
): Result<ResolvedSvdEntry, string> => {
  const parentWindow = parentEntry?.window ?? null;
  const defaultRegBytes =
    item.declaredByteWidth ??
    parentEntry?.defaultRegBytes ??
    deviceDefaultRegBytes;
  const sourceRegs =
    item.registers.length > 0
      ? item.registers
      : (parentEntry?.rawRegisters ?? []);
  if (item.registers.length === 0 && sourceRegs.length > 0) {
    budget.remainingRegisters -= sourceRegs.length;
    if (budget.remainingRegisters < 0) {
      return err(
        `CMSIS-SVD expanded register count exceeds maximum ${MAX_SVD_TOTAL_REGISTERS} registers`,
      );
    }
  }
  if (sourceRegs.length > 0) {
    let projectedChars = 0;
    for (const reg of sourceRegs) {
      projectedChars +=
        item.name.length * 2 + reg.mnemonic.length + reg.name.length + 4;
    }
    const textCharge = chargeSvdTextBudget(budget, projectedChars);
    if (!textCharge.ok) return textCharge;
  }

  const parentMnemonicPrefix =
    parentWindow === null ? null : `${parentWindow.name}_`;
  const parentNamePrefix =
    parentWindow === null ? null : `${parentWindow.name} `;
  const rawRegisters: RawSvdRegister[] = sourceRegs.map((reg) => ({
    offset: reg.offset,
    mnemonic: reg.mnemonic.startsWith(`${item.name}_`)
      ? reg.mnemonic
      : `${item.name}_${stripLiteralPrefix(reg.mnemonic, parentMnemonicPrefix)}`,
    name: reg.name.startsWith(`${item.name} `)
      ? reg.name
      : `${item.name} ${stripLiteralPrefix(reg.name, parentNamePrefix)}`,
    explicitByteWidth: reg.explicitByteWidth,
  }));
  const registers: CustomPeripheralRegister[] = rawRegisters.map((reg) => ({
    offset: reg.offset,
    mnemonic: reg.mnemonic,
    name: reg.name,
  }));

  const maxRegEnd = rawRegisters.reduce((max, reg) => {
    const end = reg.offset + BigInt(reg.explicitByteWidth ?? defaultRegBytes);
    return end > max ? end : max;
  }, 0n);
  if (maxRegEnd > BigInt(Number.MAX_SAFE_INTEGER)) {
    return err(
      `CMSIS-SVD peripheral '${item.name}' register span exceeds safe integer bounds`,
    );
  }
  const inferredSize = maxRegEnd > 0n ? Number(maxRegEnd) : 0x400;
  const hasDeclaredAddressBlocks =
    item.hasDeclaredAddressBlocks ||
    (parentEntry?.hasDeclaredAddressBlocks ?? false);
  const addressBlocks = item.hasDeclaredAddressBlocks
    ? item.addressBlocks
    : (parentEntry?.addressBlocks ?? []);
  if (!item.hasDeclaredAddressBlocks && addressBlocks.length > 0) {
    budget.remainingSteps -= addressBlocks.length;
    if (budget.remainingSteps < 0) {
      return err(
        `CMSIS-SVD expanded peripheral/addressBlock count exceeds maximum ${MAX_SVD_EXPANSION_STEPS} steps`,
      );
    }
  }

  const maxBlockEnd = item.hasDeclaredAddressBlocks
    ? item.declaredMaxBlockEnd
    : (parentEntry?.maxBlockEnd ?? 0);
  if (
    maxBlockEnd > 0 &&
    item.base + BigInt(maxBlockEnd) > 0xffffffffffffffffn
  ) {
    return err(
      `CMSIS-SVD peripheral '${item.name}' addressBlock exceeds 64-bit address bounds`,
    );
  }
  const sizeBytes = hasDeclaredAddressBlocks
    ? Math.max(1, maxBlockEnd)
    : inferredSize;

  const window: CustomPeripheralWindow = {
    name: item.name,
    controllerId: item.name,
    baseAddress: `0x${item.base.toString(16)}`,
    baseAddressValue: item.base,
    sizeBytes,
    ...(hasDeclaredAddressBlocks ? { addressBlocks } : {}),
    bus: item.group ?? parentWindow?.bus ?? null,
    compatible: [],
    status: "okay",
    registers,
  };
  return ok({
    window,
    hasDeclaredAddressBlocks,
    addressBlocks,
    maxBlockEnd,
    defaultRegBytes,
    rawRegisters,
  });
};

const resolveSvdPeripheral = (
  name: string,
  keyedRaw: ReturnType<typeof keyedBy<RawSvdPeripheral, string>>,
  ctx: {
    readonly memo: Map<string, ResolvedSvdEntry>;
    readonly templateAliases: ReadonlyMap<string, string>;
    readonly budget: SvdExpansionBudget;
    readonly deviceDefaultRegBytes: number;
  },
): Result<ResolvedSvdEntry, string> => {
  const canonicalTarget = ctx.templateAliases.get(name) ?? name;
  const existing = ctx.memo.get(canonicalTarget);
  if (existing !== undefined) return ok(existing);

  const chain: RawSvdPeripheral[] = [];
  const visiting = new Set<string>();
  let cursor: string | null = canonicalTarget;

  while (cursor !== null && !ctx.memo.has(cursor)) {
    const currentCursor: string = ctx.templateAliases.get(cursor) ?? cursor;
    if (ctx.memo.has(currentCursor)) break;
    if (visiting.has(currentCursor)) {
      return err(
        `CMSIS-SVD peripheral derivedFrom cycle involving '${currentCursor}'`,
      );
    }
    const lookup = uniqueKeyed(keyedRaw, currentCursor);
    if (!lookup.ok) {
      return err(
        `CMSIS-SVD contains duplicate peripheral name '${currentCursor}'`,
      );
    }
    const item = lookup.value;
    if (item === undefined) {
      return err(
        `CMSIS-SVD references unknown derivedFrom peripheral '${currentCursor}'`,
      );
    }
    visiting.add(currentCursor);
    chain.push(item);
    cursor = item.derivedFrom;
  }

  for (let idx = chain.length - 1; idx >= 0; idx -= 1) {
    const item = chain[idx]!;
    const resolvedParentName =
      item.derivedFrom === null
        ? null
        : (ctx.templateAliases.get(item.derivedFrom) ?? item.derivedFrom);
    const parentEntry =
      resolvedParentName === null
        ? null
        : (ctx.memo.get(resolvedParentName) ?? null);
    const built = buildResolvedSvdEntry(
      item,
      parentEntry,
      ctx.budget,
      ctx.deviceDefaultRegBytes,
    );
    if (!built.ok) return built;
    ctx.memo.set(item.name, built.value);
  }

  return ok(ctx.memo.get(canonicalTarget)!);
};

/**
 * Parse a CMSIS-SVD XML description into a `CustomHardwareProfile`, resolving
 * peripheral base addresses, `<addressBlock>` spans, chained `derivedFrom`
 * inheritance, nested `<cluster>` offsets, and `<dim>` register arrays.
 */
export const parseCmsisSvd = (
  xml: string,
  options?: { readonly sha256?: string | null },
): Result<CustomHardwareProfile, string> => {
  if (typeof xml !== "string" || xml.trim().length === 0) {
    return err("CMSIS-SVD input must be a non-empty XML string");
  }
  if (xml.length > MAX_SVD_CHARS) {
    return err("CMSIS-SVD input exceeds maximum 16 MiB text size");
  }
  const parsedDoc = parseXmlDocumentWithinNodeLimit(xml, {
    maximumNodes: MAX_SVD_XML_NODES,
    lineEndings: "normalize",
  });
  if (!parsedDoc.ok) {
    return parsedDoc.error.kind === "node-limit"
      ? err(
          `CMSIS-SVD XML node count exceeds maximum ${MAX_SVD_XML_NODES} nodes`,
        )
      : err(`CMSIS-SVD XML is invalid: ${parsedDoc.error.message}`);
  }
  const rootElement = parsedDoc.value.documentElement;
  if (rootElement === null || elementTagLower(rootElement) !== "device") {
    return err("CMSIS-SVD input is missing a <device> root element");
  }

  const deviceName = directChildText(rootElement, "name") ?? "svd-device";
  const deviceDefaultRegBytes =
    parseSvdBitWidthToBytes(directChildText(rootElement, "size")) ?? 4;
  const peripheralsEl = directChildElements(rootElement, "peripherals")[0];
  if (peripheralsEl === undefined) {
    return err("CMSIS-SVD <device> does not contain a <peripherals> section");
  }

  const budget: SvdExpansionBudget = {
    remainingRegisters: MAX_SVD_TOTAL_REGISTERS,
    remainingSteps: MAX_SVD_EXPANSION_STEPS,
    remainingTextChars: MAX_SVD_EXPANDED_TEXT_CHARS,
  };
  const descCache = new WeakMap<Element, string | null>();
  const dimTokenCache = new WeakMap<Element, readonly string[]>();
  const peripheralElements = directChildElements(peripheralsEl, "peripheral");

  const limitations: string[] = [];
  const rawList: RawSvdPeripheral[] = [];
  const templateAliases = new Map<string, string>();
  let skippedInvalidDimPeripheral = false;

  for (const periphEl of peripheralElements) {
    const name = directChildText(periphEl, "name");
    const base = parseSvdInt(directChildText(periphEl, "baseaddress"));
    if (name === null || base === null) continue;

    const dimRaw = directChildText(periphEl, "dim");
    const dimVal = dimRaw === null ? null : parseSvdInt(dimRaw);
    const dimInc = parseSvdInt(directChildText(periphEl, "dimincrement"));
    if (dimRaw !== null) {
      if (
        dimVal === null ||
        dimVal <= 0n ||
        dimVal > BigInt(MAX_SVD_DIM_ELEMENTS) ||
        dimInc === null
      ) {
        limitations.push(
          `Skipped SVD peripheral '${name}' with unsupported dim/dimIncrement bounds.`,
        );
        skippedInvalidDimPeripheral = true;
        continue;
      }
    }

    const count = dimVal === null ? 1 : Number(dimVal);
    budget.remainingSteps -= count;
    if (budget.remainingSteps < 0) {
      return err(
        `CMSIS-SVD expanded peripheral/register count exceeds maximum ${MAX_SVD_EXPANSION_STEPS} steps`,
      );
    }

    const declaredByteWidth = parseSvdBitWidthToBytes(
      directChildText(periphEl, "size"),
    );
    const derivedFrom = elementAttributeCaseInsensitive(
      periphEl,
      "derivedfrom",
    );

    const abElements = directChildElements(periphEl, "addressblock");
    if (abElements.length > 0) {
      budget.remainingSteps -= count * abElements.length;
      if (budget.remainingSteps < 0) {
        return err(
          `CMSIS-SVD expanded peripheral/addressBlock count exceeds maximum ${MAX_SVD_EXPANSION_STEPS} steps`,
        );
      }
    }
    const hasDeclaredAddressBlocks = abElements.length > 0;
    const addressBlocks: CustomPeripheralAddressBlock[] = [];
    let declaredMaxBlockEnd = 0;
    for (const abEl of abElements) {
      const offsetText = directChildText(abEl, "offset");
      const blockOffset = offsetText === null ? 0n : parseSvdInt(offsetText);
      const blockSize = parseSvdInt(directChildText(abEl, "size"));
      if (blockOffset === null || blockSize === null || blockSize <= 0n) {
        return err(
          `CMSIS-SVD peripheral '${name}' has invalid addressBlock offset or size`,
        );
      }
      const end = Number(blockOffset + blockSize);
      const sizeNum = Number(blockSize);
      if (!Number.isSafeInteger(end) || !Number.isSafeInteger(sizeNum)) {
        return err(
          `CMSIS-SVD peripheral '${name}' addressBlock exceeds safe integer bounds`,
        );
      }
      const usage = directChildText(abEl, "usage")?.toLowerCase() ?? null;
      if (usage === "reserved") continue;
      if (end > declaredMaxBlockEnd) declaredMaxBlockEnd = end;
      addressBlocks.push({
        offset: blockOffset,
        sizeBytes: sizeNum,
      });
    }

    let registers: RawSvdRegister[] = [];
    const regsEl = directChildElements(periphEl, "registers")[0];
    if (regsEl !== undefined) {
      const parsedRegs = parseSvdRegisterTree(regsEl, {
        limitations,
        budget,
        peripheralElements,
        descCache,
        dimTokenCache,
      });
      if (!parsedRegs.ok) return parsedRegs;
      registers = parsedRegs.value;
    }

    if (count > 1 && registers.length > 0) {
      budget.remainingRegisters -= (count - 1) * registers.length;
      if (budget.remainingRegisters < 0) {
        return err(
          `CMSIS-SVD expanded register count exceeds maximum ${MAX_SVD_TOTAL_REGISTERS} registers`,
        );
      }
    }

    let tokens: readonly string[] = [""];
    if (dimVal !== null) {
      const tokensResult = resolveSvdDimTokens(
        periphEl,
        count,
        budget,
        dimTokenCache,
      );
      if (!tokensResult.ok) return tokensResult;
      tokens = tokensResult.value;
    }
    const placeholderCount = dimVal === null ? 0 : countDimPlaceholders(name);
    const group = directChildText(periphEl, "groupname");
    let projectedPeriphChars = 0;
    for (let idx = 0; idx < count; idx += 1) {
      const token = tokens[idx] ?? String(idx);
      const instanceNameLen =
        dimVal === null
          ? name.length
          : projectedDimNameLength(name, placeholderCount, token);
      projectedPeriphChars += instanceNameLen + (group?.length ?? 0) + 4;
    }
    const periphTextCharge = chargeSvdTextBudget(budget, projectedPeriphChars);
    if (!periphTextCharge.ok) return periphTextCharge;

    const step = dimInc ?? 0n;

    for (let idx = 0; idx < count; idx += 1) {
      const token = tokens[idx] ?? String(idx);
      const instanceName: string =
        dimVal === null ? name : formatDimName(name, token);
      const instanceBase = base + BigInt(idx) * step;
      if (instanceBase > 0xffffffffffffffffn) {
        return err(
          `CMSIS-SVD peripheral '${instanceName}' baseAddress exceeds 64-bit address bounds`,
        );
      }
      if (idx === 0 && instanceName !== name && !templateAliases.has(name)) {
        templateAliases.set(name, instanceName);
      }
      rawList.push({
        name: instanceName,
        derivedFrom,
        base: instanceBase,
        hasDeclaredAddressBlocks,
        addressBlocks,
        declaredMaxBlockEnd,
        declaredByteWidth,
        group,
        registers,
      });
    }
  }

  if (rawList.length === 0) {
    return err(
      skippedInvalidDimPeripheral
        ? (limitations[0] ??
            "CMSIS-SVD <peripherals> did not define any valid peripheral")
        : "CMSIS-SVD <peripherals> did not define any valid peripheral",
    );
  }

  const keyedRaw = keyedBy(rawList, (item) => item.name);
  if (keyedRaw.duplicates.length > 0) {
    return err(
      `CMSIS-SVD contains duplicate peripheral name '${keyedRaw.duplicates[0]}'`,
    );
  }
  for (const templateName of [...templateAliases.keys()]) {
    const lookup = uniqueKeyed(keyedRaw, templateName);
    if (!lookup.ok || lookup.value !== undefined) {
      templateAliases.delete(templateName);
    }
  }
  const memo = new Map<string, ResolvedSvdEntry>();
  const peripherals: CustomPeripheralWindow[] = [];
  for (const item of rawList) {
    const resolved = resolveSvdPeripheral(item.name, keyedRaw, {
      memo,
      templateAliases,
      budget,
      deviceDefaultRegBytes,
    });
    if (!resolved.ok) return resolved;
    peripherals.push(resolved.value.window);
  }

  return ok({
    id: deviceName,
    sourceKind: "cmsis_svd",
    sourceSha256: options?.sha256 ?? null,
    model: deviceName,
    memory: [],
    peripherals,
    devices: [],
    limitations,
  });
};
