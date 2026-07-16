import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  managedNativeBoundaryInspectionSchema,
  type ManagedNativeBoundaryInspection,
  type ManagedParseIssue,
} from "../domain/managedArtifact.js";
import {
  metadataRowOffset,
  type ManagedMetadataLayout,
  readManagedMetadataLayout,
} from "./ManagedMetadataLayout.js";
import {
  MetadataRowCursor,
  metadataToken,
  readMetadataString,
} from "./ManagedMetadataHeaps.js";
import {
  readManagedMetadataInventory,
  managedTableRowCounts,
} from "./ManagedMetadataInventory.js";
import {
  readManagedPeLayout,
  type ManagedPeLayout,
} from "./ManagedPeReader.js";
import {
  ManagedReaderFailure,
  managedFailure,
} from "./ManagedReaderFailure.js";

/** Bounds for execution-free managed/native boundary inspection. */
export interface ManagedNativeBoundaryInspectionLimits {
  readonly moduleRefOffset: number;
  readonly moduleRefLimit: number;
  readonly importOffset: number;
  readonly importLimit: number;
  readonly implementationOffset: number;
  readonly implementationLimit: number;
  readonly maxMetadataBytes: number;
  readonly maxTableRows: number;
  readonly maxHeapItemBytes: number;
}

type Page<Item> = {
  readonly items: readonly Item[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly returned: number;
  readonly dropped: number;
  readonly complete: boolean;
};
type ModuleRef =
  ManagedNativeBoundaryInspection["module_refs"]["items"][number];
type NativeImport =
  ManagedNativeBoundaryInspection["pinvoke_imports"]["items"][number];
type NativeImplementation =
  ManagedNativeBoundaryInspection["native_implementations"]["items"][number];

interface MemberCore {
  readonly token: string;
  readonly rowOffset: number;
  readonly kind: NativeImport["member_kind"];
  readonly name: string;
  readonly flags: number;
  readonly implFlags: number | null;
  readonly rva: number | null;
}

const rowCursor = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  table: number,
  row: number,
): MetadataRowCursor => {
  const descriptor = layout.table(table);
  const start = metadataRowOffset(layout, table, row);
  if (descriptor === undefined)
    throw managedFailure(
      "invalid-row",
      `metadata.${String(table)}`,
      "Metadata table is absent",
      start,
    );
  return new MetadataRowCursor(
    bytes,
    start,
    start + descriptor.rowSize,
    `metadata.${descriptor.name}`,
  );
};

const codedToken = (
  raw: number,
  tagBits: number,
  tables: readonly number[],
): string | null => {
  const tagMask = (1 << tagBits) - 1;
  const table = tables[raw & tagMask];
  const row = raw >> tagBits;
  if (table === undefined || row === 0) return null;
  return metadataToken(table, row);
};

const flagsHex = (value: number): string =>
  `0x${value.toString(16).padStart(4, "0")}`;

const page = <Item>(
  items: readonly Item[],
  offset: number,
  limit: number,
): Page<Item> => {
  const safeOffset = Math.min(offset, items.length);
  const selected = items.slice(safeOffset, safeOffset + limit);
  return {
    items: selected,
    offset,
    limit,
    total: items.length,
    returned: selected.length,
    dropped: Math.max(0, items.length - safeOffset - selected.length),
    complete: safeOffset === 0 && selected.length === items.length,
  };
};

const parseModuleRefs = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  maxBytes: number,
): readonly ModuleRef[] => {
  const refs: ModuleRef[] = [];
  const table = layout.table(26);
  for (let row = 1; row <= (table?.rowCount ?? 0); row += 1) {
    const cursor = rowCursor(bytes, layout, 26, row);
    refs.push({
      token: metadataToken(26, row),
      row_offset: cursor.start,
      name: readMetadataString(
        bytes,
        layout,
        cursor.readIndex(layout.stringIndexSize),
        maxBytes,
      ),
    });
  }
  return refs;
};

const parseFields = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  maxBytes: number,
): ReadonlyMap<string, MemberCore> => {
  const fields = new Map<string, MemberCore>();
  const table = layout.table(4);
  for (let row = 1; row <= (table?.rowCount ?? 0); row += 1) {
    const cursor = rowCursor(bytes, layout, 4, row);
    const flags = cursor.readUInt16();
    const name = readMetadataString(
      bytes,
      layout,
      cursor.readIndex(layout.stringIndexSize),
      maxBytes,
    );
    cursor.readIndex(layout.blobIndexSize);
    const token = metadataToken(4, row);
    fields.set(token, {
      token,
      rowOffset: cursor.start,
      kind: "field",
      name,
      flags,
      implFlags: null,
      rva: null,
    });
  }
  return fields;
};

