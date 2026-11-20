import { z } from "zod";
import type {
  BoardDeviceAttachment,
  BoardMemoryWindow,
} from "./boardPeripheralProfile.js";
import type { Devicetree } from "./devicetree.js";
import { firstKeyed, keyedBy } from "../keyedCollection.js";
import { err, ok, type Result } from "../result.js";

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

export interface CustomPeripheralWindow {
  readonly name: string;
  readonly baseAddress: string;
  readonly baseAddressValue: bigint;
  readonly sizeBytes: number;
  readonly bus: string | null;
  readonly compatible: readonly string[];
  readonly status: string | null;
  readonly registers: readonly CustomPeripheralRegister[];
}

export interface CustomHardwareProfile {
  readonly id: string;
  readonly sourceKind: CustomHardwareSource;
  readonly sourceSha256: string | null;
  readonly model: string | null;
  readonly memory: readonly BoardMemoryWindow[];
  readonly peripherals: readonly CustomPeripheralWindow[];
  readonly devices: readonly BoardDeviceAttachment[];
  readonly limitations: readonly string[];
}

const customPeripheralRegisterSchema = z.strictObject({
  offset: z.bigint().nonnegative(),
  mnemonic: z.string().min(1),
  name: z.string().min(1),
});

const customPeripheralWindowSchema = z.strictObject({
  name: z.string().min(1),
  baseAddress: z.string(),
  baseAddressValue: z.bigint().nonnegative(),
  sizeBytes: z.number().int().positive(),
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
  limitations: z.array(z.string()),
});

const SVD_REGISTER_PRECEDENCE =
  "CMSIS-SVD alternate registers may share an addressOffset; select primary declaration";
const FDT_PROPERTY_PRECEDENCE =
  "Devicetree specification v0.4 §2.2.4 requires unique property names per node; first declaration selected";

