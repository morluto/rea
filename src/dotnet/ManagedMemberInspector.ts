import {
  admitManagedProjection,
  managedDecodeBudget,
} from "./ManagedDecodeBudget.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import {
  managedMemberInspectionSchema,
  type ManagedMemberInspection,
  type ManagedParseIssue,
} from "../domain/managed/managedArtifact.js";
import {
  readManagedPeLayout,
  type ManagedPeLayout,
} from "./ManagedPeReader.js";
import {
  readManagedResourceDirectory,
  managedTableRowCounts,
  readManagedMetadataInventory,
} from "./ManagedMetadataInventory.js";
import { readManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import {
  ManagedReaderFailure,
  uniqueManagedParseIssues,
} from "./ManagedReaderFailure.js";
import { parseTypes, typeRanges } from "./ManagedMemberInspectorCore.js";
import {
  edges,
  parseFields,
  parseMemberRefs,
  parseMethods,
} from "./ManagedMemberRows.js";

const unavailable = (
  target: BinaryTarget,
  bytes: Buffer,
  issue: ManagedParseIssue | null,
): ManagedMemberInspection =>
  managedMemberInspectionSchema.parse(
    admitManagedProjection({
      artifact: {
        path: target.path,
        sha256: target.sha256,
        byte_length: bytes.length,
        format: "pe",
      },
      module: null,
      metadata: {
        status:
          issue === null
            ? "absent"
            : issue.code === "resource-limit"
              ? "partial"
              : "malformed",
        version: null,
        table_row_counts: {},
      },
      identity_scope: {
        token_identity: "build-local",
        requires_artifact_sha256: target.sha256,
        requires_mvid: null,
      },
      types: [],
      fields: [],
      methods: [],
      member_refs: [],
      call_edges: [],
      field_accesses: [],
      coverage: {
        state: "unavailable",
        issues: issue === null ? [] : [issue],
      },
      limitations: [
        issue === null
          ? "The PE has no admitted CLI metadata; managed member inspection is unavailable."
          : "The CLI metadata could not be admitted; managed member inspection is unavailable.",
      ],
    }),
  );

const readMemberInventory = (
  bytes: Buffer,
  pe: ManagedPeLayout,
  issues: ManagedParseIssue[],
) => {
  const cli = pe.cli;
  if (cli === null)
    throw new TypeError("Managed inventory requires CLI metadata");
  const rootOffset = pe.rvaToOffset(
    cli.metadata.rva,
    cli.metadata.size,
    "cli.metadata",
  );
  const layout = readManagedMetadataLayout(
    bytes,
    rootOffset,
    cli.metadata.size,
  );
  const inventory = readManagedMetadataInventory(
    bytes,
    layout,
    readManagedResourceDirectory(pe, issues),
  );
  return { layout, inventory };
};

/** Inspect metadata members and method bodies without loading target code. */
export const inspectManagedMembersBytes = (
  bytes: Buffer,
  target: BinaryTarget,
): ManagedMemberInspection => {
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) return unavailable(target, bytes, pe.cliIssue);
  const issues: ManagedParseIssue[] = [];
  try {
    const { layout, inventory } = readMemberInventory(bytes, pe, issues);
    issues.push(...inventory.issues);
    const ranges = typeRanges(bytes, layout, issues);
    const parsedTypes = parseTypes(bytes, layout, ranges);
    issues.push(...parsedTypes.issues);
    const fields = parseFields(bytes, layout, ranges);
    const memberRefs = parseMemberRefs(bytes, layout);
    issues.push(...memberRefs.issues);
    const methods = parseMethods({
      bytes,
      layout,
      pe,
      ranges,
    });
    issues.push(...fields.issues, ...methods.issues);
    const coverageIssues = uniqueManagedParseIssues(issues);
    const incompleteMembers =
      [...fields.fields, ...memberRefs.refs, ...methods.methods].some(
        (member) => member.signature.parse_status !== "decoded",
      ) ||
      methods.methods.some(
        (method) =>
          method.body.status === "partial" ||
          method.body.status === "malformed",
      );
    const related = edges(
      methods.methods,
      methods.core,
      fields.core,
      memberRefs.core,
    );
    return managedMemberInspectionSchema.parse(
      admitManagedProjection(
        {
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
          types: parsedTypes.types,
          fields: fields.fields,
          methods: methods.methods,
          member_refs: memberRefs.refs,
          call_edges: related.callEdges,
          field_accesses: related.fieldAccesses,
          coverage: {
            state:
              issues.length === 0 && !incompleteMembers
                ? "complete"
                : "partial",
            issues: coverageIssues,
          },
          limitations: [
            "Metadata tokens are build-local coordinates and are only meaningful with the reported artifact SHA-256 and MVID.",
            "CIL instruction anchors are decoded from file-backed method bodies only; no target assembly is loaded or executed.",
            "Signatures are decoded for common ECMA-335 primitive, class, valuetype, pointer, byref, array, and generic variable forms; unsupported forms retain raw signature hashes.",
          ],
        },
        managedDecodeBudget(layout),
      ),
    );
  } catch (cause: unknown) {
    if (cause instanceof ManagedReaderFailure)
      return unavailable(target, bytes, cause.issue);
    throw cause;
  }
};
