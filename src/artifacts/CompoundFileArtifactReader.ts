import { Readable } from "node:stream";

import { Budget } from "../domain/budget.js";
import { invariantViolation } from "../domain/internalInvariant.js";
import type {
  CompoundFileEntryMetadata,
  CompoundFileMetadata,
} from "../domain/formatMetadata/androidAndSystemMetadata.js";
import type { RegionDecodeFailure } from "../domain/firmware/regionDecoder.js";
import {
  COMPOUND_FILE_FIXED_LIMITS,
  COMPOUND_FILE_PATH_ALLOWANCE,
  createCompoundFileDecoder,
  type CompoundFileChainProblem,
  type CompoundFileDirectoryEntry,
  type CompoundFileImage,
} from "../domain/windows/compoundFile.js";
import {
  ArtifactFileSource,
  ArtifactReaderFailure,
  ArtifactResourceScope,
  artifactFixedLimitFailure,
  artifactReadCancelledBy,
  assertArtifactReadActive,
  copyArtifactEntry,
  malformedArtifact,
  normalizeArtifactPath,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOptions,
} from "../resources/index.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import { AbortedWait, waitForAbortable } from "../process/AbortablePromise.js";
import {
  ArtifactStreamLifecycle,
  checkedArtifactMemberStream,
  ownArtifactStream,
} from "./OwnedArtifactStream.js";

/**
 * A compound file's directories and allocation tables describe containers
 * inside the file, so every directory entry is one inventory occurrence. A
 * stream's bytes are listed but not interpreted: what a Jump List's DestList or
 * a shell link's target means is an artifact-specific question for later steps.
 */
