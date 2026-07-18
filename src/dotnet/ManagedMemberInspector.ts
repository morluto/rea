import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  managedMemberInspectionSchema,
  type ManagedMemberInspection,
  type ManagedParseIssue,
} from "../domain/managedArtifact.js";
import {
  readManagedPeLayout,
  type ManagedPeLayout,
} from "./ManagedPeReader.js";
import {
  type ManagedResourceDirectory,
  managedTableRowCounts,
  readManagedMetadataInventory,
} from "./ManagedMetadataInventory.js";
import { readManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import {
  ManagedReaderFailure,
  managedFailure,
} from "./ManagedReaderFailure.js";
import {
  emptyPage,
  page,
  parseTypes,
  typeRanges,
  type ManagedMemberInspectionLimits,
} from "./ManagedMemberInspectorCore.js";
import {
  edges,
  parseFields,
  parseMemberRefs,
  parseMethods,
} from "./ManagedMemberRows.js";

export type { ManagedMemberInspectionLimits } from "./ManagedMemberInspectorCore.js";

const unavailable = (
  target: BinaryTarget,
  bytes: Buffer,
  limits: ManagedMemberInspectionLimits,
  issue: ManagedParseIssue | null,
): ManagedMemberInspection =>
  managedMemberInspectionSchema.parse({
    schema_version: 1,
    artifact: {
      path: target.path,
      sha256: target.sha256,
      byte_length: bytes.length,
      format: "pe",
    },
    module: null,
    metadata: {
      status: issue === null ? "absent" : "malformed",
      version: null,
      table_row_counts: {},
    },
    identity_scope: {
      token_identity: "build-local",
      requires_artifact_sha256: target.sha256,
      requires_mvid: null,
    },
    types: emptyPage(limits.typeOffset, limits.typeLimit),
    fields: emptyPage(limits.fieldOffset, limits.fieldLimit),
    methods: emptyPage(limits.methodOffset, limits.methodLimit),
    member_refs: emptyPage(limits.memberRefOffset, limits.memberRefLimit),
    call_edges: emptyPage(limits.edgeOffset, limits.edgeLimit),
    field_accesses: emptyPage(limits.edgeOffset, limits.edgeLimit),
    coverage: {
      state: "unavailable",
      issues: issue === null ? [] : [issue],
    },
    limitations: [
      issue === null
        ? "The PE has no admitted CLI metadata; managed member inspection is unavailable."
        : "The CLI metadata could not be admitted; managed member inspection is unavailable.",
    ],
  });

const resourceDirectory = (
  pe: ManagedPeLayout,
): ManagedResourceDirectory | null => {
  if (
    pe.cli === null ||
    pe.cli.resources.rva === 0 ||
    pe.cli.resources.size === 0
  )
    return null;
  return {
    offset: pe.rvaToOffset(
      pe.cli.resources.rva,
      pe.cli.resources.size,
      "cli.resources",
    ),
    size: pe.cli.resources.size,
  };
};

const collectMethodBodyIssues = (
  methods: ReturnType<typeof parseMethods>,
  limits: ManagedMemberInspectionLimits,
): ManagedParseIssue[] =>
  methods.methods.flatMap((method) =>
    method.body.status === "partial"
      ? [
          {
            code: "limit-exceeded" as const,
            scope: `method.${method.token}.body.instructions`,
            offset: method.body.file_offset,
            detail:
              method.body.issue ??
              `Instruction decode reached max_method_instructions ${String(limits.maxMethodInstructions)}`,
          },
        ]
      : [],
  );

const readMemberInventory = (
  bytes: Buffer,
  pe: ManagedPeLayout,
  limits: ManagedMemberInspectionLimits,
) => {
  const cli = pe.cli;
  if (cli === null)
    throw new TypeError("Managed inventory requires CLI metadata");
  const rootOffset = pe.rvaToOffset(
    cli.metadata.rva,
    cli.metadata.size,
    "cli.metadata",
  );
  if (cli.metadata.size > limits.maxMetadataBytes)
    throw managedFailure(
      "limit-exceeded",
      "metadata.root",
      `CLI metadata size exceeds max_metadata_bytes ${String(limits.maxMetadataBytes)}`,
      rootOffset,
    );
  const layout = readManagedMetadataLayout(
    bytes,
    rootOffset,
    cli.metadata.size,
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
    resourceDirectory(pe),
  );
  return { layout, inventory };
};

/** Inspect metadata members and method bodies without loading target code. */
export const inspectManagedMembersBytes = (
  bytes: Buffer,
  target: BinaryTarget,
  limits: ManagedMemberInspectionLimits,
): ManagedMemberInspection => {
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) return unavailable(target, bytes, limits, pe.cliIssue);
  const issues: ManagedParseIssue[] = [];
  try {
    const { layout, inventory } = readMemberInventory(bytes, pe, limits);
    issues.push(...inventory.issues);
    const ranges = typeRanges(bytes, layout, limits.maxHeapItemBytes);
    const types = parseTypes(bytes, layout, ranges, limits.maxHeapItemBytes);
    const fields = parseFields(bytes, layout, ranges, limits.maxHeapItemBytes);
    const memberRefs = parseMemberRefs(bytes, layout, limits.maxHeapItemBytes);
    const methods = parseMethods({
      bytes,
      layout,
      pe,
      ranges,
      maxBytes: limits.maxHeapItemBytes,
      limits,
    });
    const methodBodyIssues = collectMethodBodyIssues(methods, limits);
    const coverageIssues = [...issues, ...methodBodyIssues];
    const related = edges(
      methods.methods,
      methods.core,
      fields.core,
      memberRefs.core,
    );
    return managedMemberInspectionSchema.parse({
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
      types: page(types, limits.typeOffset, limits.typeLimit),
      fields: page(fields.fields, limits.fieldOffset, limits.fieldLimit),
      methods: page(methods.methods, limits.methodOffset, limits.methodLimit),
      member_refs: page(
        memberRefs.refs,
        limits.memberRefOffset,
        limits.memberRefLimit,
      ),
      call_edges: page(related.callEdges, limits.edgeOffset, limits.edgeLimit),
      field_accesses: page(
        related.fieldAccesses,
        limits.edgeOffset,
        limits.edgeLimit,
      ),
      coverage: {
        state: coverageIssues.length === 0 ? "complete" : "partial",
        issues: coverageIssues,
      },
      limitations: [
        "Metadata tokens are build-local coordinates and are only meaningful with the reported artifact SHA-256 and MVID.",
        "CIL instruction anchors are decoded from file-backed method bodies only; no target assembly is loaded or executed.",
        "Signatures are decoded for common ECMA-335 primitive, class, valuetype, pointer, byref, array, and generic variable forms; unsupported forms retain raw signature hashes.",
        ...(methodBodyIssues.length > 0
          ? [
              "At least one CIL method body reached max_method_instructions; its decoded prefix is partial and has no normalized CIL identity.",
            ]
          : []),
      ],
    });
  } catch (cause: unknown) {
    if (cause instanceof ManagedReaderFailure)
      return unavailable(target, bytes, limits, cause.issue);
    throw cause;
  }
};
