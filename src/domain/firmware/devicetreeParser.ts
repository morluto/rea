import {
  DEVICETREE_PROPERTY_PREVIEW_BYTES,
  type Devicetree,
  type InspectDevicetreeInput,
} from "./devicetree.js";
import { BinaryFormatFailure, BinaryReader } from "../binaryContainer.js";
import { readDevicetreeHeader } from "./devicetreeHeader.js";
import { decodeLimit, type ParseFailureError } from "../parseFailure.js";

/** The ParseFailure format of flattened devicetree blobs. */
export const DEVICETREE_FORMAT = "devicetree";

export type DevicetreeLimit = keyof Omit<InspectDevicetreeInput, "path">;

export const devicetreeLimitFailure = (
  limit: DevicetreeLimit,
  maximum: number,
): ParseFailureError<"limit"> =>
  decodeLimit(
    DEVICETREE_FORMAT,
    `Devicetree exceeds ${limit} (${String(maximum)}); raise that caller-selected limit within its schema ceiling or select a smaller blob.`,
    { name: limit, maximum },
  );

const malformed = (message: string): never => {
  throw new BinaryFormatFailure("malformed", message);
};
const align = (n: number) => Math.ceil(n / 4) * 4;
const hex = (n: bigint) => `0x${n.toString(16)}`;

const FDT_STRING_PROPERTIES: ReadonlySet<string> = new Set([
  "compatible",
  "model",
  "status",
  "bootargs",
  "stdout-path",
]);
const FDT_CHOSEN_SUMMARY_PROPERTIES: ReadonlySet<string> = new Set([
  "bootargs",
  "stdout-path",
]);
const FDT_SINGLE_CELL_PROPERTIES: ReadonlySet<string> = new Set([
  "phandle",
  "linux,phandle",
  "#address-cells",
  "#size-cells",
  "interrupt-parent",
  "remote-endpoint",
  "msi-parent",
]);
const FDT_PHANDLE_REFERENCE_PROPERTIES: ReadonlySet<string> = new Set([
  "interrupt-parent",
  "remote-endpoint",
  "msi-parent",
]);