/** Look up a peripheral window and optional register offset in a custom profile. */
export const lookupCustomPeripheral = (
  address: bigint,
  profile: CustomHardwareProfile,
): {
  readonly peripheral: CustomPeripheralWindow;
  readonly register: CustomPeripheralRegister | null;
} | null => {
  for (const peripheral of profile.peripherals) {
    const end = peripheral.baseAddressValue + BigInt(peripheral.sizeBytes);
    if (address >= peripheral.baseAddressValue && address < end) {
      const offset = address - peripheral.baseAddressValue;
      const keyedRegs = keyedBy(peripheral.registers, (entry) =>
        entry.offset.toString(16),
      );
      const register =
        firstKeyed(keyedRegs, offset.toString(16), SVD_REGISTER_PRECEDENCE) ??
        null;
      return { peripheral, register };
    }
  }
  return null;
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

const parseBusMapping = (
  node: Devicetree["nodes"][number],
  byPath: ReadonlyMap<string, Devicetree["nodes"][number]>,
): BusMapping => {
  if (node.path === "/") return { kind: "identity" };
  const ranges = nodeProperty(node, "ranges");
  if (ranges === undefined) return { kind: "device_bus" };
  if (ranges.bytes === 0) return { kind: "identity" };
  const cells = ranges.derived.cells;
  if (
    cells === null &&
    (ranges.truncated || ranges.hex.length < ranges.bytes * 2)
  ) {
    return {
      kind: "untranslated",
      reason: `ranges at ${node.path} exceeds 256-byte preview; child reg addresses were not mapped to CPU space.`,
    };
  }
  const childAddrCells =
    nodeProperty(node, "#address-cells")?.derived.cells?.[0] ?? 2;
  const childSizeCells =
    nodeProperty(node, "#size-cells")?.derived.cells?.[0] ?? 1;
  const parentNode = node.parent === null ? undefined : byPath.get(node.parent);
  const parentAddrCells =
    (parentNode === undefined
      ? undefined
      : nodeProperty(parentNode, "#address-cells")
    )?.derived.cells?.[0] ?? 2;
  const tupleCells = childAddrCells + parentAddrCells + childSizeCells;
  if (
    tupleCells === 0 ||
    childSizeCells === 0 ||
    ranges.bytes % (tupleCells * 4) !== 0 ||
    (cells !== null && cells.length % tupleCells !== 0)
  ) {
    return {
      kind: "untranslated",
      reason: `ranges at ${node.path} has unsupported cell widths.`,
    };
  }
  const tuples: RangeTuple[] = [];
  const totalCells = cells !== null ? cells.length : ranges.bytes / 4;
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
  byPath: ReadonlyMap<string, Devicetree["nodes"][number]>,
  mappings: ReadonlyMap<string, BusMapping>,
): Result<bigint, "device_bus" | string> => {
  let currentPath = startParentPath;
  let currentAddr = rawAddress;
  while (currentPath !== null) {
    const mapping = mappings.get(currentPath);
    const busNode = byPath.get(currentPath);
    if (mapping === undefined || busNode === undefined) {
      return err(`Missing parent node ${currentPath}`);
    }
    if (mapping.kind === "device_bus") return err("device_bus");
    if (mapping.kind === "untranslated") return err(mapping.reason);
    if (mapping.kind === "translated") {
      const hit = mapping.tuples.find(
        (t) =>
          currentAddr >= t.childStart &&
          currentAddr + rawSize <= t.childStart + t.length,
      );
      if (hit === undefined) {
        return err(
          `Address 0x${currentAddr.toString(16)} is outside ranges of ${currentPath}.`,
        );
      }
      currentAddr = hit.parentStart + (currentAddr - hit.childStart);
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
 * parsed Flattened Devicetree (`Devicetree`), preserving bus `ranges` semantics.
 */
export const hardwareProfileFromDevicetree = (
  dt: Devicetree,
): CustomHardwareProfile => {
  const byPath = new Map(dt.nodes.map((node) => [node.path, node]));
  const mappings = new Map(
    dt.nodes.map((node) => [node.path, parseBusMapping(node, byPath)]),
  );
  const memory: BoardMemoryWindow[] = [];
  const peripherals: CustomPeripheralWindow[] = [];
  const devices: BoardDeviceAttachment[] = [];
  const limitations = [...dt.limitations];
  const controllerNameByPath = new Map<string, string>();

  for (const node of dt.nodes) {
    if (
      node.path === "/" ||
      NON_MMIO_PREFIXES.some(
        (prefix) => node.path === prefix || node.path.startsWith(`${prefix}/`),
      )
    ) {
      continue;
    }
    const regProp = nodeProperty(node, "reg");
    const regEntries = regProp?.derived.reg ?? null;
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
        devices.push({
          id: node.path,
          name: compatible[0] ?? nodeShortName(node.path),
          kind: "listed_resource",
          peripheralName: controllerNameByPath.get(node.parent) ?? null,
          role: `Devicetree child at ${firstAddr}`,
          kconfigDefault: status === null || status === "okay",
          pins: [],
          evidence: `DTB ${dt.artifact.sha256} node ${node.path}`,
        });
      }
      continue;
    }

    for (const [regIndex, reg] of regEntries.entries()) {
      if (reg.address === null || reg.size === null) continue;
      const rawAddr = BigInt(reg.address);
      const rawSize = BigInt(reg.size);
      if (rawSize <= 0n || rawSize > BigInt(Number.MAX_SAFE_INTEGER)) continue;

      const translated = translateToCpuAddress(
        node.parent,
        rawAddr,
        rawSize,
        byPath,
        mappings,
      );
      if (!translated.ok) {
        if (translated.error === "device_bus" && regIndex === 0) {
          const parentController =
            node.parent === null
              ? null
              : (controllerNameByPath.get(node.parent) ?? null);
          devices.push({
            id: node.path,
            name: compatible[0] ?? nodeShortName(node.path),
            kind: "listed_resource",
            peripheralName: parentController,
            role: `Devicetree child at ${reg.address}`,
            kconfigDefault: status === null || status === "okay",
            pins: [],
            evidence: `DTB ${dt.artifact.sha256} node ${node.path}`,
          });
        } else if (translated.error !== "device_bus") {
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
          ? `${baseLabel}_${regIndex}`
          : `${baseLabel}@0x${cpuAddr.toString(16)}`;
      if (regIndex === 0) controllerNameByPath.set(node.path, name);
      peripherals.push({
        name,
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

  return {
    id: dt.summary.model ?? dt.summary.compatible?.[0] ?? dt.artifact.path,
    sourceKind: "devicetree",
    sourceSha256: dt.artifact.sha256,
    model: dt.summary.model,
    memory,
    peripherals,
    devices,
    limitations,
  };
};

const MAX_SVD_CHARS = 16 * 1024 * 1024;

const xmlTagText = (block: string, tag: string): string | null => {
  const match = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`, "i").exec(
    block,
  );
  return match?.[1] ? match[1].trim() : null;
};

const parseSvdInt = (raw: string | null): bigint | null => {
  if (raw === null || raw.length === 0) return null;
  const normalized = raw.startsWith("#") ? `0b${raw.slice(1)}` : raw;
  try {
    const val = BigInt(normalized);
    return val < 0n ? null : val;
  } catch {
    return null;
  }
};

const parseSvdRegisters = (block: string): CustomPeripheralRegister[] => {
  const regsSection = /<registers>([\s\S]*?)<\/registers>/i.exec(block)?.[1];
  if (!regsSection) return [];
  const registers: CustomPeripheralRegister[] = [];
  const regPattern = /<register\b[^>]*>([\s\S]*?)<\/register>/gi;
  let match: RegExpExecArray | null;
  while ((match = regPattern.exec(regsSection)) !== null) {
    const body = match[1] ?? "";
    const mnemonic = xmlTagText(body, "name");
    const offset = parseSvdInt(xmlTagText(body, "addressOffset"));
    if (mnemonic === null || offset === null) continue;
    const desc = xmlTagText(body, "description") ?? mnemonic;
    registers.push({ offset, mnemonic, name: desc.replace(/\s+/g, " ") });
  }
  return registers;
};

/**
 * Parse a CMSIS-SVD XML description into a `CustomHardwareProfile`, resolving
 * peripheral base addresses, `<addressBlock>` sizes, `derivedFrom` inheritance,
 * and register offsets for arbitrary vendor MCUs.
 */
export const parseCmsisSvd = (
  xml: string,
  options?: { readonly sha256?: string | null },
): Result<CustomHardwareProfile, string> => {
  if (typeof xml !== "string" || xml.length === 0) {
    return err("CMSIS-SVD input must be a non-empty XML string");
  }
  if (xml.length > MAX_SVD_CHARS) {
    return err("CMSIS-SVD input exceeds maximum 16 MiB text size");
  }
  const deviceMatch = /<device\b[^>]*>([\s\S]*?)<\/device>/i.exec(xml);
  if (!deviceMatch?.[1]) {
    return err("CMSIS-SVD input is missing a <device> root element");
  }
  const deviceBody = deviceMatch[1];
  const deviceName = xmlTagText(deviceBody, "name") ?? "svd-device";
  const peripheralsBody = /<peripherals>([\s\S]*?)<\/peripherals>/i.exec(
    deviceBody,
  )?.[1];
  if (!peripheralsBody) {
    return err("CMSIS-SVD <device> does not contain a <peripherals> section");
  }

  interface RawSvdPeripheral {
    readonly name: string;
    readonly derivedFrom: string | null;
    readonly base: bigint;
    readonly size: number | null;
    readonly group: string | null;
    readonly registers: readonly CustomPeripheralRegister[];
  }

  const rawList: RawSvdPeripheral[] = [];
  const periphPattern = /<peripheral\b([^>]*)>([\s\S]*?)<\/peripheral>/gi;
  let match: RegExpExecArray | null;
  while ((match = periphPattern.exec(peripheralsBody)) !== null) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    const headerBody = body.replace(/<registers>[\s\S]*?<\/registers>/gi, "");
    const name = xmlTagText(headerBody, "name");
    const base = parseSvdInt(xmlTagText(headerBody, "baseAddress"));
    if (name === null || base === null) continue;
    const derivedFrom =
      /derivedFrom\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? null;
    const addrBlock = /<addressBlock>([\s\S]*?)<\/addressBlock>/i.exec(
      headerBody,
    )?.[1];
    const blockOffset = addrBlock
      ? (parseSvdInt(xmlTagText(addrBlock, "offset")) ?? 0n)
      : 0n;
    const blockSize = addrBlock
      ? parseSvdInt(xmlTagText(addrBlock, "size"))
      : null;
    const totalSpan =
      blockSize !== null && blockSize > 0n
        ? Number(blockOffset + blockSize)
        : null;
    rawList.push({
      name,
      derivedFrom,
      base,
      size:
        totalSpan !== null && Number.isSafeInteger(totalSpan) && totalSpan > 0
          ? totalSpan
          : null,
      group: xmlTagText(headerBody, "groupName"),
      registers: parseSvdRegisters(body),
    });
  }

  const byName = new Map(rawList.map((item) => [item.name, item]));
  const peripherals: CustomPeripheralWindow[] = rawList.map((item) => {
    const parent =
      item.derivedFrom === null ? undefined : byName.get(item.derivedFrom);
    const registers =
      item.registers.length > 0 ? item.registers : (parent?.registers ?? []);
    const maxRegEnd = registers.reduce(
      (max, reg) => (reg.offset + 4n > max ? reg.offset + 4n : max),
      0n,
    );
    const inferredSize = maxRegEnd > 0n ? Number(maxRegEnd) : 0x400;
    const sizeBytes = item.size ?? parent?.size ?? inferredSize;
    return {
      name: item.name,
      baseAddress: `0x${item.base.toString(16)}`,
      baseAddressValue: item.base,
      sizeBytes,
      bus: item.group ?? parent?.group ?? null,
      compatible: [],
      status: null,
      registers: registers.map((reg) => ({
        offset: reg.offset,
        mnemonic: `${item.name}_${reg.mnemonic}`,
        name: `${item.name} ${reg.name}`,
      })),
    };
  });

  return ok({
    id: deviceName,
    sourceKind: "cmsis_svd",
    sourceSha256: options?.sha256 ?? null,
    model: deviceName,
    memory: [],
    peripherals,
    devices: [],
    limitations: [],
  });
};