const parseMethods = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  maxBytes: number,
): ReadonlyMap<string, MemberCore> => {
  const methods = new Map<string, MemberCore>();
  const table = layout.table(6);
  for (let row = 1; row <= (table?.rowCount ?? 0); row += 1) {
    const cursor = rowCursor(bytes, layout, 6, row);
    const rva = cursor.readUInt32();
    const implFlags = cursor.readUInt16();
    const flags = cursor.readUInt16();
    const name = readMetadataString(
      bytes,
      layout,
      cursor.readIndex(layout.stringIndexSize),
      maxBytes,
    );
    cursor.readIndex(layout.blobIndexSize);
    cursor.readIndex(layout.tableIndexSize(8));
    const token = metadataToken(6, row);
    methods.set(token, {
      token,
      rowOffset: cursor.start,
      kind: "method",
      name,
      flags,
      implFlags,
      rva,
    });
  }
  return methods;
};

const parseImplMaps = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  maxBytes: number,
  modules: readonly ModuleRef[],
  members: ReadonlyMap<string, MemberCore>,
): readonly NativeImport[] => {
  const moduleNames = new Map(modules.map((module) => [module.token, module]));
  const imports: NativeImport[] = [];
  const table = layout.table(28);
  for (let row = 1; row <= (table?.rowCount ?? 0); row += 1) {
    const cursor = rowCursor(bytes, layout, 28, row);
    const mappingFlags = cursor.readUInt16();
    const memberToken = codedToken(
      cursor.readIndex(layout.codedIndexSize("MemberForwarded")),
      1,
      [4, 6],
    );
    const importName = readMetadataString(
      bytes,
      layout,
      cursor.readIndex(layout.stringIndexSize),
      maxBytes,
    );
    const importScopeRow = cursor.readIndex(layout.tableIndexSize(26));
    const importScopeToken =
      importScopeRow === 0 ? null : metadataToken(26, importScopeRow);
    const member = memberToken === null ? undefined : members.get(memberToken);
    imports.push({
      token: metadataToken(28, row),
      row_offset: cursor.start,
      mapping_flags: mappingFlags,
      mapping_flags_hex: flagsHex(mappingFlags),
      member_token: memberToken,
      member_kind: member?.kind ?? "unknown",
      member_name: member?.name ?? null,
      import_name: importName,
      import_scope_token: importScopeToken,
      import_scope_name:
        importScopeToken === null
          ? null
          : (moduleNames.get(importScopeToken)?.name ?? null),
      no_mangle: (mappingFlags & 0x0001) !== 0,
      char_set: charSet(mappingFlags),
      call_convention: callConvention(mappingFlags),
      supports_last_error: (mappingFlags & 0x0040) !== 0,
      best_fit: bestFit(mappingFlags),
      throw_on_unmappable_char: throwOnUnmappable(mappingFlags),
      verification: "managed-declaration-only",
    });
  }
  return imports;
};

const charSet = (flags: number): NativeImport["char_set"] => {
  switch (flags & 0x0006) {
    case 0x0000:
      return "not-specified";
    case 0x0002:
      return "ansi";
    case 0x0004:
      return "unicode";
    case 0x0006:
      return "auto";
    default:
      return "unknown";
  }
};

const callConvention = (flags: number): NativeImport["call_convention"] => {
  switch (flags & 0x0700) {
    case 0x0000:
      return "not-specified";
    case 0x0100:
      return "winapi";
    case 0x0200:
      return "cdecl";
    case 0x0300:
      return "stdcall";
    case 0x0400:
      return "thiscall";
    case 0x0500:
      return "fastcall";
    default:
      return "unknown";
  }
};

const bestFit = (flags: number): NativeImport["best_fit"] => {
  switch (flags & 0x0030) {
    case 0x0000:
      return "assembly-default";
    case 0x0010:
      return "enabled";
    case 0x0020:
      return "disabled";
    default:
      return "unknown";
  }
};

const throwOnUnmappable = (
  flags: number,
): NativeImport["throw_on_unmappable_char"] => {
  switch (flags & 0x3000) {
    case 0x0000:
      return "assembly-default";
    case 0x1000:
      return "enabled";
    case 0x2000:
      return "disabled";
    default:
      return "unknown";
  }
};

