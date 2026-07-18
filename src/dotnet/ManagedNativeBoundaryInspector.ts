import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  managedNativeBoundaryInspectionSchema,
  type ManagedNativeBoundaryInspection,
  type ManagedParseIssue,
} from "../domain/managedArtifact.js";
import {
  readManagedMetadataInventory,
  type ManagedResourceDirectory,
} from "./ManagedMetadataInventory.js";
import {
  readManagedMetadataLayout,
  type ManagedMetadataLayout,
} from "./ManagedMetadataLayout.js";
import {
  readManagedPeLayout,
  type ManagedPeLayout,
} from "./ManagedPeReader.js";
import { ManagedReaderFailure } from "./ManagedReaderFailure.js";
import {
  buildNativeBoundaryInspection,
  cliNative,
  nativeImplementations,
  parseFields,
  parseImplMaps,
  parseMethods,
  parseModuleRefs,
} from "./ManagedNativeBoundaryHelpers.js";

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

type Inventory = ReturnType<typeof readManagedMetadataInventory>;

const emptyPage = <Item>(): ManagedNativeBoundaryInspection["module_refs"] & {
  items: readonly Item[];
} => ({
  items: [],
  offset: 0,
  limit: 0,
  total: 0,
  returned: 0,
  dropped: 0,
  complete: true,
});

const emptyInspection = (
  target: BinaryTarget,
  bytes: Buffer,
  classification: "not-managed" | "malformed" | "not-available" | "managed",
  issues: readonly ManagedParseIssue[] = [],
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
    metadata: {
      status:
        classification === "malformed" || classification === "not-available"
          ? "malformed"
          : "absent",
      version: null,
      table_row_counts: {},
    },
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
    module_refs: emptyPage(),
    pinvoke_imports: emptyPage(),
    native_implementations: emptyPage(),
    summary: {
      module_ref_count: 0,
      pinvoke_import_count: 0,
      native_implementation_count: 0,
      ready_to_run: false,
      mixed_mode_or_native_header: false,
    },
    coverage: { state: classification, issues },
    limitations: [
      "No CLI data was admitted; native boundary declarations are unavailable.",
      "Static inspection does not load or execute target code, so native export resolution is not performed.",
    ],
  });

const readBoundaryInventory = (
  bytes: Buffer,
  pe: ManagedPeLayout,
  limits: ManagedNativeBoundaryInspectionLimits,
): {
  readonly layout: ManagedMetadataLayout;
  readonly inventory: Inventory;
} => {
  const cli = pe.cli!;
  const metadataOffset = pe.rvaToOffset(
    cli.metadata.rva,
    cli.metadata.size,
    "cli.metadata",
  );
  const layout = readManagedMetadataLayout(
    bytes,
    metadataOffset,
    cli.metadata.size,
    limits.maxTableRows,
  );
  const resourceDirectory: ManagedResourceDirectory = {
    offset: pe.rvaToOffset(
      cli.resources.rva,
      cli.resources.size,
      "cli.resources",
    ),
    size: cli.resources.size,
  };
  const inventory = readManagedMetadataInventory(
    bytes,
    layout,
    {
      referenceOffset: 0,
      referenceLimit: 0,
      resourceOffset: 0,
      resourceLimit: 0,
      attributeOffset: 0,
      attributeLimit: 0,
      maxHeapItemBytes: limits.maxHeapItemBytes,
    },
    resourceDirectory,
  );
  return { layout, inventory };
};

const metadataLimitIssue = (
  cli: NonNullable<ManagedPeLayout["cli"]>,
  maxBytes: number,
): ManagedParseIssue => ({
  code: "limit-exceeded",
  scope: "cli.metadata",
  offset: cli.headerOffset + 8,
  detail: `CLI metadata size exceeds max_metadata_bytes ${String(maxBytes)}`,
});

/** Inspect managed/native boundary declarations from PE metadata without execution. */
export const inspectManagedNativeBoundariesBytes = (
  bytes: Buffer,
  target: BinaryTarget,
  limits: ManagedNativeBoundaryInspectionLimits,
): ManagedNativeBoundaryInspection => {
  let pe: ManagedPeLayout;
  try {
    pe = readManagedPeLayout(bytes);
  } catch (cause: unknown) {
    if (!(cause instanceof ManagedReaderFailure)) throw cause;
    return emptyInspection(target, bytes, "malformed", [cause.issue]);
  }
  if (pe.cli === null)
    return emptyInspection(
      target,
      bytes,
      pe.cliDirectoryPresent ? "malformed" : "not-managed",
      pe.cliIssue === null ? [] : [pe.cliIssue],
    );
  if (pe.cli.metadata.size > limits.maxMetadataBytes)
    return emptyInspection(target, bytes, "malformed", [
      metadataLimitIssue(pe.cli, limits.maxMetadataBytes),
    ]);
  let layout: ManagedMetadataLayout;
  let inventory: Inventory;
  try {
    ({ layout, inventory } = readBoundaryInventory(bytes, pe, limits));
  } catch (cause: unknown) {
    if (!(cause instanceof ManagedReaderFailure)) throw cause;
    return emptyInspection(target, bytes, "malformed", [cause.issue]);
  }
  const moduleRefs = parseModuleRefs(bytes, layout, limits.maxHeapItemBytes);
  const members = new Map([
    ...parseFields(bytes, layout, limits.maxHeapItemBytes),
    ...parseMethods(bytes, layout, limits.maxHeapItemBytes),
  ]);
  const imports = parseImplMaps({
    bytes,
    layout,
    maxBytes: limits.maxHeapItemBytes,
    modules: moduleRefs,
    members,
  });
  const pinvokeTokens = new Set(
    imports
      .map(({ member_token }) => member_token)
      .filter((token): token is string => token !== null),
  );
  const implementations = nativeImplementations(
    members.values(),
    pinvokeTokens,
  );
  return buildNativeBoundaryInspection({
    target,
    bytes,
    limits,
    pe,
    layout,
    inventory,
    moduleRefs,
    imports,
    implementations,
    native: cliNative(pe),
    issues: [],
  });
};
