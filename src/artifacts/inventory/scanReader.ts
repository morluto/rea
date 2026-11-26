import type { AsarHeaderAdmission } from "../../config/asarHeaderAdmission.js";
import {
  artifactContainerIntegrityDetails,
  artifactIntegrityPair,
  artifactIntegrityDetails,
  type ArtifactContainerIntegrityPair,
  type ArtifactIntegrityPair,
  type SignedAfterPackingExplanation,
} from "../../domain/artifactIntegrity.js";
import { isAbsolute } from "node:path";
import { createHash, type Hash } from "node:crypto";

import {
  annotateEnglishUnicodeCaseCollisions,
  ArtifactPathRegistry,
  normalizeArtifactPath,
  ArtifactEntryContentUnavailable,
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactReaderTraversal,
  abortIfNeeded,
  DirectoryArtifactEntryAccessDenied,
  DirectoryArtifactReader,
  streamChunkToBuffer,
} from "../../resources/index.js";
import {
  ArtifactTraversalObservation,
  declaredArtifactEntries,
} from "../ArtifactTraversalObservation.js";
import type { ArtifactInventoryOptions } from "./types.js";
import { AsarArtifactReader } from "../AsarArtifactReader.js";
import {
  InesArtifactReader,
  type InesRegionScan,
} from "../InesArtifactReader.js";
import type { ArtifactNode } from "../../domain/artifactGraph.js";
import {
  classifyArtifactContent,
  classifyArtifactHeader,
  createArtifactNode,
  createOccurrence,
  noteUnreadContainerSuffix,
  indexDestinationOccurrencesByPath,
  resolveOccurrenceParents,
  type ArtifactParentResolution,
  type MutableOccurrence,
} from "./ArtifactGraphConstruction.js";
import { invariantViolation } from "../../domain/internalInvariant.js";
import type { ArtifactIntegrityPolicyName } from "../../domain/artifactIntegrityPolicy.js";
import { hashReadable } from "../ArtifactHash.js";
import {
  DirectoryTreeDigestBuilder,
  type DirectoryRootDigest,
} from "../../domain/directoryTreeDigest.js";
import {
  explainPeSignedAfterPacking,
  MAX_SIGNED_AFTER_PACKING_PE_BYTES,
  signedAfterPackingBudgetLimitation,
} from "../../native/pe/PeUnsignedDigest.js";

export interface PendingIntegrityContradiction {
  readonly occurrence: MutableOccurrence;
  readonly integrity: ArtifactIntegrityPair;
  readonly entryKind: "file" | "slice";
  readonly unpacked: boolean;
  readonly signingExplanation?: SignedAfterPackingExplanation;
}

const emptyScan = (): {
  readonly nodes: Map<string, ArtifactNode>;
  readonly occurrences: MutableOccurrence[];
  readonly pendingContradictions: PendingIntegrityContradiction[];
} => ({ nodes: new Map(), occurrences: [], pendingContradictions: [] });

interface ScanContext {
  readonly acquisitionLimits: ArtifactInventoryOptions["acquisitionLimits"];
  entriesExamined: number;
  bytesRead: number;
  readonly reader: ArtifactReader;
  readonly signal: AbortSignal | undefined;
  readonly integrity: ArtifactIntegrityPolicyName;
  readonly asarHeaderAdmission: AsarHeaderAdmission | undefined;
  readonly nodes: Map<string, ArtifactNode>;
  readonly occurrences: MutableOccurrence[];
  readonly pendingContradictions: PendingIntegrityContradiction[];
  readonly occurrenceCountByPath: Map<string, number>;
  readonly registry: ArtifactPathRegistry;
  readonly expandedContainerIds: Set<string>;
  readonly ownedReaders: ArtifactReader[];
  readonly reconstruction:
    | {
        readonly hash: Hash;
        readonly regionOrder: string[];
        bytes: number;
      }
    | undefined;
  readonly traversal: ArtifactTraversalObservation;
  /** The root directory's tree digest, collected from its own walk only. */
  readonly tree: DirectoryTreeDigestBuilder | undefined;
}

/** Special members the tree records without reading them. */
const RECORDED_SPECIAL_KINDS: ReadonlySet<string> = new Set([
  "fifo",
  "socket",
  "block-device",
  "character-device",
]);