export class CompoundFileArtifactReader implements ArtifactReader {
  readonly format = "compound-file" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #source: ArtifactFileSource;
  readonly #entries = new Map<string, ArtifactEntry>();
  readonly #lifecycle = new ArtifactStreamLifecycle("compound file");
  /** Logical path to source ordinal, so `open` finds the entry it was given. */
  readonly #byPath = new Map<string, string>();
  #prepared:
    | { signal: AbortSignal | undefined; promise: Promise<void> }
    | undefined;
  #metadata: CompoundFileMetadata | undefined;
  #limitations: readonly string[] = [];

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    this.#source = new ArtifactFileSource(path, "compound file", admitted);
  }

  formatMetadata(): CompoundFileMetadata | undefined {
    return this.#metadata === undefined ? undefined : { ...this.#metadata };
  }

  async prepareContainer(
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      await this.#source.bindSha256(expectedSha256, signal);
    });
  }

  async *entries(
    signal?: AbortSignal,
    options?: ArtifactTraversalOptions,
  ): AsyncIterable<ArtifactEntry> {
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      await this.#awaitPreparation(signal);
      // Cached entries outlive the traversal that produced them, so a source
      // rewritten since then must be noticed here rather than reported stale.
      await this.#source.read(signal);
      this.#assertOpen(signal);
    });
    // Only an entry without a name or outside the root's tree has no path; the
    // parse already names each of those in its limitations.
    options?.onCoverage?.(
      this.#limitations.length === 0
        ? { status: "complete", limitations: [] }
        : { status: "unknown", limitations: [...this.#limitations] },
    );
    for (const entry of this.#entries.values()) {
      this.#assertOpen(signal);
      yield copyArtifactEntry(entry);
    }
    this.#assertOpen(signal);
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      this.#assertOpen(signal);
      const key = this.#byPath.get(entry.path);
      const stored = key === undefined ? undefined : this.#entries.get(key);
      if (stored === undefined || !sameRange(entry, stored))
        throw new ArtifactReaderFailure(
          "integrity",
          `compound file entry does not match its owning inventory: ${entry.path}`,
          { integrityCheck: "entry-metadata" },
        );
      // A zero-byte stream has no sector range and opens as an empty stream;
      // requiring a byte offset here would make every empty file unreadable.
      // The carrier is verified first so a source rewritten after the
      // inventory is not accepted here while every non-empty member rejects it.
      if (stored.declaredSize === 0) {
        await this.#source.read(signal);
        this.#assertOpen(signal);
        return Readable.from([]);
      }
      if (stored.byteOffset === null || stored.declaredSize === null)
        throw malformedArtifact(
          "compound-file",
          `compound file stream has no contiguous byte range: ${stored.path}`,
        );
      const { handle } = await this.#source.read(signal);
      this.#assertOpen(signal);
      const label = "compound file";
      const member = this.#lifecycle.member(signal);
      const source = readFileHandleChunks(handle, {
        start: stored.byteOffset,
        end: stored.byteOffset + stored.declaredSize - 1,
        signal: member.signal,
        cancellationFailure: member.cancellationFailure,
      });
      const output = checkedArtifactMemberStream(
        stored,
        label,
        (detail) =>
          new ArtifactReaderFailure("integrity", `${label} ${detail}`, {
            integrityCheck: "member-identity",
          }),
        () => member.verify((active) => this.#source.read(active)),
      );
      ownArtifactStream(source, output, {
        scope: this.#scope,
        signal: member.signal,
        cancellationFailure: member.cancellationFailure,
        label,
      });
      return output;
    });
  }

  async close(): Promise<void> {
    this.#lifecycle.close();
    await this.#scope.close();
    await this.#source.close();
    this.#prepared = undefined;
    this.#entries.clear();
    this.#byPath.clear();
    this.#metadata = undefined;
  }

  provenance(): readonly [] {
    return [];
  }

  #assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#lifecycle.closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "compound file reader is closed",
      );
  }

  /**
   * Wait for the shared preparation, but let this caller cancel its own wait.
   * A preparation started under another caller's signal stays cached when that
   * caller aborts, so this traversal retries under its own signal instead of
   * inheriting a cancellation it never received.
   */
  async #awaitPreparation(signal?: AbortSignal): Promise<void> {
    for (;;) {
      this.#assertOpen(signal);
      const pending = (this.#prepared ??= {
        signal,
        promise: this.#scope.track(() => this.#prepare(signal)),
      });
      try {
        const outcome = await waitForAbortable(pending.promise, signal);
        if (outcome instanceof AbortedWait)
          throw new ArtifactReaderFailure(
            "cancelled",
            "compound file read cancelled",
            { cause: outcome.carried },
          );
        return;
      } catch (cause: unknown) {
        // A cancelled waiter aborts only its own wait: the preparation it was
        // borrowing keeps running under its starter's signal, and discarding it
        // here would make the next caller read and parse the file again.
        if (signal?.aborted === true) throw cause;
        if (this.#prepared === pending) this.#prepared = undefined;
        if (
          pending.signal !== signal &&
          artifactReadCancelledBy(cause, pending.signal)
        )
          continue;
        throw cause;
      }
    }
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const image = await this.#decode(signal);
    // Directory entries are keyed by their source ordinal, not by path: a
    // damaged tree can hold two entries with the same logical path, and one
    // must not silently replace the other.
    const claimed = new Set<string>();
    // The parser's allowance bounds the paths it stores, not the ones the
    // reader rebuilds under a placed parent, so the reader charges its own
    // retained path text against the same ceiling.
    const pathBudget = new Budget(COMPOUND_FILE_PATH_ALLOWANCE);
    // Each admitted record may need its ordinal plus a collision suffix. Both
    // numbers are bounded by the directory count. Release each reservation
    // immediately before selecting and charging the retained path.
    const maxOrdinal = String(image.entries.length);
    const fallbackReservation = `entry-${maxOrdinal}-${maxOrdinal}`.length;
    pathBudget.charge(image.entries.length * fallbackReservation, () =>
      invariantViolation(
        "Compound file directory exceeds its fallback path reservation",
      ),
    );
    // A storage renamed by claimPath moves its whole subtree, so each parent's
    // placed path is carried to its descendants: otherwise a child would keep
    // the declared prefix while its parent was listed somewhere else, and the
    // registry rejects that as a file prefix. Directory ordinals say nothing
    // about parent-before-child, so a child whose parent is not placed yet
    // waits until it is instead of claiming a prefix its parent may lose.
    const placedByIndex = new Map<
      number,
      { path: string; materializable: boolean }
    >();
    const entries = new Map<string, ArtifactEntry>();
    const byPath = new Map<string, string>();
    let incompletePlacement = false;
    const place = (entry: CompoundFileDirectoryEntry): void => {
      pathBudget.refund(fallbackReservation);
      const artifact = toArtifactEntry(entry);
      if (artifact === null) return;
      const key = String(entry.index);
      const declaredParent = entry.parentIndex;
      const parent =
        declaredParent === null ? undefined : placedByIndex.get(declaredParent);
      const parentPath = parent?.path ?? "";
      // The parser owns where its tree lists a member: the parent's placed path
      // plus the member's own usable component. `path` may be null because the
      // entry is an orphan, an ancestor's name cannot name a path, or the
      // cumulative allowance stopped retaining the text; in every case the
      // parent and this entry's component still say where the directory put it,
      // and claiming it at the root would invent a member the tree never holds.
      const component = entry.component;
      const listed =
        parent === undefined || component === null
          ? null
          : parentPath === ""
            ? component
            : `${parentPath}/${component}`;
      const projected =
        listed === null || listed === artifact.path
          ? artifact
          : { ...artifact, path: listed };
      const placed = claimPath(
        projected,
        parentPath,
        claimed,
        pathBudget,
        entry.index,
      );
      // A flat ordinal is an inventory label if the allowance could not
      // retain a path within its storage. It cannot serve as an extraction
      // destination for this member or any file below such a storage.
      const materializable =
        parent?.materializable !== false &&
        (parentPath === "" || placed.path.startsWith(`${parentPath}/`));
      incompletePlacement ||= !materializable;
      if (entry.type === "storage")
        placedByIndex.set(entry.index, { path: placed.path, materializable });
      const member = entry.type === "storage" || entry.type === "stream";
      entries.set(key, {
        ...placed,
        ...(member && parentPath !== ""
          ? { observedParentPath: parentPath }
          : {}),
        ...(!materializable && placed.kind === "file"
          ? ({
              kind: "metadata",
              byteOffset: null,
              limitations: [
                ...placed.limitations,
                "The path allowance cannot retain this stream inside its storage hierarchy, so the listed path is unavailable for extraction.",
              ],
            } as const)
          : {}),
      });
      byPath.set(placed.path, key);
    };
    // Ancestors first: a child's path is built from its parent's placed path,
    // so the parent must be placed before it whatever order the directory
    // lists them in. The root storage is not a member of itself, so it seeds
    // the map at the empty prefix its children extend.
    placedByIndex.set(0, { path: "", materializable: true });
    const waiting = new Map<number, CompoundFileDirectoryEntry[]>();
    const settle = (entry: CompoundFileDirectoryEntry): void => {
      const queued = waiting.get(entry.index);
      if (queued === undefined) return;
      waiting.delete(entry.index);
      for (const child of queued) {
        place(child);
        settle(child);
      }
    };
    for (const entry of image.entries) {
      const parent = entry.parentIndex;
      if (parent !== null && !placedByIndex.has(parent)) {
        const siblings = waiting.get(parent) ?? [];
        siblings.push(entry);
        waiting.set(parent, siblings);
        continue;
      }
      place(entry);
      settle(entry);
    }
    // A parent the directory stream does not hold cannot place its children;
    // those keep the parser's path, which is what the directory declared, so
    // nothing is silently dropped.
    for (const orphans of waiting.values())
      for (const entry of orphans) place(entry);
    // The final check can still reject a carrier rewritten during the read, so
    // nothing is published until it succeeds: `formatMetadata()` must not
    // describe an image whose traversal failed.
    await this.#source.read(signal);
    this.#assertOpen(signal);
    this.#metadata = image.metadata;
    this.#limitations = incompletePlacement
      ? [
          ...image.limitations,
          "The path allowance could not retain some extraction destinations inside their storage hierarchy.",
        ]
      : image.limitations;
    for (const [key, entry] of entries) this.#entries.set(key, entry);
    for (const [path, key] of byPath) this.#byPath.set(path, key);
  }

  async #decode(signal?: AbortSignal): Promise<CompoundFileImage> {
    const { handle, initial } = await this.#source.read(signal);
    const decoder = createCompoundFileDecoder(initial.size);
    if (!decoder.ok) throw await this.#stableFailure(decoder.error, signal);
    if (initial.size > 0)
      for await (const chunk of readFileHandleChunks(handle, {
        end: initial.size - 1,
        signal,
        cancellationFailure: (reason) =>
          new ArtifactReaderFailure(
            "cancelled",
            "compound file read cancelled",
            { cause: reason },
          ),
      }) as AsyncIterable<Buffer>) {
        this.#assertOpen(signal);
        const written = decoder.value.write(chunk);
        if (!written.ok) throw await this.#stableFailure(written.error, signal);
      }
    const image = decoder.value.finish();
    if (!image.ok) throw await this.#stableFailure(image.error, signal);
    return image.value;
  }

  async #stableFailure(
    failure: RegionDecodeFailure,
    signal: AbortSignal | undefined,
  ): Promise<ArtifactReaderFailure> {
    await this.#source.read(signal);
    return this.#failure(failure);
  }

  #failure(failure: RegionDecodeFailure): ArtifactReaderFailure {
    if (failure.kind === "malformed")
      return malformedArtifact(
        "compound-file",
        `compound file is malformed: ${failure.message}`,
      );
    // A fixed refusal names its ceiling, so the caller can tell what the
    // release will never exceed rather than reading the prose alone.
    const ceiling =
      failure.boundary === undefined
        ? undefined
        : COMPOUND_FILE_FIXED_LIMITS.get(failure.boundary);
    if (ceiling !== undefined)
      return artifactFixedLimitFailure(
        {
          name: ceiling.name,
          kind: "parser",
          limit: ceiling.limit,
          unit: ceiling.unit,
        },
        `compound file exceeds a fixed limit: ${failure.message}`,
        failure.boundary,
      );
    return new ArtifactReaderFailure(
      "limit",
      `compound file exceeds a fixed limit: ${failure.message}`,
      failure.boundary === undefined ? {} : { boundary: failure.boundary },
    );
  }
}