/** Decode one DTB snapshot. Flat nodes retain explicit parent identity without recursive output. */
export const parseDevicetree = (
  bytes: Buffer,
  artifact: Devicetree["artifact"],
  input: InspectDevicetreeInput,
): { report: Devicetree; structureLimitations: readonly string[] } => {
  if (bytes.length > input.max_file_bytes)
    throw devicetreeLimitFailure("max_file_bytes", input.max_file_bytes);
  const {
    header,
    reservationEnd,
    structureEnd: structEnd,
  } = readDevicetreeHeader(bytes);
  const end = header.totalsize;
  if (end > bytes.length)
    malformed("Invalid FDT header size or compatibility version");
  const reader = new BinaryReader(bytes, false, DEVICETREE_FORMAT);
  const u32 = (offset: number) => reader.u32(offset);
  let decodedBytes = 0;
  const admit = (size: number) => {
    decodedBytes += size;
    if (decodedBytes > input.max_decoded_bytes)
      throw devicetreeLimitFailure(
        "max_decoded_bytes",
        input.max_decoded_bytes,
      );
  };
  const reservations: Devicetree["reservations"] = [];
  let cursor = header.off_mem_rsvmap;
  for (;;) {
    if (cursor > reservationEnd - 16)
      malformed("Unterminated or overlapping FDT reservation block");
    const address = reader.word(cursor, 64),
      size = reader.word(cursor + 8, 64);
    cursor += 16;
    if (address === 0n && size === 0n) break;
    if (reservations.length >= input.max_properties)
      throw devicetreeLimitFailure("max_properties", input.max_properties);
    admit(128);
    reservations.push({
      offset: cursor - 16,
      address: hex(address),
      size: hex(size),
    });
  }
  const text = (
    start: number,
    stop: number,
  ): { value: string; next: number } => {
    const nul = bytes.indexOf(0, start);
    if (nul < start || nul >= stop) return malformed("Unterminated FDT name");
    const raw = bytes.subarray(start, nul);
    if (raw.some((c) => c < 0x20 || c > 0x7e)) malformed("Non-ASCII FDT name");
    admit(raw.length * 2);
    return { value: raw.toString("ascii"), next: nul + 1 };
  };
  const names = new Map<number, string>();
  const propertiesByPath = new Map<
    string,
    Map<string, Devicetree["nodes"][number]["properties"][number]>
  >();
  const nodes: Devicetree["nodes"] = [];
  const stack: { node: Devicetree["nodes"][number]; children: boolean }[] = [];
  const paths = new Set<string>();
  let properties = 0,
    finished = false;
  cursor = header.off_dt_struct;
  const need = (n: number) => {
    if (cursor > structEnd - n)
      malformed("Truncated FDT structure token or property");
  };
  let nonzeroPaddingBytes = 0;
  let firstNonzeroPadding: number | undefined;
  const observePadding = (start: number, end: number) => {
    // Callers admit the aligned extent before observing its padding.
    for (let offset = start; offset < end; offset++) {
      if (bytes[offset] === 0) continue;
      nonzeroPaddingBytes += 1;
      firstNonzeroPadding ??= offset;
    }
  };
  while (cursor < structEnd) {
    need(4);
    const offset = cursor,
      token = u32(cursor);
    cursor += 4;
    if (token === 1) {
      if (stack.length >= input.max_depth)
        throw devicetreeLimitFailure("max_depth", input.max_depth);
      if (nodes.length >= input.max_nodes)
        throw devicetreeLimitFailure("max_nodes", input.max_nodes);
      const name = text(cursor, structEnd);
      const next = align(name.next);
      need(next - cursor);
      observePadding(name.next, next);
      cursor = next;
      const parent = stack.at(-1);
      if (
        name.value.includes("/") ||
        (!parent && (nodes.length > 0 || name.value !== "")) ||
        (parent && !name.value)
      )
        malformed("Invalid FDT node name or multiple roots");
      admit((parent?.node.path.length ?? 0) * 4 + name.value.length * 2 + 128);
      const path = parent
        ? `${parent.node.path === "/" ? "" : parent.node.path}/${name.value}`
        : "/";
      if (paths.has(path)) malformed("Duplicate FDT node path");
      paths.add(path);
      const node = {
        path,
        parent: parent?.node.path ?? null,
        offset,
        properties: [],
      } satisfies Devicetree["nodes"][number];
      if (parent) parent.children = true;
      propertiesByPath.set(path, new Map());
      nodes.push(node);
      stack.push({ node, children: false });
    } else if (token === 2) {
      if (!stack.pop()) malformed("Unbalanced FDT_END_NODE");
    } else if (token === 3) {
      const owner = stack.at(-1);
      if (!owner || owner.children)
        return malformed("FDT property outside node or after children");
      need(8);
      const length = u32(cursor),
        nameoff = u32(cursor + 4);
      cursor += 8;
      const end = cursor + length;
      const next = align(end);
      // Every open node needs an END_NODE token, followed by FDT_END.
      need(next - cursor + (stack.length + 1) * 4);
      observePadding(end, next);
      if (++properties > input.max_properties)
        throw devicetreeLimitFailure("max_properties", input.max_properties);
      if (nameoff >= header.size_dt_strings)
        malformed("FDT property string offset out of range");
      let name = names.get(nameoff);
      if (name === undefined) {
        name = text(
          header.off_dt_strings + nameoff,
          header.off_dt_strings + header.size_dt_strings,
        ).value;
        names.set(nameoff, name);
      }
      const propertyMap = propertiesByPath.get(owner.node.path);
      if (!name || propertyMap?.has(name))
        malformed("Empty or duplicate FDT property name");
      admit(
        name.length * 2 +
          Math.min(length, DEVICETREE_PROPERTY_PREVIEW_BYTES) * 2 +
          256,
      );
      const raw = bytes.subarray(cursor, cursor + length);
      // Only binding-independent standard strings and single-cell declarations are decoded.
      const stringProperty =
        FDT_STRING_PROPERTIES.has(name) || owner.node.path === "/aliases";
      if (stringProperty) admit(raw.length * 4);
      let strings: string[] | null = null;
      if (
        stringProperty &&
        raw.length > 0 &&
        raw.at(-1) === 0 &&
        raw.subarray(0, -1).every((c) => c === 0 || (c >= 0x20 && c <= 0x7e))
      ) {
        // Count entries before split allocates its array and individual strings.
        let entries = 0;
        for (const byte of raw) if (byte === 0) entries++;
        admit(entries * 32);
        const repeatedInSummary =
          (owner.node.path === "/" && name === "compatible") ||
          (entries === 1 &&
            ((owner.node.path === "/" && name === "model") ||
              (owner.node.path === "/chosen" &&
                FDT_CHOSEN_SUMMARY_PROPERTIES.has(name)) ||
              owner.node.path === "/aliases"));
        // Summary values serialize again, including quotes, commas and escapes.
        if (repeatedInSummary) admit(raw.length * 2 + entries * 3 + 2);
        strings = raw.subarray(0, -1).toString("ascii").split("\0");
      }
      const cells =
        FDT_SINGLE_CELL_PROPERTIES.has(name) && length === 4
          ? [u32(cursor)]
          : null;
      const property = {
        name,
        offset: cursor,
        bytes: length,
        hex: raw.subarray(0, DEVICETREE_PROPERTY_PREVIEW_BYTES).toString("hex"),
        truncated: length > DEVICETREE_PROPERTY_PREVIEW_BYTES,
        derived: { confidence: "derived" as const, strings, cells, reg: null },
      };
      owner.node.properties.push(property);
      propertyMap?.set(name, property);
      cursor = next;
    } else if (token === 9) {
      if (stack.length || nodes.length === 0) malformed("Premature FDT_END");
      if (header.size_dt_struct !== null && cursor !== structEnd)
        malformed("FDT_END does not terminate the declared structure block");
      finished = true;
      break;
    } else if (token !== 4) malformed(`Unknown FDT token ${token}`);
  }
  if (!finished) malformed("Missing FDT_END");
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  const prop = (path: string, name: string) =>
    propertiesByPath.get(path)?.get(name);
  const singleString = (path: string, name: string) => {
    const s = prop(path, name)?.derived.strings;
    return s?.length === 1 ? (s[0] ?? null) : null;
  };
  const handles = new Map<number, string | null>();
  // An editor can leave nonzero padding without changing the parsed fields.
  const structureLimitations =
    firstNonzeroPadding === undefined
      ? []
      : [
          `FDT structure padding contains ${String(nonzeroPaddingBytes)} nonzero ${nonzeroPaddingBytes === 1 ? "byte" : "bytes"}. The first is at file offset ${String(firstNonzeroPadding)}.`,
        ];
  const limitations = [
    ...structureLimitations,
    `Raw property previews are limited to ${String(DEVICETREE_PROPERTY_PREVIEW_BYTES)} bytes; offsets and lengths identify complete values in the hashed artifact.`,
    "Phandle references cover only single-cell interrupt-parent, remote-endpoint and msi-parent; binding-specific arrays and overlays are not resolved.",
  ];
  for (const node of nodes) {
    const phandleProperties = [
      prop(node.path, "phandle"),
      prop(node.path, "linux,phandle"),
    ];
    const malformedPhandles = phandleProperties.filter(
      (property): property is NonNullable<typeof property> =>
        property !== undefined && property.derived.cells === null,
    );
    const declared = phandleProperties.flatMap((property) => {
      const handle = property?.derived.cells?.[0];
      return handle === undefined ? [] : [handle];
    });
    for (const property of malformedPhandles) {
      admit(node.path.length * 2 + 256);
      limitations.push(
        `${property.name} at ${node.path} is not a single cell; this node's reference identity remains unresolved.`,
      );
    }
    // Disagreeing declarations leave both values ambiguous rather than choosing one.
    const conflict = declared.length === 2 && declared[0] !== declared[1];
    if (conflict) {
      admit(node.path.length * 2 + 256);
      limitations.push(
        `phandle at ${node.path} conflicts with linux,phandle (0x${declared[0]?.toString(16)} vs 0x${declared[1]?.toString(16)}); references to either value are unresolved.`,
      );
    }
    const unambiguous = malformedPhandles.length === 0 && !conflict;
    for (const handle of declared)
      if (handle !== 0 && handle !== 0xffffffff) {
        const existing = handles.get(handle);
        handles.set(
          handle,
          unambiguous && (existing === undefined || existing === node.path)
            ? node.path
            : null,
        );
      }
    const reg = prop(node.path, "reg");
    if (!reg || node.parent === null) continue;
    const count = (name: string, fallback: number) => {
      const p = prop(node.parent ?? "", name);
      return p === undefined ? fallback : p.derived.cells?.[0];
    };
    const addresses = count("#address-cells", 2),
      sizes = count("#size-cells", 1);
    if (
      addresses === undefined ||
      sizes === undefined ||
      addresses > 4 ||
      sizes > 4 ||
      addresses + sizes === 0 ||
      reg.bytes % ((addresses + sizes) * 4)
    ) {
      admit(node.path.length * 2 + 256);
      limitations.push(
        `reg at ${node.path} was not decoded: unsupported or malformed parent cell sizes or tuple length.`,
      );
      continue;
    }
    const readCells = (start: number, n: number) => {
      if (n === 0) return null;
      let value = 0n;
      for (let i = 0; i < n; i++)
        value = (value << 32n) | BigInt(u32(start + i * 4));
      return hex(value);
    };
    admit((reg.bytes / ((addresses + sizes) * 4)) * 160);
    reg.derived.reg = [];
    for (
      let p = reg.offset;
      p < reg.offset + reg.bytes;
      p += (addresses + sizes) * 4
    )
      reg.derived.reg.push({
        address: readCells(p, addresses),
        size: readCells(p + addresses * 4, sizes),
      });
  }
  const references: Devicetree["references"] = [];
  for (const node of nodes)
    for (const property of node.properties) {
      const phandle = property.derived.cells?.[0];
      if (
        FDT_PHANDLE_REFERENCE_PROPERTIES.has(property.name) &&
        phandle !== undefined
      ) {
        const target = handles.get(phandle) ?? null;
        // Shared path strings expand again in serialized Evidence for every edge.
        admit(
          256 +
            (node.path.length + property.name.length + (target?.length ?? 0)) *
              2,
        );
        references.push({
          source: node.path,
          property: property.name,
          phandle,
          target,
          confidence: "derived",
        });
      }
    }
  const report: Devicetree = {
    artifact,
    header,
    reservations,
    nodes,
    references,
    summary: {
      confidence: "derived",
      compatible: prop("/", "compatible")?.derived.strings ?? null,
      model: singleString("/", "model"),
      bootargs: singleString("/chosen", "bootargs"),
      stdout_path: singleString("/chosen", "stdout-path"),
      aliases: (byPath.get("/aliases")?.properties ?? []).map((p) => ({
        name: p.name,
        path: singleString("/aliases", p.name),
      })),
    },
    coverage: {
      status: "complete",
      examined_nodes: nodes.length,
      examined_properties: properties,
    },
    limitations,
  };
  return { report, structureLimitations };
};
