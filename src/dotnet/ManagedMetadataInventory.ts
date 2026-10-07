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

const validateIdentityTableCounts = (
  layout: ManagedMetadataLayout,
  issues: ManagedParseIssue[],
): void => {
  const moduleRows = layout.table(0)?.rowCount ?? 0;
  if (moduleRows !== 1)
    issues.push({
      code: "invalid-row",
      scope: "metadata.Module",
      offset: layout.table(0)?.offset ?? null,
      detail: `Module table must contain exactly one row; found ${String(moduleRows)}`,
    });

  const assemblyRows = layout.table(32)?.rowCount ?? 0;
  if (assemblyRows > 1)
    issues.push({
      code: "invalid-row",
      scope: "metadata.Assembly",
      offset: layout.table(32)?.offset ?? null,
      detail: `Assembly table can contain at most one row; found ${String(assemblyRows)}`,
    });
};

const readReferences = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  issues: ManagedParseIssue[],
): {
  readonly references: readonly AssemblyReference[];
  readonly referenceNames: readonly string[];
} => {
  const references = readRows(layout.table(35), (row) =>
    safeRead(
      () => readAssemblyReference(bytes, layout, row, heapExtent(layout)),
      issues,
    ),
  );
  return {
    references,
    referenceNames: [...new Set(references.map(({ name }) => name))].sort(),
  };
};

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
): {
  readonly attributes: readonly CustomAttribute[];
  readonly targetFrameworks: readonly string[];
} => {
  const attributes = readRows(layout.table(12), (row) =>
    safeRead(
      () => readCustomAttribute(bytes, layout, row, heapExtent(layout)),
      issues,
    ),
  );
  const targetFrameworks = new Set<string>();
  for (const attribute of attributes) {
    if (
      attribute.parent_token === metadataToken(32, 1) &&
      attribute.type_name ===
        "System.Runtime.Versioning.TargetFrameworkAttribute" &&
      attribute.decoded_fixed_string !== null
    )
      targetFrameworks.add(attribute.decoded_fixed_string);
  }
  return { attributes, targetFrameworks: [...targetFrameworks].sort() };
};

/** Inventory identity tables without CLR reflection or execution. */
export const readManagedMetadataInventory = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  resourceDirectory: ManagedResourceDirectory | null,
): ManagedMetadataInventory => {
  const issues: ManagedParseIssue[] = [];
  validateIdentityTableCounts(layout, issues);
  const module =
    safeRead(() => readModule(bytes, layout, heapExtent(layout)), issues) ??
    null;
  const assembly =
    safeRead(() => readAssembly(bytes, layout, heapExtent(layout)), issues) ??
    null;
  const { references, referenceNames } = readReferences(bytes, layout, issues);
  const resources = readResources({
    bytes,
    layout,
    resourceDirectory,
    issues,
  });
  const { attributes, targetFrameworks } = readAttributes(
    bytes,
    layout,
    issues,
  );
  return {
    module,
    assembly,
    targetFrameworks,
    referenceNames,
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