const sameRange = (entry: ArtifactEntry, stored: ArtifactEntry): boolean =>
  entry.kind === stored.kind &&
  entry.byteOffset === stored.byteOffset &&
  entry.declaredSize === stored.declaredSize;

/**
 * The root storage has no name of its own and two entries can share a logical
 * path, so an entry whose path is already claimed by another is listed under
 * its source ordinal instead. The same applies to a name that is not a single
 * safe path component: the raw declared name stays in `sourcePath`.
 *
 * Claiming compares the normalized identity, not the raw spelling: the
 * inventory registry normalizes NFC, so two canonically equivalent names would
 * otherwise both pass here and abort the whole inventory downstream.
 *
 * Charge only the selected path, including a fallback when necessary. Each
 * fallback has space reserved before the reader starts placing entries.
 */
const claimPath = (
  entry: ArtifactEntry,
  parentPath: string,
  claimed: Set<string>,
  paths: Budget,
  index: number,
): ArtifactEntry => {
  const identity = entry.path === "" ? null : normalizedIdentity(entry.path);
  const canClaim = identity !== null && !claimed.has(identity);
  if (
    canClaim &&
    paths.tryCharge(Math.max(identity.length, entry.path.length))
  ) {
    claimed.add(identity);
    return entry;
  }
  // A member may literally use an ordinal path. Compare fallbacks against
  // the same index so they never take another entry's established identity.
  const ordinal = `entry-${String(index)}`;
  const fallback = (base: string): { path: string; identity: string } => {
    let path = base;
    let identity = normalizedIdentity(path) ?? path;
    for (let suffix = 2; claimed.has(identity); suffix += 1) {
      path = `${base}-${String(suffix)}`;
      identity = normalizedIdentity(path) ?? path;
    }
    return { path, identity };
  };
  let placed = fallback(
    parentPath === "" ? ordinal : `${parentPath}/${ordinal}`,
  );
  let fellOutsideParent = false;
  if (!paths.tryCharge(Math.max(placed.path.length, placed.identity.length))) {
    placed = fallback(ordinal);
    paths.charge(placed.path.length, () =>
      invariantViolation("Compound file ordinal path exceeded its reservation"),
    );
    fellOutsideParent = true;
  }
  claimed.add(placed.identity);
  return {
    ...entry,
    path: placed.path,
    ...(entry.path === "" || entry.sourcePath !== undefined
      ? {}
      : { sourcePath: entry.path }),
    limitations: [
      ...entry.limitations,
      canClaim || fellOutsideParent
        ? "Directory paths exceeded the cumulative allowance this read retains, so this entry is listed under its source ordinal; its declared name and facts are kept."
        : "This entry's declared name is not a single safe path component, or another entry already claimed its logical path, so it is listed under its source ordinal; the declared name, when it has one, is retained in sourcePath.",
    ],
  };
};

