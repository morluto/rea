import type {
  ManagedArtifactInspection,
  ManagedParseIssue,
} from "../domain/managedArtifact.js";
import {
  METADATA_TABLE_NAMES,
  type ManagedMetadataLayout,
  type MetadataTableLayout,
} from "./ManagedMetadataLayout.js";
import {
  readAssembly,
  readAssemblyReference,
  readCustomAttribute,
  readModule,
  readResource,
} from "./ManagedMetadataInventoryRows.js";
import { metadataToken } from "./ManagedMetadataHeaps.js";
import { ManagedReaderFailure } from "./ManagedReaderFailure.js";

type ModuleIdentity = NonNullable<ManagedArtifactInspection["module"]>;
type AssemblyIdentity = NonNullable<ManagedArtifactInspection["assembly"]>;
type AssemblyReference =
  ManagedArtifactInspection["references"]["items"][number];
type ManagedResource = ManagedArtifactInspection["resources"]["items"][number];
type CustomAttribute = ManagedArtifactInspection["attributes"]["items"][number];
type ManagedPage<Item> = {
  readonly items: readonly Item[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly returned: number;
  readonly dropped: number;
  readonly complete: boolean;
};

export interface ManagedInventoryInput {
  readonly referenceOffset: number;
  readonly referenceLimit: number;
  readonly resourceOffset: number;
  readonly resourceLimit: number;
  readonly attributeOffset: number;
  readonly attributeLimit: number;
  readonly maxHeapItemBytes: number;
}

export interface ManagedResourceDirectory {
  readonly offset: number;
  readonly size: number;
}

export interface ManagedMetadataInventory {
  readonly module: ModuleIdentity | null;
  readonly assembly: AssemblyIdentity | null;
  readonly targetFrameworks: readonly string[];
  readonly referenceNames: readonly string[];
  readonly references: ManagedPage<AssemblyReference>;
  readonly resources: ManagedPage<ManagedResource>;
  readonly attributes: ManagedPage<CustomAttribute>;
  readonly issues: readonly ManagedParseIssue[];
}

const safeRead = <Value>(
  operation: () => Value,
  issues: ManagedParseIssue[],
): Value | undefined => {
  try {
    return operation();
  } catch (cause: unknown) {
    if (!(cause instanceof ManagedReaderFailure)) throw cause;
    issues.push(cause.issue);
    return undefined;
  }
};

const pageRows = <Item>(
  descriptor: MetadataTableLayout | undefined,
  offset: number,
  limit: number,
  read: (row: number) => Item | undefined,
): ManagedPage<Item> => {
  const total = descriptor?.rowCount ?? 0;
  const items: Item[] = [];
  const end = Math.min(total, offset + limit);
  for (let index = offset; index < end; index += 1) {
    const item = read(index + 1);
    if (item !== undefined) items.push(item);
  }
  return {
    items,
    offset,
    limit,
    total,
    returned: items.length,
    dropped: total - items.length,
    complete: offset === 0 && end === total && items.length === total,
  };
};

const uniqueIssues = (
  issues: readonly ManagedParseIssue[],
): readonly ManagedParseIssue[] => [
  ...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values(),
];

const readPagedReferences = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  input: ManagedInventoryInput,
  issues: ManagedParseIssue[],
): ManagedPage<AssemblyReference> =>
  pageRows(
    layout.table(35),
    input.referenceOffset,
    input.referenceLimit,
    (row) =>
      safeRead(
        () => readAssemblyReference(bytes, layout, row, input.maxHeapItemBytes),
        issues,
      ),
  );

const readPagedResources = ({
  bytes,
  layout,
  input,
  resourceDirectory,
  issues,
}: {
  readonly bytes: Buffer;
  readonly layout: ManagedMetadataLayout;
  readonly input: ManagedInventoryInput;
  readonly resourceDirectory: ManagedResourceDirectory | null;
  readonly issues: ManagedParseIssue[];
}): ManagedPage<ManagedResource> =>
  pageRows(layout.table(40), input.resourceOffset, input.resourceLimit, (row) =>
    safeRead(
      () =>
        readResource({
          bytes,
          layout,
          row,
          maxBytes: input.maxHeapItemBytes,
          directory: resourceDirectory,
          issues,
        }),
      issues,
    ),
  );

const readPagedAttributes = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  input: ManagedInventoryInput,
  issues: ManagedParseIssue[],
): ManagedPage<CustomAttribute> =>
  pageRows(
    layout.table(12),
    input.attributeOffset,
    input.attributeLimit,
    (row) =>
      safeRead(
        () => readCustomAttribute(bytes, layout, row, input.maxHeapItemBytes),
        issues,
      ),
  );

const collectReferenceNames = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  maxBytes: number,
  issues: ManagedParseIssue[],
): readonly string[] => {
  const names: string[] = [];
  const referenceTable = layout.table(35);
  for (let row = 1; row <= (referenceTable?.rowCount ?? 0); row += 1) {
    const reference = safeRead(
      () => readAssemblyReference(bytes, layout, row, maxBytes),
      issues,
    );
    if (reference !== undefined) names.push(reference.name);
  }
  return names;
};

const collectTargetFrameworks = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  maxBytes: number,
  issues: ManagedParseIssue[],
): readonly string[] => {
  const targetFrameworks: string[] = [];
  const attributeTable = layout.table(12);
  for (let row = 1; row <= (attributeTable?.rowCount ?? 0); row += 1) {
    const attribute = safeRead(
      () => readCustomAttribute(bytes, layout, row, maxBytes),
      issues,
    );
    if (
      attribute?.parent_token === metadataToken(32, 1) &&
      attribute.type_name ===
        "System.Runtime.Versioning.TargetFrameworkAttribute" &&
      attribute.decoded_fixed_string !== null &&
      !targetFrameworks.includes(attribute.decoded_fixed_string)
    )
      targetFrameworks.push(attribute.decoded_fixed_string);
  }
  return targetFrameworks;
};

/** Inventory bounded identity tables without CLR reflection or execution. */
export const readManagedMetadataInventory = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  input: ManagedInventoryInput,
  resourceDirectory: ManagedResourceDirectory | null,
): ManagedMetadataInventory => {
  const issues: ManagedParseIssue[] = [];
  const module =
    safeRead(() => readModule(bytes, layout, input.maxHeapItemBytes), issues) ??
    null;
  const assembly =
    safeRead(
      () => readAssembly(bytes, layout, input.maxHeapItemBytes),
      issues,
    ) ?? null;
  const references = readPagedReferences(bytes, layout, input, issues);
  const resources = readPagedResources({
    bytes,
    layout,
    input,
    resourceDirectory,
    issues,
  });
  const attributes = readPagedAttributes(bytes, layout, input, issues);
  const referenceNames = collectReferenceNames(
    bytes,
    layout,
    input.maxHeapItemBytes,
    issues,
  );
  const targetFrameworks = collectTargetFrameworks(
    bytes,
    layout,
    input.maxHeapItemBytes,
    issues,
  );
  return {
    module,
    assembly,
    targetFrameworks: [...targetFrameworks].sort(),
    referenceNames: [...new Set(referenceNames)].sort(),
    references,
    resources,
    attributes,
    issues: uniqueIssues(issues),
  };
};

/** Stable table-name/count projection for caller-visible coverage. */
export const managedTableRowCounts = (
  layout: ManagedMetadataLayout,
): Readonly<Record<string, number>> =>
  Object.fromEntries(
    [...layout.tables.values()].map(({ index, rowCount }) => [
      METADATA_TABLE_NAMES[index] ?? `Table${String(index)}`,
      rowCount,
    ]),
  );
