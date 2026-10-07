import type {
  ManagedArtifactInspection,
  ManagedParseIssue,
} from "../domain/managed/managedArtifact.js";
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
type AssemblyReference = ManagedArtifactInspection["references"][number];
type ManagedResource = ManagedArtifactInspection["resources"][number];
type CustomAttribute = ManagedArtifactInspection["attributes"][number];
export interface ManagedResourceDirectory {
  readonly offset: number;
  readonly size: number;
}

export interface ManagedMetadataInventory {
  readonly module: ModuleIdentity | null;
  readonly assembly: AssemblyIdentity | null;
  readonly targetFrameworks: readonly string[];
  readonly referenceNames: readonly string[];
  readonly references: readonly AssemblyReference[];
  readonly resources: readonly ManagedResource[];
  readonly attributes: readonly CustomAttribute[];
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

const readRows = <Item>(
  descriptor: MetadataTableLayout | undefined,
  read: (row: number) => Item | undefined,
): readonly Item[] => {
  const total = descriptor?.rowCount ?? 0;
  const items: Item[] = [];
  for (let index = 0; index < total; index += 1) {
    const item = read(index + 1);
    if (item !== undefined) items.push(item);
  }
  return items;
};

const uniqueIssues = (
  issues: readonly ManagedParseIssue[],
): readonly ManagedParseIssue[] => [
  ...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values(),
];

const heapExtent = (layout: ManagedMetadataLayout): number =>
  Math.max(layout.strings.size, layout.blob.size);

const readReferences = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  issues: ManagedParseIssue[],
): readonly AssemblyReference[] =>
  readRows(layout.table(35), (row) =>
    safeRead(
      () => readAssemblyReference(bytes, layout, row, heapExtent(layout)),
      issues,
    ),
  );

const readResources = ({
  bytes,
  layout,
  resourceDirectory,
  issues,
}: {
  readonly bytes: Buffer;
  readonly layout: ManagedMetadataLayout;
  readonly resourceDirectory: ManagedResourceDirectory | null;
  readonly issues: ManagedParseIssue[];
}): readonly ManagedResource[] =>
  readRows(layout.table(40), (row) =>
    safeRead(
      () =>
        readResource({
          bytes,
          layout,
          row,
          directory: resourceDirectory,
          issues,
        }),
      issues,
    ),
  );

const readAttributes = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  issues: ManagedParseIssue[],
): readonly CustomAttribute[] =>
  readRows(layout.table(12), (row) =>
    safeRead(
      () => readCustomAttribute(bytes, layout, row, heapExtent(layout)),
      issues,
    ),
  );

const collectReferenceNames = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  issues: ManagedParseIssue[],
): readonly string[] => {
  const names: string[] = [];
  const referenceTable = layout.table(35);
  for (let row = 1; row <= (referenceTable?.rowCount ?? 0); row += 1) {
    const reference = safeRead(
      () => readAssemblyReference(bytes, layout, row, heapExtent(layout)),
      issues,
    );
    if (reference !== undefined) names.push(reference.name);
  }
  return names;
};

const collectTargetFrameworks = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  issues: ManagedParseIssue[],
): readonly string[] => {
  const targetFrameworks: string[] = [];
  const attributeTable = layout.table(12);
  for (let row = 1; row <= (attributeTable?.rowCount ?? 0); row += 1) {
    const attribute = safeRead(
      () => readCustomAttribute(bytes, layout, row, heapExtent(layout)),
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

/** Inventory identity tables without CLR reflection or execution. */
export const readManagedMetadataInventory = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  resourceDirectory: ManagedResourceDirectory | null,
): ManagedMetadataInventory => {
  const issues: ManagedParseIssue[] = [];
  const module =
    safeRead(() => readModule(bytes, layout, heapExtent(layout)), issues) ??
    null;
  const assembly =
    safeRead(() => readAssembly(bytes, layout, heapExtent(layout)), issues) ??
    null;
  const references = readReferences(bytes, layout, issues);
  const resources = readResources({
    bytes,
    layout,
    resourceDirectory,
    issues,
  });
  const attributes = readAttributes(bytes, layout, issues);
  const referenceNames = collectReferenceNames(bytes, layout, issues);
  const targetFrameworks = collectTargetFrameworks(bytes, layout, issues);
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