const nativeImplementations = (
  methods: Iterable<MemberCore>,
  pinvokeTokens: ReadonlySet<string>,
): readonly NativeImplementation[] => {
  const implementations: NativeImplementation[] = [];
  for (const method of methods) {
    const implFlags = method.implFlags ?? 0;
    const codeType = codeTypeFor(implFlags);
    const managedKind = managedKindFor(implFlags);
    const pinvokeDeclared =
      pinvokeTokens.has(method.token) || (method.flags & 0x2000) !== 0;
    if (!pinvokeDeclared && codeType === "il" && managedKind === "managed")
      continue;
    implementations.push({
      token: method.token,
      row_offset: method.rowOffset,
      name: method.name,
      rva: method.rva ?? 0,
      flags: method.flags,
      impl_flags: implFlags,
      code_type: codeType,
      managed_kind: managedKind,
      pinvoke_declared: pinvokeDeclared,
      boundary_kind: boundaryKind(pinvokeDeclared, codeType, managedKind),
      body_interpretation:
        codeType === "il" && managedKind === "managed" && !pinvokeDeclared
          ? "managed-cil"
          : method.rva === 0
            ? "not-file-backed"
            : "native-or-runtime",
    });
  }
  return implementations;
};

const codeTypeFor = (implFlags: number): NativeImplementation["code_type"] => {
  switch (implFlags & 0x0003) {
    case 0x0000:
      return "il";
    case 0x0001:
      return "native";
    case 0x0002:
      return "optil";
    case 0x0003:
      return "runtime";
    default:
      return "unknown";
  }
};

const managedKindFor = (
  implFlags: number,
): NativeImplementation["managed_kind"] => {
  switch (implFlags & 0x0004) {
    case 0x0000:
      return "managed";
    case 0x0004:
      return "unmanaged";
    default:
      return "unknown";
  }
};

const boundaryKind = (
  pinvokeDeclared: boolean,
  codeType: NativeImplementation["code_type"],
  managedKind: NativeImplementation["managed_kind"],
): NativeImplementation["boundary_kind"] => {
  if (pinvokeDeclared) return "pinvoke";
  if (codeType === "native") return "native-body";
  if (codeType === "runtime") return "runtime-provided";
  if (managedKind === "unmanaged") return "unmanaged-method";
  return "mixed-or-unknown";
};

const cliNative = (
  pe: ManagedPeLayout,
): ManagedNativeBoundaryInspection["cli_native"] => {
  if (pe.cli === null)
    return {
      il_only: false,
      requires_32bit: false,
      strong_name_signed: false,
      native_entry_point: false,
      ready_to_run_signature: false,
      managed_native_header_rva: 0,
      managed_native_header_size: 0,
    };
  return {
    il_only: (pe.cli.flags & 0x0000_0001) !== 0,
    requires_32bit: (pe.cli.flags & 0x0000_0002) !== 0,
    strong_name_signed: (pe.cli.flags & 0x0000_0008) !== 0,
    native_entry_point: (pe.cli.flags & 0x0000_0010) !== 0,
    ready_to_run_signature: pe.cli.readyToRunSignature,
    managed_native_header_rva: pe.cli.managedNativeHeader.rva,
    managed_native_header_size: pe.cli.managedNativeHeader.size,
  };
};

const unavailable = (
  target: BinaryTarget,
  bytes: Buffer,
  limits: ManagedNativeBoundaryInspectionLimits,
  issue: ManagedParseIssue | null,
): ManagedNativeBoundaryInspection =>
  managedNativeBoundaryInspectionSchema.parse({
    schema_version: 1,
    artifact: {
      path: target.path,
      sha256: target.sha256,
      byte_length: bytes.length,
      format: "pe",
    },
    module: null,
    metadata: { status: "absent", version: null, table_row_counts: {} },
    identity_scope: {
      token_identity: "build-local",
      requires_artifact_sha256: target.sha256,
      requires_mvid: null,
    },
    cli_native: {
      il_only: false,
      requires_32bit: false,
      strong_name_signed: false,
      native_entry_point: false,
      ready_to_run_signature: false,
      managed_native_header_rva: 0,
      managed_native_header_size: 0,
    },
    module_refs: page([], limits.moduleRefOffset, limits.moduleRefLimit),
    pinvoke_imports: page([], limits.importOffset, limits.importLimit),
    native_implementations: page(
      [],
      limits.implementationOffset,
      limits.implementationLimit,
    ),
    summary: {
      module_ref_count: 0,
      pinvoke_import_count: 0,
      native_implementation_count: 0,
      ready_to_run: false,
      mixed_mode_or_native_header: false,
    },
    coverage: {
      state: "unavailable",
      issues: issue === null ? [] : [issue],
    },
    limitations: [
      "The PE has no admitted CLI metadata; managed/native boundary inspection is unavailable.",
    ],
  });