/** The path identity the inventory registry compares after NFC normalization. */
const normalizedIdentity = (path: string): string | null => {
  try {
    return normalizeArtifactPath(path);
  } catch {
    return null;
  }
};

const chainProblemLimitation = (problem: CompoundFileChainProblem): string => {
  if (problem === "marker-start")
    return "This stream declares bytes but its start marker names no sector, so it has no byte range in this step.";
  if (problem === "budget")
    return "This stream's FAT chain was left unresolved when the allocation-chain walk and inspection budget was exhausted, so it has no byte range in this step.";
  return "This stream's FAT chain ends before the declared size — it is cyclic or leaves the file — so it has no byte range in this step.";
};

/**
 * The directory facts the parse knows about an entry, published per entry so
 * `inspect_artifact` can answer where a member is listed and how its bytes are
 * allocated even when no byte range resolved. A storage's own start and size
 * fields are stale in the format and are published as `null` rather than as
 * facts the directory does not declare.
 */
const entryMetadata = (
  entry: CompoundFileDirectoryEntry,
): CompoundFileEntryMetadata => {
  const stream = entry.type === "stream";
  return {
    kind: "compound-file-entry",
    index: entry.index,
    role: entry.type === "unknown" ? "undefined-type" : entry.type,
    declared_type: entry.declaredType,
    parent_index: entry.parentIndex,
    left_sibling: entry.leftSibling,
    right_sibling: entry.rightSibling,
    child: entry.child,
    starting_sector: stream ? entry.startingSector : null,
    // A size past what a JavaScript number carries exactly is stored clamped,
    // and publishing the clamp would present an invented observed size next to
    // the limitation that says the size is unknown.
    stream_size:
      stream && entry.streamSizeRepresentable ? entry.streamSize : null,
    storage: stream ? entry.storage : null,
    contiguous: stream ? entry.contiguous : null,
  };
};