export const scanReader = async (
  reader: ArtifactReader | undefined,
  ownedReaders: ArtifactReader[],
  signal?: AbortSignal,
  integrity: ArtifactIntegrityPolicyName = "fail",
  asarHeaderAdmission?: AsarHeaderAdmission,
  acquisitionLimits?: ArtifactInventoryOptions["acquisitionLimits"],
): Promise<{
  readonly nodes: Map<string, ArtifactNode>;
  readonly occurrences: MutableOccurrence[];
  readonly pendingContradictions: PendingIntegrityContradiction[];
  readonly caseCollisionLimitation: string | undefined;
  readonly inesRegionScan: InesRegionScan | undefined;
  readonly parentResolution: ArtifactParentResolution;
  readonly traversal: ArtifactReaderTraversal;
  /** A recorded disagreement between the root's own checksum and its bytes. */
  readonly rootContradiction: ArtifactContainerIntegrityPair | undefined;
  /** A directory root's tree digest; absent for every other root. */
  readonly rootDigest: DirectoryRootDigest | undefined;
}> => {
  const { nodes, occurrences, pendingContradictions } = emptyScan();
  if (reader === undefined)
    return {
      nodes,
      occurrences,
      pendingContradictions,
      caseCollisionLimitation: undefined,
      inesRegionScan: undefined,
      parentResolution: {
        unknownParentOccurrences: new Set(),
        limitations: [],
      },
      traversal: { status: "complete", limitations: [] },
      rootContradiction: undefined,
      rootDigest: undefined,
    };
  const maximumEntries = acquisitionLimits?.maximumEntries;
  if (
    maximumEntries !== undefined &&
    (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0)
  )
    throw invariantViolation(
      "Artifact inventory maximumEntries must be a nonnegative safe integer",
    );
  const context: ScanContext = {
    acquisitionLimits,
    entriesExamined: 0,
    bytesRead: 0,
    reader,
    signal,
    integrity,
    asarHeaderAdmission,
    nodes,
    occurrences,
    pendingContradictions,
    occurrenceCountByPath: new Map<string, number>(),
    registry: new ArtifactPathRegistry(),
    expandedContainerIds: new Set<string>(),
    ownedReaders,
    reconstruction:
      reader instanceof InesArtifactReader
        ? { hash: createHash("sha256"), regionOrder: [], bytes: 0 }
        : undefined,
    traversal: new ArtifactTraversalObservation(),
    tree:
      reader instanceof DirectoryArtifactReader
        ? new DirectoryTreeDigestBuilder()
        : undefined,
  };
  await visitArtifactEntries(context, reader, "");
  const rootContradiction = containerContradiction(reader, integrity);
  // Archive directories may appear after their children. Resolve containment
  // against the complete index before directory identities are materialized.
  const byPath = indexDestinationOccurrencesByPath(occurrences);
  const parentResolution = resolveOccurrenceParents(
    occurrences,
    byPath,
    context.expandedContainerIds,
  );
  return {
    nodes,
    occurrences,
    pendingContradictions,
    caseCollisionLimitation: annotateEnglishUnicodeCaseCollisions(occurrences),
    inesRegionScan:
      context.reconstruction === undefined
        ? undefined
        : {
            region_order: context.reconstruction.regionOrder,
            bytes: context.reconstruction.bytes,
            sha256: context.reconstruction.hash.digest("hex"),
          },
    parentResolution,
    traversal: context.traversal.snapshot(),
    rootContradiction,
    rootDigest: context.tree?.finish(),
  };
};

/** Apply the integrity policy to a checksum the root declares over its own bytes. */
const containerContradiction = (
  reader: ArtifactReader,
  integrity: ArtifactIntegrityPolicyName,
): ArtifactContainerIntegrityPair | undefined => {
  const pair = reader.containerIntegrity?.();
  if (pair === undefined || pair.declared_crc32 === pair.observed_crc32)
    return undefined;
  if (integrity === "fail")
    throw new ArtifactReaderFailure(
      "integrity",
      "Artifact integrity metadata disagrees with content: .",
      { integrityCheck: "declared-digest" },
      artifactContainerIntegrityDetails(".", pair),
    );
  return pair;
};

class InventoryAcquisitionLimit extends ArtifactReaderFailure {
  constructor() {
    super(
      "limit",
      "Artifact inventory acquisition allowance exhausted; member coverage is incomplete.",
    );
  }
}

const admitExaminedEntry = (context: ScanContext): void => {
  if (context.acquisitionLimits === undefined) return;
  if (context.entriesExamined >= context.acquisitionLimits.maximumEntries)
    throw new InventoryAcquisitionLimit();
  context.entriesExamined += 1;
};

