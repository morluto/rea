import type { StableRegularFileDescriptor } from "../../../filesystem/RegularFile.js";
import type { PlaywrightTracePort } from "../../../application/playwrightTrace/PlaywrightTracePort.js";
import { ArtifactResourceScope } from "../../../artifacts/ArtifactResourceScope.js";
import type { ArtifactEntry } from "../../../artifacts/ArtifactReader.js";
import { ZipArtifactReader } from "../../../artifacts/ZipArtifactReader.js";
import {
  artifactFilePrimaryFacts,
  assertArtifactReadActive,
  withArtifactRegularFile,
} from "../../../artifacts/ArtifactFileOperation.js";
import { projectStableArtifactFailure } from "../../../artifacts/StableArtifactFailure.js";
import { assertArtifactFileSelectedSource } from "../../../artifacts/ArtifactFileSource.js";
import { hashStableRootArtifactHandle } from "../../../artifacts/inventory/hashStableRootArtifact.js";
import {
  AnalysisResourceConstraintError,
  AnalysisCancelledError,
  AnalysisUnsupportedTargetError,
} from "../../../domain/analysisErrorCore.js";
import { err, ok } from "../../../domain/result.js";
import {
  PLAYWRIGHT_TRACE_LIMITS,
  PLAYWRIGHT_TRACE_OPERATION as operation,
  PLAYWRIGHT_TRACE_PROVIDER,
  type PlaywrightTrace,
  type TraceMember,
  type TraceStream,
} from "../../../domain/playwrightTrace/playwrightTrace.js";
import type { FileSnapshotPartialObservation } from "../../../domain/fileSnapshotObservation.js";
import { TraceInventory } from "./TraceInventory.js";
import { readTraceStream } from "./TraceStream.js";
import { traceFailure } from "./TraceFailure.js";

type SelectedMember = { entry: ArtifactEntry; member: TraceMember };

const readStreams = async (
  inventory: TraceInventory,
  reader: ZipArtifactReader,
  selected: SelectedMember[],
  signal?: AbortSignal,
) => {
  const budget = { decodedBytes: 0 };
  const profiles = new Map<string, TraceStream[]>();
  for (const { entry, member } of selected.filter((row) =>
    row.member.path.endsWith(".trace"),
  )) {
    const stream = await readTraceStream({
      inventory,
      reader,
      entry,
      member,
      budget,
      profileKnown: false,
      ...(signal === undefined ? {} : { signal }),
    });
    inventory.streams.push(stream);
    const previous = profiles.get(member.path) ?? [];
    previous.push(stream);
    profiles.set(member.path, previous);
  }
  for (const { entry, member } of selected.filter((row) =>
    row.member.path.endsWith(".network"),
  )) {
    const expected = member.path.slice(0, -".network".length) + ".trace";
    const paired = profiles.get(expected) ?? [];
    const known =
      paired.length === 1 &&
      paired[0]?.version === 10 &&
      paired[0].state === "supported";
    inventory.streams.push(
      await readTraceStream({
        inventory,
        reader,
        entry,
        member,
        budget,
        profileKnown: known,
        ...(signal === undefined ? {} : { signal }),
      }),
    );
  }
};

/** One invocation owns its verified identity and completed facts across finalization. */
class TraceArchiveRead {
  inventory: TraceInventory | undefined;
  identity: FileSnapshotPartialObservation | undefined;
  primary: unknown;
  complete: PlaywrightTrace | undefined;
  constructor(
    readonly resources: ArtifactResourceScope,
    readonly path: string,
    readonly signal?: AbortSignal,
  ) {}

  async run() {
    try {
      const report = await this.resources.run(() =>
        withArtifactRegularFile(
          this.path,
          this.resources,
          this.signal,
          (source) => this.readSource(source),
        ),
      );
      assertArtifactReadActive(this.signal);
      return ok(report);
    } catch (cause) {
      const error = traceFailure(
        this.primary ?? artifactFilePrimaryFacts(cause).cause,
        this.path,
      );
      const partial =
        this.complete ??
        (this.inventory?.members.length
          ? this.inventory.finish(true)
          : this.identity);
      if (partial !== undefined) error.retainPartialObservation(partial);
      return err(
        projectStableArtifactFailure(
          cause,
          error,
          this.path,
          PLAYWRIGHT_TRACE_PROVIDER.id,
          operation,
        ),
      );
    }
  }

