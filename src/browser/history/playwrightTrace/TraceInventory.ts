import { digestCanonicalValue } from "../../../domain/canonicalDigest.js";
import { AnalysisResourceConstraintError } from "../../../domain/analysisErrorCore.js";
import type { ArtifactEntry } from "../../../artifacts/ArtifactReader.js";
import {
  PLAYWRIGHT_TRACE_LIMITS,
  PLAYWRIGHT_TRACE_OPERATION,
  type PlaywrightTrace,
  type TraceEvent,
  type TraceMember,
  type TraceStream,
} from "../../../domain/playwrightTrace/playwrightTrace.js";

export const traceIdentity = (prefix: string, value: unknown) =>
  `${prefix}_${digestCanonicalValue(value)}`;

/** Retain only bounded producer facts; ZIP directory occurrences own member identity. */
export class TraceInventory {
  readonly members: TraceMember[] = [];
  readonly streams: TraceStream[] = [];
  readonly events: TraceEvent[] = [];
  readonly diagnostics: PlaywrightTrace["diagnostics"] = [];
  readonly #paths = new Map<string, TraceMember[]>();
  #bytes = 0;
  constructor(readonly artifact: PlaywrightTrace["artifact"]) {}
  reserve(bytes: number): void {
    this.#bytes += bytes;
    if (this.#bytes > PLAYWRIGHT_TRACE_LIMITS.factsBytes)
      throw new AnalysisResourceConstraintError(
        PLAYWRIGHT_TRACE_OPERATION,
        "memory",
        "Trace facts exceed the 32 MiB retained representation allowance.",
        { retained_fact_allowance: PLAYWRIGHT_TRACE_LIMITS.factsBytes },
        {
          remediationAction:
            "Select a smaller complete recorder chunk; fields and reply pagination do not increase parser allowances.",
        },
      );
  }
  retain(value: unknown): void {
    this.reserve(512 + Buffer.byteLength(JSON.stringify(value)) * 4);
  }
  member(entry: ArtifactEntry): TraceMember {
    this.reserve(1024 + entry.path.length * 12);
    const row: TraceMember = {
      member_id: traceIdentity("trace_member", [
        this.artifact.sha256,
        entry.adapterKey,
      ]),
      path: entry.path,
      kind: entry.kind,
      declared_bytes: entry.declaredSize,
      declared_compressed_bytes: entry.compressedSize,
      encrypted: entry.encrypted,
      decoded: false,
    };
    this.members.push(row);
    const matches = this.#paths.get(row.path) ?? [];
    if (matches.length > 0)
      this.diagnostic(
        row,
        null,
        "duplicate-member-path",
        "Archive member names are ambiguous; directory occurrences keep distinct identity.",
      );
    matches.push(row);
    this.#paths.set(row.path, matches);
    return row;
  }
  diagnostic(
    member: TraceMember | null,
    line: number | null,
    code: string,
    message: string,
  ): void {
    const row = {
      diagnostic_id: traceIdentity("trace_diagnostic", [
        this.artifact.sha256,
        member?.member_id ?? null,
        line,
        code,
        this.diagnostics.length,
      ]),
      member_id: member?.member_id ?? null,
      line,
      code,
      message,
    };
    this.retain(row);
    this.diagnostics.push(row);
  }
  /** References establish directory presence only; payload decoding and image validity stay unknown. */
  finish(incomplete = false): PlaywrightTrace {
    const events = this.events.map((event) => ({
      ...event,
      resource_references: event.resource_references.map((reference) => {
        const matches = this.#paths.get(reference.path) ?? [];
        const member = matches.length === 1 ? matches[0] : undefined;
        const state: TraceEvent["resource_references"][number]["state"] =
          matches.length === 0
            ? "missing"
            : matches.length > 1
              ? "ambiguous"
              : member?.kind !== "file" || member.encrypted
                ? "unavailable"
                : "present-unread";
        return {
          ...reference,
          state,
          member_id: member?.member_id ?? null,
          matching_members: matches.length,
        };
      }),
    }));
    const unavailable = events.reduce(
      (sum, event) =>
        sum +
        event.resource_references.filter(
          (reference) => reference.state !== "present-unread",
        ).length,
      0,
    );
    return {
      kind: "playwright-trace",
      trace_id: traceIdentity("playwright_trace", [this.artifact.sha256, 10]),
      decoder_profile: "playwright-trace-v10",
      artifact: this.artifact,
      ordering: "per-stream-source-order-only",
      members: this.members,
      streams: this.streams,
      events,
      diagnostics: this.diagnostics,
      summary: {
        events: events.length,
        action_before: events.filter((row) => row.kind === "action-before")
          .length,
        action_after: events.filter((row) => row.kind === "action-after")
          .length,
        console: events.filter((row) => row.kind === "console").length,
        network: events.filter((row) => row.kind === "network").length,
        screenshots: events.filter((row) => row.kind === "screenshot").length,
        unavailable_references: unavailable,
      },
      source_coverage: {
        recording_completeness: "unknown",
        interpretation:
          incomplete ||
          this.diagnostics.length > 0 ||
          unavailable > 0 ||
          this.streams.some((row) => row.state !== "supported")
            ? "partial"
            : "scoped",
        resource_contents: "not-decoded",
      },
      limitations: [
        ...(incomplete
          ? [
              "Import stopped before all selected members completed; only fully verified stream facts are included.",
            ]
          : []),
        "Recorded producer declarations are not authenticated. The archive was read offline without browser launch, replay or requests to recorded URLs.",
        "Order is preserved within each source member only; no total order or clock alignment is inferred across trace and network streams.",
        "Only v10 action boundaries, console text/location, network metadata and screencast references are interpreted. Other event types, DOM, context options, most action arguments, results, stacks and resource contents are not analyzed. Original archive bytes remain the complete raw source.",
        "Only decoded stream members have checked decompression/CRC. Resource reference presence does not establish readable content, valid images, observed runtime behavior or complete capture coverage.",
      ],
    };
  }
}