const inventoryEntries = (
  context: ScanContext,
  reader: ArtifactReader,
  prefix: string,
): AsyncIterator<ArtifactEntry> => {
  // Only the root directory's own walk feeds its tree digest.
  const tree = reader === context.reader ? context.tree : undefined;
  return declaredArtifactEntries(reader, context.signal, {
    onCoverage: (coverage) => {
      context.traversal.record(coverage);
      if (coverage.status !== "complete")
        for (const limitation of coverage.limitations.length === 0
          ? ["The directory walk did not declare complete coverage."]
          : coverage.limitations)
          tree?.incomplete(limitation);
    },
    ...(reader instanceof DirectoryArtifactReader &&
    context.acquisitionLimits !== undefined
      ? {
          admitExaminedEntry: () => admitExaminedEntry(context),
        }
      : {}),
    onOmission: (omission) => {
      context.traversal.omit({
        ...omission,
        path:
          prefix.length === 0 ? omission.path : `${prefix}/${omission.path}`,
      });
      if (tree === undefined) return;
      // The tree records each name's exact bytes, never a normalized form.
      const path = omission.path;
      if (RECORDED_SPECIAL_KINDS.has(omission.kind))
        tree.add({
          kind: omission.kind as
            | "fifo"
            | "socket"
            | "block-device"
            | "character-device",
          path,
        });
      else
        tree.incomplete(
          `The walk omitted ${omission.kind} at ${JSON.stringify(path)}.`,
        );
    },
  })[Symbol.asyncIterator]();
};