  async readSource(source: StableRegularFileDescriptor) {
    if (source.initial.size > PLAYWRIGHT_TRACE_LIMITS.archiveBytes)
      throw new AnalysisResourceConstraintError(
        operation,
        "file-size",
        "Trace archive exceeds the 256 MiB input allowance.",
        {
          input_bytes: source.initial.size,
          max_archive_bytes: PLAYWRIGHT_TRACE_LIMITS.archiveBytes,
        },
      );
    const hash = await hashStableRootArtifactHandle(
      this.path,
      source.handle,
      source.initial,
      this.signal,
    );
    this.identity = {
      kind: "file-snapshot-hash",
      path: this.path,
      sha256: hash.sha256,
      bytes: hash.bytes,
    };
    const facts = new TraceInventory({
      path: this.path,
      sha256: hash.sha256,
      bytes: hash.bytes,
    });
    this.inventory = facts;
    const reader = new ZipArtifactReader(
      this.path,
      "zip",
      PLAYWRIGHT_TRACE_LIMITS.metadataBytes,
      source,
    );
    let outcome:
      | { kind: "completed"; value: PlaywrightTrace }
      | { kind: "failed"; cause: unknown };
    try {
      const selected: SelectedMember[] = [];
      for await (const entry of reader.entries(this.signal)) {
        const member = facts.member(entry);
        if (member.path.endsWith(".trace") || member.path.endsWith(".network"))
          selected.push({ entry, member });
      }
      if (selected.length === 0)
        throw new AnalysisUnsupportedTargetError(
          operation,
          this.path,
          "Archive contains no Playwright trace or network stream members.",
        );
      if (!selected.some((row) => row.member.path.endsWith(".network")))
        facts.diagnostic(
          null,
          null,
          "missing-network-member",
          "No network stream was supplied; this does not establish absent traffic.",
        );
      await readStreams(facts, reader, selected, this.signal);
      await assertArtifactFileSelectedSource(
        this.path,
        source,
        "Playwright trace",
      );
      this.complete = facts.finish();
      outcome = { kind: "completed", value: this.complete };
    } catch (cause) {
      this.primary = cause;
      outcome = { kind: "failed", cause };
    }
    const released = await this.resources.release({
      kind: "reader",
      resource: `Playwright ZIP reader for ${this.path}`,
      reader,
    });
    if (outcome.kind === "completed" && this.signal?.aborted) {
      const cancellation = new AnalysisCancelledError(operation, {
        cause: this.signal.reason,
        partialObservation: this.complete ?? this.identity,
      });
      this.primary = cancellation;
      outcome = { kind: "failed", cause: cancellation };
    }
    if (released.kind === "failed")
      throw this.resources.cleanupFailure(
        outcome,
        [released],
        this.complete ?? this.identity,
      );
    if (outcome.kind === "failed") throw outcome.cause;
    return outcome.value;
  }
}

/** Offline decoder; failed cleanup stays with the caller's shared scope. */
export class PlaywrightTraceDecoder implements PlaywrightTracePort {
  #running = false;
  constructor(readonly resources: ArtifactResourceScope) {}
  async inspect(path: string, signal?: AbortSignal) {
    if (signal?.aborted)
      return err(
        new AnalysisCancelledError(operation, { cause: signal.reason }),
      );
    if (this.#running)
      return err(
        new AnalysisResourceConstraintError(
          operation,
          "capacity",
          "One trace archive import is already active in this decoder.",
          { maximum_concurrent_trace_imports: 1 },
          {
            retryable: true,
            remediationAction:
              "Wait for the active import to finish, then retry. Queries against retained Evidence do not need another import.",
          },
        ),
      );
    this.#running = true;
    try {
      return await new TraceArchiveRead(this.resources, path, signal).run();
    } finally {
      this.#running = false;
    }
  }
}