const toArtifactEntry = (
  entry: CompoundFileDirectoryEntry,
): ArtifactEntry | null => {
  const path = entry.path;
  // The root storage is the container itself, not a member of it. An entry
  // outside the root's tree keeps its declared facts under its source ordinal;
  // the parse counts orphans.
  if (entry.type === "root-storage" && entry.index === 0) return null;
  // A record whose declared type the format does not define keeps its readable
  // name and declaration facts as metadata: the parser's count says these are
  // listed without a role, and dropping them here would leave that count
  // describing entries the inventory never shows. A zero byte is an
  // unallocated slot, not a declaration, and is still dropped.
  if (
    entry.type === "root-storage" ||
    (entry.type === "unknown" && entry.declaredType !== 0)
  )
    return {
      path: path ?? "",
      kind: "metadata",
      declaredSize:
        entry.type === "unknown" && entry.streamSizeRepresentable
          ? entry.streamSize
          : null,
      compressedSize: null,
      executable: false,
      encrypted: false,
      byteOffset: null,
      declaredIntegrity: null,
      unpacked: false,
      limitations: [
        entry.type === "root-storage"
          ? "This record declares a root storage outside directory entry 0. Its name and links are listed without granting it ownership of a subtree."
          : "This entry declares an object type the format does not define, so it is listed as a declaration without a role.",
      ],
      ...(entry.name === null || entry.name === path
        ? {}
        : { sourcePath: entry.name }),
      formatMetadata: entryMetadata(entry),
      adapterKey: `compound-file/${String(entry.index)}`,
    };
  if (entry.type !== "storage" && entry.type !== "stream") return null;
  const unnamed = path === null && entry.name === null;
  const limitation = (): string[] => {
    if (unnamed)
      return [
        "This entry declares no valid name, so it is listed under its source ordinal; its type, size and allocation facts are kept.",
      ];
    if (path === null)
      return [
        entry.parentIndex === null
          ? "This entry is not reachable from the root storage, so it has no declared logical path; its declared name and facts are kept."
          : "This entry is reachable, but its declared path could not be retained because a name on the path is unusable or the cumulative path allowance was reached.",
      ];
    return [];
  };
  // An entry whose declared name cannot name a path still reports that name:
  // the reader is the last place that knows it, and without it an unsafe or
  // unreachable member becomes indistinguishable from an unnamed slot.
  const sourceName =
    entry.name !== null && (path === null || entry.name !== path)
      ? { sourcePath: entry.name }
      : {};
  if (entry.type === "storage") {
    return {
      path: path ?? "",
      kind: "directory",
      declaredSize: 0,
      compressedSize: null,
      executable: false,
      encrypted: false,
      byteOffset: null,
      declaredIntegrity: null,
      unpacked: false,
      limitations: limitation(),
      ...sourceName,
      formatMetadata: entryMetadata(entry),
      adapterKey: `compound-file/${String(entry.index)}`,
    };
  }
  const limitations: string[] = limitation();
  // A mini stream needs the root storage's chain and the mini FAT walked; a
  // split chain has no single range. Both are listed as declarations rather
  // than as content this step claims to reproduce.
  if (entry.storage === "mini")
    limitations.push(
      "This stream is smaller than the mini stream cutoff and lives in the root storage's mini stream; its byte range is not resolved in this step.",
    );
  if (entry.storage === null && entry.streamSize > 0)
    limitations.push(
      "This stream declares bytes but its allocation is unresolved, so it has no byte range in this step.",
    );
  if (entry.storage !== "mini" && entry.chainProblem !== null)
    limitations.push(chainProblemLimitation(entry.chainProblem));
  if (entry.structuralOverlap)
    limitations.push(
      "This stream's chain reaches sectors the FAT, the DIFAT or the directory already owns, so its byte range is not resolved in this step.",
    );
  if (entry.sharedOverlap)
    limitations.push(
      "This stream's chain reaches sectors an earlier entry's chain already owns, so its byte range is not resolved rather than reading the same bytes under two identities.",
    );
  // A zero-byte stream is a file: it has content (none) and opens as empty,
  // rather than being reported as metadata that carries no bytes.
  // A version-4 size beyond 2^53-1 cannot be carried, so its declaration is
  // unknown: the clamped `streamSize` is not published as an observed size and
  // the entry has no byte range to open.
  const sizeKnown = entry.streamSizeRepresentable;
  const resolvable =
    sizeKnown &&
    entry.storage === "fat" &&
    entry.byteOffset !== null &&
    !entry.structuralOverlap &&
    !entry.sharedOverlap;
  const emptyStream =
    sizeKnown && entry.storage === "empty" && entry.streamSize === 0;
  if (!sizeKnown)
    limitations.push(
      "This stream declares more bytes than a JavaScript number carries exactly, so its declared size is unknown here rather than the clamped value that bounds the parse.",
    );
  return {
    path: path ?? "",
    kind: resolvable || emptyStream ? "file" : "metadata",
    declaredSize: sizeKnown ? entry.streamSize : null,
    compressedSize: null,
    executable: false,
    encrypted: false,
    byteOffset: resolvable && entry.streamSize > 0 ? entry.byteOffset : null,
    declaredIntegrity: null,
    unpacked: false,
    limitations,
    ...sourceName,
    formatMetadata: entryMetadata(entry),
    adapterKey: `compound-file/${String(entry.index)}`,
  };
};