const visitArtifactEntries = async (
  context: ScanContext,
  currentReader: ArtifactReader,
  prefix: string,
): Promise<void> => {
  const stack: Array<{
    readonly reader: ArtifactReader;
    readonly prefix: string;
    readonly containerId: string | null;
    readonly iterator: AsyncIterator<ArtifactEntry>;
  }> = [
    {
      reader: currentReader,
      prefix,
      containerId: null,
      iterator: inventoryEntries(context, currentReader, prefix),
    },
  ];
  let failure: { readonly cause: unknown } | undefined;
  try {
    while (stack.length > 0) {
      const frame = stack.at(-1);
      if (frame === undefined) break;
      const next = await frame.iterator.next();
      if (next.done) {
        stack.pop();
        continue;
      }
      const entry = next.value;
      if (!(frame.reader instanceof DirectoryArtifactReader))
        admitExaminedEntry(context);
      const logicalPath = normalizeArtifactPath(
        frame.prefix.length === 0
          ? entry.path
          : `${frame.prefix}/${entry.path}`,
      );
      const expandableAsar = isExpandableAsar(entry, logicalPath);
      // PyInstaller rows, Bun modules, and Deno virtual files are
      // source-distinct even when their logical destinations collide.
      // Inventory retains those observations; the extraction path registry
      // remains the authority for materialization.
      if (
        frame.reader.format !== "pyinstaller" &&
        frame.reader.format !== "bun-standalone" &&
        frame.reader.format !== "deno-standalone"
      )
        context.registry.add(
          logicalPath,
          expandableAsar ? "directory" : entry.kind,
        );
      const duplicateOrdinal =
        context.occurrenceCountByPath.get(logicalPath) ?? 0;
      context.occurrenceCountByPath.set(logicalPath, duplicateOrdinal + 1);
      const occurrence = createOccurrence(
        entry,
        logicalPath,
        entry.kind === "metadata" ? frame.containerId : null,
        { duplicateOrdinal, sourceFormat: frame.reader.format },
      );
      let digested:
        | {
            readonly node: ArtifactNode;
            readonly mismatched: boolean;
            readonly signingExplanation:
              | SignedAfterPackingExplanation
              | undefined;
            readonly classification: ReturnType<typeof classifyArtifactContent>;
          }
        | undefined;
      try {
        digested = await digestArtifactEntry(
          context,
          frame.reader,
          entry,
          logicalPath,
          occurrence,
        );
      } catch (cause: unknown) {
        if (
          !(cause instanceof DirectoryArtifactEntryAccessDenied) &&
          !(cause instanceof ArtifactEntryContentUnavailable)
        )
          throw cause;
        abortIfNeeded(context.signal);
        const limitation =
          cause instanceof ArtifactEntryContentUnavailable
            ? cause.limitation
            : cause.message;
        const traversal =
          cause instanceof ArtifactEntryContentUnavailable
            ? cause.traversal
            : { status: "unknown" as const, limitations: [limitation] };
        if (traversal !== undefined) context.traversal.record(traversal);
        occurrence.hash_status = "unavailable";
        // A reader that refuses content it already listed with a limitation
        // names the same reason on the entry and on the refusal.
        if (!occurrence.limitations.includes(limitation))
          occurrence.limitations.push(limitation);
      }
      if (digested === undefined) noteUnreadContainerSuffix(occurrence);
      else {
        context.nodes.set(digested.node.artifact_id, digested.node);
        occurrence.artifact_id = digested.node.artifact_id;
        const seaMainScript =
          entry.formatMetadata?.kind === "node-sea-entry" &&
          entry.formatMetadata.role === "main-script";
        occurrence.artifact_kind = seaMainScript
          ? "javascript"
          : digested.classification.kind;
        occurrence.artifact_format = seaMainScript
          ? "javascript-bundle"
          : digested.classification.format;
        occurrence.hash_status = digested.mismatched
          ? "mismatched"
          : "verified";
        if (digested.mismatched)
          occurrence.limitations.push(
            digested.signingExplanation === undefined
              ? "Declared integrity metadata contradicts observed bytes."
              : "Declared integrity metadata contradicts observed bytes; Authenticode signing after packing restores the declared SHA-256 when IMAGE_DIRECTORY_ENTRY_SECURITY is stripped. Bytes remain observed-untrusted.",
          );
      }
      context.occurrences.push(occurrence);
      if (frame.reader === context.reader && context.tree !== undefined)
        recordTreeMember(context.tree, entry, entry.path, digested?.node);
      if (
        expandableAsar &&
        digested !== undefined &&
        digested.classification.format === "asar" &&
        !digested.mismatched
      ) {
        const nested = new AsarArtifactReader(
          entry.adapterKey,
          context.asarHeaderAdmission === undefined
            ? {}
            : { headerAdmission: context.asarHeaderAdmission },
        );
        context.ownedReaders.push(nested);
        await nested.prepareContainer(digested.node.sha256, context.signal);
        // Only traversed containers can own members, not opaque ASAR-named files.
        context.expandedContainerIds.add(occurrence.occurrence_id);
        stack.push({
          reader: nested,
          prefix: logicalPath,
          containerId: occurrence.occurrence_id,
          iterator: inventoryEntries(context, nested, logicalPath),
        });
      }
    }
  } catch (cause: unknown) {
    if (cause instanceof InventoryAcquisitionLimit) {
      context.traversal.record({
        status: "unknown",
        limitations: [cause.message],
      });
      context.tree?.incomplete(cause.message);
    } else failure = { cause };
  } finally {
    // Readers remain owned by the inventory until its complete observation is built.
    for (const { iterator, prefix, reader } of stack.reverse()) {
      try {
        await iterator.return?.();
      } catch (cause: unknown) {
        failure = {
          cause: ArtifactReaderFailure.withCleanup(
            failure === undefined ? cause : failure.cause,
            ArtifactReaderFailure.cleanupObservation(
              cause,
              `artifact traversal for ${prefix || reader.format}`,
            ),
          ),
        };
      }
    }
  }
  if (failure !== undefined) throw failure.cause;
};

/** Record one root-directory member, or why it leaves the tree digest partial. */
const recordTreeMember = (
  tree: DirectoryTreeDigestBuilder,
  entry: ArtifactEntry,
  path: string,
  node: ArtifactNode | undefined,
): void => {
  if (entry.kind === "directory") tree.add({ kind: "directory", path });
  else if (entry.kind === "file" && node !== undefined)
    tree.add({ kind: "file", path, sha256: node.sha256 });
  else if (entry.kind === "symlink" && entry.linkTarget !== undefined)
    tree.add({ kind: "symlink", path, targetHex: entry.linkTarget.hex });
  else
    tree.incomplete(
      `The ${entry.kind} at ${JSON.stringify(path)} was not read, so its content is unknown.`,
    );
};

const digestArtifactEntry = async (
  context: ScanContext,
  currentReader: ArtifactReader,
  entry: ArtifactEntry,
  logicalPath: string,
  occurrence: MutableOccurrence,
): Promise<
  | {
      readonly node: ArtifactNode;
      readonly mismatched: boolean;
      readonly signingExplanation: SignedAfterPackingExplanation | undefined;
      readonly classification: ReturnType<typeof classifyArtifactContent>;
    }
  | undefined