/** Inspect PE/CLI managed/native boundary declarations without executing code. */
export const inspectManagedNativeBoundariesBytes = (
  bytes: Buffer,
  target: BinaryTarget,
  limits: ManagedNativeBoundaryInspectionLimits,
): ManagedNativeBoundaryInspection => {
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) return unavailable(target, bytes, limits, pe.cliIssue);
  const issues: ManagedParseIssue[] = [];
  try {
    const rootOffset = pe.rvaToOffset(
      pe.cli.metadata.rva,
      pe.cli.metadata.size,
      "cli.metadata",
    );
    if (pe.cli.metadata.size > limits.maxMetadataBytes)
      throw managedFailure(
        "limit-exceeded",
        "metadata.root",
        `CLI metadata size exceeds max_metadata_bytes ${String(limits.maxMetadataBytes)}`,
        rootOffset,
      );
    const layout = readManagedMetadataLayout(
      bytes,
      rootOffset,
      pe.cli.metadata.size,
      limits.maxTableRows,
    );
    const inventory = readManagedMetadataInventory(
      bytes,
      layout,
      {
        referenceOffset: 0,
        referenceLimit: 1,
        resourceOffset: 0,
        resourceLimit: 1,
        attributeOffset: 0,
        attributeLimit: 1,
        maxHeapItemBytes: limits.maxHeapItemBytes,
      },
      null,
    );
    issues.push(...inventory.issues);
    const moduleRefs = parseModuleRefs(bytes, layout, limits.maxHeapItemBytes);
    const fields = parseFields(bytes, layout, limits.maxHeapItemBytes);
    const methods = parseMethods(bytes, layout, limits.maxHeapItemBytes);
    const members = new Map([...fields, ...methods]);
    const imports = parseImplMaps(
      bytes,
      layout,
      limits.maxHeapItemBytes,
      moduleRefs,
      members,
    );
    const implementations = nativeImplementations(
      methods.values(),
      new Set(
        imports
          .map(({ member_token: token }) => token)
          .filter((token): token is string => token !== null),
      ),
    );
    const native = cliNative(pe);
    return managedNativeBoundaryInspectionSchema.parse({
      schema_version: 1,
      artifact: {
        path: target.path,
        sha256: target.sha256,
        byte_length: bytes.length,
        format: "pe",
      },
      module: inventory.module,
      metadata: {
        status: issues.length === 0 ? "complete" : "partial",
        version: layout.version,
        table_row_counts: managedTableRowCounts(layout),
      },
      identity_scope: {
        token_identity: "build-local",
        requires_artifact_sha256: target.sha256,
        requires_mvid: inventory.module?.mvid ?? null,
      },
      cli_native: native,
      module_refs: page(
        moduleRefs,
        limits.moduleRefOffset,
        limits.moduleRefLimit,
      ),
      pinvoke_imports: page(imports, limits.importOffset, limits.importLimit),
      native_implementations: page(
        implementations,
        limits.implementationOffset,
        limits.implementationLimit,
      ),
      summary: {
        module_ref_count: moduleRefs.length,
        pinvoke_import_count: imports.length,
        native_implementation_count: implementations.length,
        ready_to_run: native.ready_to_run_signature,
        mixed_mode_or_native_header:
          native.managed_native_header_rva !== 0 ||
          native.managed_native_header_size !== 0 ||
          native.native_entry_point,
      },
      coverage: {
        state: issues.length === 0 ? "complete" : "partial",
        issues,
      },
      limitations: [
        "P/Invoke rows prove managed import declarations only; this inspection does not verify that a native library, export, thunk, or provider-qualified function exists.",
        "Managed metadata tokens are build-local coordinates and are only meaningful with the reported artifact SHA-256 and MVID.",
        "ReadyToRun, NativeAOT, C++/CLI, and IL2CPP native semantics require separately selected native-provider evidence; this tool does not translate managed tokens into native addresses.",
      ],
    });
  } catch (cause: unknown) {
    if (cause instanceof ManagedReaderFailure)
      return unavailable(target, bytes, limits, cause.issue);
    throw cause;
  }
};