> => {
  if ((entry.kind !== "file" && entry.kind !== "slice") || entry.encrypted)
    return undefined;
  if (
    context.acquisitionLimits !== undefined &&
    entry.declaredSize !== null &&
    entry.declaredSize >
      context.acquisitionLimits.maximumBytes - context.bytesRead
  )
    throw new InventoryAcquisitionLimit();
  const reconstruction =
    currentReader === context.reader ? context.reconstruction : undefined;
  if (reconstruction !== undefined && entry.byteOffset !== reconstruction.bytes)
    throw new ArtifactReaderFailure("integrity", "Noncontiguous iNES regions", {
      integrityCheck: "reconstruction",
    });
  const digest = await hashReadable(
    await currentReader.open(entry, context.signal),
    context.signal,
    entry.declaredIntegrity?.algorithm,
    context.asarHeaderAdmission,
    (chunk) => {
      if (
        context.acquisitionLimits !== undefined &&
        chunk.length >
          context.acquisitionLimits.maximumBytes - context.bytesRead
      )
        throw new InventoryAcquisitionLimit();
      context.bytesRead += chunk.length;
      if (reconstruction !== undefined) {
        reconstruction.hash.update(chunk);
        reconstruction.bytes += chunk.length;
      }
    },
  );
  reconstruction?.regionOrder.push(entry.path);
  const claim = entry.declaredIntegrity;
  const observed = claim?.algorithm === "md5" ? digest.md5 : digest.sha256;
  if (claim !== null && observed === undefined)
    throw new ArtifactReaderFailure(
      "integrity",
      "The selected integrity digest was not computed",
      { integrityCheck: "declared-digest" },
    );
  const mismatched = claim !== null && claim.digest !== observed;
  const sliceHeader =
    entry.kind === "slice"
      ? classifyArtifactHeader(digest, digest.bytes)
      : undefined;
  const classified =
    sliceHeader !== undefined
      ? {
          kind: "universal-slice" as const,
          format: "mach-o" as const,
          contentFormat: sliceHeader.format,
          contentArchitecture: sliceHeader.architecture,
        }
      : classifyArtifactContent(logicalPath, digest, digest.bytes);
  let signingExplanation: SignedAfterPackingExplanation | undefined;
  let explanationFailure: unknown;
  if (
    mismatched &&
    claim !== null &&
    observed !== undefined &&
    entry.unpacked &&
    claim.algorithm === "sha256" &&
    classified.contentFormat === "pe"
  ) {
    const mismatchDetails = artifactIntegrityDetails(
      logicalPath,
      claim,
      observed,
      entry.unpacked,
    );
    try {
      const attempt = await explainUnpackedPeSignedAfterPacking({
        reader: currentReader,
        entry,
        observedBytes: digest.bytes,
        observedSha256: digest.sha256,
        declaredSha256: claim.digest,
        signal: context.signal,
        context,
      });
      if (attempt.status === "explained")
        signingExplanation = attempt.explanation;
      else if (attempt.status === "skipped")
        occurrence.limitations.push(attempt.limitation);
    } catch (cause: unknown) {
      if (
        cause instanceof ArtifactReaderFailure &&
        (cause.cleanup !== undefined || (cause.cleanupLeases?.length ?? 0) > 0)
      ) {
        const cleanup = ArtifactReaderFailure.cleanupObservation(
          cause,
          `signing explanation for ${logicalPath}`,
        );
        if (context.signal?.aborted === true)
          throw ArtifactReaderFailure.withCleanup(
            new ArtifactReaderFailure(
              "cancelled",
              "Artifact inventory cancelled",
              { cause: context.signal.reason },
            ),
            cleanup,
            cause.partialObservation,
            cause.cleanupLeases,
          );
        // Keep the first mismatch digest pair when the optional read's cleanup
        // also fails; completed observations must survive later cleanup.
        throw ArtifactReaderFailure.withCleanup(
          new ArtifactReaderFailure(
            "integrity",
            `Artifact integrity metadata disagrees with content: ${logicalPath}`,
            {
              integrityCheck: "declared-digest",
              cause,
            },
            mismatchDetails,
          ),
          cleanup,
          cause.partialObservation,
          cause.cleanupLeases,
        );
      }
      abortIfNeeded(context.signal);
      if (
        !(cause instanceof ArtifactEntryContentUnavailable) &&
        !(cause instanceof DirectoryArtifactEntryAccessDenied) &&
        !(
          cause instanceof ArtifactReaderFailure &&
          (cause.reason === "io" || cause.reason === "unavailable")
        )
      )
        throw cause;
      if (cause.cancellation !== undefined) throw cause;
      explanationFailure = cause;
      occurrence.limitations.push(
        `Signing explanation unavailable: ${cause instanceof ArtifactEntryContentUnavailable ? cause.limitation : cause.message}`,
      );
    }
  }
  if (mismatched && claim !== null && observed !== undefined) {
    if (context.integrity === "fail")
      throw new ArtifactReaderFailure(
        "integrity",
        `Artifact integrity metadata disagrees with content: ${logicalPath}`,
        {
          integrityCheck: "declared-digest",
          ...(explanationFailure === undefined
            ? {}
            : { cause: explanationFailure }),
        },
        artifactIntegrityDetails(
          logicalPath,
          claim,
          observed,
          entry.unpacked,
          signingExplanation,
        ),
      );
    context.pendingContradictions.push({
      occurrence,
      integrity: artifactIntegrityPair(claim, observed),
      entryKind: entry.kind,
      unpacked: entry.unpacked,
      ...(signingExplanation === undefined ? {} : { signingExplanation }),
    });
  }
  return {
    node: createArtifactNode({
      sha256: digest.sha256,
      size: digest.bytes,
      format: classified.contentFormat,
      architecture: classified.contentArchitecture,
      contentState: "embedded",
    }),
    mismatched,
    signingExplanation,
    classification: classified,
  };
};

type SigningExplanationAttempt =
  | {
      readonly status: "explained";
      readonly explanation: SignedAfterPackingExplanation;
    }
  | { readonly status: "unexplained" }
  | { readonly status: "skipped"; readonly limitation: string };

const explainUnpackedPeSignedAfterPacking = async (input: {
  readonly reader: ArtifactReader;
  readonly entry: ArtifactEntry;
  readonly observedBytes: number;
  readonly observedSha256: string;
  readonly declaredSha256: string;
  readonly signal: AbortSignal | undefined;
  readonly context: ScanContext;
}): Promise<SigningExplanationAttempt> => {
  const {
    reader,
    entry,
    observedBytes,
    observedSha256,
    declaredSha256,
    signal,
    context,
  } = input;
  if (!Number.isSafeInteger(observedBytes) || observedBytes <= 0)
    return { status: "unexplained" };
  const remainingAcquisition =
    context.acquisitionLimits === undefined
      ? undefined
      : context.acquisitionLimits.maximumBytes - context.bytesRead;
  const budget = Math.min(
    MAX_SIGNED_AFTER_PACKING_PE_BYTES,
    remainingAcquisition ?? MAX_SIGNED_AFTER_PACKING_PE_BYTES,
  );
  if (observedBytes > budget)
    return {
      status: "skipped",
      limitation: signedAfterPackingBudgetLimitation(observedBytes, budget),
    };
  const stream = await reader.open(entry, signal);
  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let total = 0;
  for await (const raw of stream) {
    abortIfNeeded(signal);
    const chunk = streamChunkToBuffer(raw);
    if (
      context.acquisitionLimits !== undefined &&
      chunk.length > context.acquisitionLimits.maximumBytes - context.bytesRead
    )
      return {
        status: "skipped",
        limitation: signedAfterPackingBudgetLimitation(
          observedBytes,
          context.acquisitionLimits.maximumBytes,
        ),
      };
    total += chunk.length;
    if (total > observedBytes) return { status: "unexplained" };
    if (context.acquisitionLimits !== undefined)
      context.bytesRead += chunk.length;
    hash.update(chunk);
    chunks.push(chunk);
  }
  if (total !== observedBytes || hash.digest("hex") !== observedSha256)
    return { status: "unexplained" };
  const explanation = explainPeSignedAfterPacking(
    Buffer.concat(chunks, total),
    declaredSha256,
  );
  return explanation === null
    ? { status: "unexplained" }
    : { status: "explained", explanation };
};

const isExpandableAsar = (entry: ArtifactEntry, logicalPath: string): boolean =>
  entry.kind === "file" &&
  logicalPath.toLowerCase().endsWith(".asar") &&
  isAbsolute(entry.adapterKey);
