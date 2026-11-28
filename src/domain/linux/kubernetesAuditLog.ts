import { ok, err, type Result } from "../result.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { isRecord } from "../../kernel/isRecord.js";
import { ellipsisExcerpt } from "../excerpt.js";
import { decodeUtf8PreservingBomOrNull } from "../strictUtf8.js";
import type {
  RegionDecodeFailure,
  RegionDecoder,
} from "../firmware/regionDecoder.js";

/**
 * `kube-apiserver` writes one JSON object per line. A line is bounded so a
 * crafted or corrupt acquisition cannot buffer without limit; a line past this
 * is reported as malformed rather than retained.
 */
const MAX_AUDIT_LINE_BYTES = 4 * 1024 * 1024;
/** The whole log is bounded so a runaway acquisition cannot exhaust memory. */
export const KUBERNETES_AUDIT_LOG_MAX_FILE_BYTES = 1024 * 1024 * 1024 * 4;
/** Inline events are a sample; totals below cover the whole file. */
export const KUBERNETES_AUDIT_INLINE_EVENT_LIMIT = 32;
/** Inline diagnostics are a sample too. */
export const KUBERNETES_AUDIT_INLINE_DIAGNOSTIC_LIMIT = 16;
/** Stage records retained per event; a request has at most four. */
const KUBERNETES_AUDIT_EVENT_STAGE_LIMIT = 4;

/** The stages one request's `auditID` can pass through, in Kubernetes' order. */
export const KUBERNETES_AUDIT_STAGES = [
  "RequestReceived",
  "ResponseStarted",
  "ResponseComplete",
  "Panic",
] as const;
export type KubernetesAuditStage = (typeof KUBERNETES_AUDIT_STAGES)[number];

/** Audit event versions whose fields this reader interprets. */
const AUDIT_VERSIONS: readonly string[] = [
  "audit.k8s.io/v1",
  "audit.k8s.io/v1beta1",
];

export interface KubernetesAuditDiagnostic {
  /** 1-based source line, as counted by the reader. */
  readonly line: number;
  readonly reason: string;
  /** Bounded excerpt of the offending text, never the whole line. */
  readonly excerpt: string;
}

export interface KubernetesAuditStageRecord {
  readonly stage: KubernetesAuditStage;
  readonly line: number;
  /**
   * `requestReceivedTimestamp` as epoch milliseconds, or null when the event
   * omitted it or it did not parse. A stage line carries the same instant.
   */
  readonly request_received_timestamp: number | null;
}

export interface KubernetesAuditEventSummary {
  /** `auditID`, the identifier the stages of one request share. */
  readonly audit_id: string;
  readonly request_uri: string | null;
  readonly verb: string | null;
  readonly username: string | null;
  readonly user_groups: readonly string[];
  readonly source_ips: readonly string[];
  readonly user_agent: string | null;
  /** `objectRef.resource`, `namespace` and `name`; each null when unstated. */
  readonly resource: string | null;
  readonly namespace: string | null;
  readonly object_name: string | null;
  /** `responseStatus.code`, or null when the event carried no response. */
  readonly response_code: number | null;
  readonly stages: readonly KubernetesAuditStageRecord[];
  /**
   * True when the event names an API version this reader does not model. Its
   * `auditID` and stage are still joined, but no field of it is interpreted.
   */
  readonly unsupported_version: boolean;
}

export interface KubernetesAuditEventCount {
  readonly label: string;
  readonly count: number;
}

interface KubernetesAuditLines {
  readonly kind: "kubernetes-audit-log";
  readonly line_count: number;
  readonly event_count: number;
  readonly malformed_line_count: number;
  readonly malformed_lines: readonly KubernetesAuditDiagnostic[];
  readonly omitted_malformed_lines: number;
  /** auditIDs whose retained stages do not cover every declared stage. */
  readonly incomplete_stage_event_count: number;
  /** Extra lines that repeat a stage already seen for the same auditID. */
  readonly duplicate_stage_line_count: number;
  readonly stage_counts: readonly KubernetesAuditEventCount[];
  readonly verb_counts: readonly KubernetesAuditEventCount[];
  readonly events: readonly KubernetesAuditEventSummary[];
  /** auditIDs the sample does not list; their lines are still counted. */
  readonly omitted_events: number;
  /** Bytes after the last newline, which no line boundary ended. */
  readonly trailing_bytes: number;
}

export interface KubernetesAuditInventory {
  readonly metadata: KubernetesAuditLines;
  readonly limitations: readonly string[];
}

const failure = (message: string): RegionDecodeFailure => ({
  kind: "malformed",
  message,
});

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const stageOf = (value: unknown): KubernetesAuditStage | null =>
  typeof value === "string" &&
  (KUBERNETES_AUDIT_STAGES as readonly string[]).includes(value)
    ? (value as KubernetesAuditStage)
    : null;

/** How much of an offending line a diagnostic shows. */
const DIAGNOSTIC_EXCERPT_UNITS = 160;
/** An excerpt a diagnostic can show without dumping a whole line. */
const excerptOf = (line: string): string =>
  ellipsisExcerpt(line, DIAGNOSTIC_EXCERPT_UNITS);

const parseTimestamp = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** `audit.k8s.io/v1`-style versions; a missing one is read as supported. */
const isUnsupportedVersion = (value: unknown): boolean =>
  typeof value === "string" && !AUDIT_VERSIONS.includes(value);

/**
 * The summary one audit line declares. An unmodelled API version keeps only
 * its auditID and stage: a field this reader does not know the meaning of is
 * not read out under a name the event may not have used it for.
 */
const summarizeEvent = (
  event: Record<string, unknown>,
  stageRecord: KubernetesAuditStageRecord,
  line: {
    readonly auditId: string;
    readonly unsupported: boolean;
    readonly verb: string | null;
  },
): KubernetesAuditEventSummary => {
  const { unsupported } = line;
  const user = isRecord(event.user) ? event.user : undefined;
  const objectRef = isRecord(event.objectRef) ? event.objectRef : undefined;
  const responseStatus = isRecord(event.responseStatus)
    ? event.responseStatus
    : undefined;
  const field = (read: () => string | null): string | null =>
    unsupported ? null : read();
  const objectField = (read: () => unknown): string | null =>
    unsupported || objectRef === undefined ? null : stringOrNull(read());
  return {
    audit_id: line.auditId,
    request_uri: field(() => stringOrNull(event.requestURI)),
    verb: unsupported ? null : line.verb,
    username: field(() =>
      user === undefined ? null : stringOrNull(user.username),
    ),
    user_groups:
      unsupported || user === undefined ? [] : stringArray(user.groups),
    source_ips: unsupported ? [] : stringArray(event.sourceIPs),
    user_agent: field(() => stringOrNull(event.userAgent)),
    resource: objectField(() => objectRef!.resource),
    namespace: objectField(() => objectRef!.namespace),
    object_name: objectField(() => objectRef!.name),
    response_code:
      unsupported || responseStatus === undefined
        ? null
        : numberOrNull(responseStatus.code),
    stages: [stageRecord],
    unsupported_version: unsupported,
  };
};

/**
 * Feed the admitted file one line at a time and join audit events on their
 * `auditID`. Each line remains an event in its own right, so a request whose
 * stages were written out of order is reported rather than reordered.
 */
class KubernetesAuditScanner {
  #pending: Buffer[] = [];
  // not-an-allowance: bytes of the line being assembled, bounded by a fixed line ceiling rather than charged from a resource budget.
  #pendingBytes = 0;
  #pendingOverflow = false;
  #lineNumber = 0;
  #recordCount = 0;
  #trailingBytes = 0;
  #malformedCount = 0;
  readonly #malformed: KubernetesAuditDiagnostic[] = [];
  readonly #eventsByAuditId = new Map<string, KubernetesAuditEventSummary[]>();
  /** First-seen order of the retained events, bounded to the sample. */
  readonly #sampleOrder: string[] = [];
  readonly #stageCounts = new Map<KubernetesAuditStage, number>();
  readonly #verbCounts = new Map<string, number>();
  #duplicateStageLineCount = 0;
  #unsupportedVersionLineCount = 0;

  write(chunk: Uint8Array): Result<void, RegionDecodeFailure> {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      this.#acceptSegment(bytes.subarray(start, index));
      this.#finishLine();
      start = index + 1;
    }
    if (start < bytes.length) this.#acceptSegment(bytes.subarray(start));
    return ok(undefined);
  }

  finish(): Result<KubernetesAuditInventory, RegionDecodeFailure> {
    if (this.#pendingOverflow || this.#pendingBytes > 0) {
      this.#trailingBytes = this.#pendingBytes;
      this.#finishLine();
    }
    if (this.#lineNumber === 0)
      return err(failure("file holds no Kubernetes audit records"));
    if (this.#recordCount === 0)
      return err(
        failure(
          `${String(this.#lineNumber)} line(s) were read but none is a Kubernetes audit event`,
        ),
      );
    const eventCount = this.#recordCount;
    const incomplete = this.#incompleteStageAuditIds();
    const limitations = this.#limitations(eventCount, incomplete);
    return ok({
      metadata: {
        kind: "kubernetes-audit-log",
        line_count: this.#lineNumber,
        event_count: eventCount,
        malformed_line_count: this.#malformedCount,
        malformed_lines: this.#malformed,
        omitted_malformed_lines: Math.max(
          0,
          this.#malformedCount - this.#malformed.length,
        ),
        incomplete_stage_event_count: incomplete,
        duplicate_stage_line_count: this.#duplicateStageLineCount,
        stage_counts: [...this.#stageCounts]
          .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
          .map(([label, count]) => ({ label, count })),
        verb_counts: [...this.#verbCounts]
          .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
          .map(([label, count]) => ({ label, count })),
        events: this.#sampleOrder.map(
          (auditId) => this.#eventsByAuditId.get(auditId)![0]!,
        ),
        omitted_events: Math.max(0, eventCount - this.#sampleOrder.length),
        trailing_bytes: this.#trailingBytes,
      },
      limitations,
    });
  }

  /** What the scan could not establish, in a fixed order. */
  /**
   * auditIDs whose retained stages do not cover every stage. A request that
   * finished has RequestReceived and ResponseComplete; one that is still in
   * flight, or whose log was truncated, is missing at least one of them.
   */
  #incompleteStageAuditIds(): number {
    let incomplete = 0;
    for (const stages of this.#eventsByAuditId.values()) {
      const seen = new Set(stages[0]!.stages.map((record) => record.stage));
      if (seen.size < KUBERNETES_AUDIT_STAGES.length) incomplete += 1;
    }
    return incomplete;
  }

  #limitations(eventCount: number, incompleteStageEvents: number): string[] {
    const limitations: string[] = [];
    if (this.#malformedCount > 0)
      limitations.push(
        `${String(this.#malformedCount)} line(s) are not JSON objects, not audit events, or name an unknown stage; their text is not represented`,
      );
    if (this.#unsupportedVersionLineCount > 0)
      limitations.push(
        `${String(this.#unsupportedVersionLineCount)} line(s) declare an audit API version this reader does not model; their auditID and stage are retained, but their request, user, object and response fields are not interpreted`,
      );
    if (incompleteStageEvents > 0)
      limitations.push(
        `${String(incompleteStageEvents)} auditID(s) do not carry every declared stage; the file is reported as written rather than treated as a complete request record`,
      );
    if (this.#duplicateStageLineCount > 0)
      limitations.push(
        `${String(this.#duplicateStageLineCount)} line(s) repeat a stage for an auditID already seen; each line is counted once and the repeat is retained as its own stage record`,
      );
    const beyondSample = Math.max(0, eventCount - this.#sampleOrder.length);
    if (beyondSample > 0)
      limitations.push(
        `events are listed for ${String(KUBERNETES_AUDIT_INLINE_EVENT_LIMIT)} auditID(s); ${String(beyondSample)} further auditID(s) are counted in the totals but their joined stages and fields are not listed`,
      );
    limitations.push(
      "events are inventoried by the declared request, user, object reference and response code: request and response object bodies, annotations, impersonation metadata and audit policy are not interpreted, and the log is not treated as complete or authentic",
    );
    return limitations;
  }

  #acceptSegment(segment: Buffer): void {
    if (this.#pendingOverflow) return;
    if (this.#pendingBytes + segment.length > MAX_AUDIT_LINE_BYTES) {
      this.#pendingOverflow = true;
      this.#pending = [];
      this.#pendingBytes = MAX_AUDIT_LINE_BYTES + 1;
      return;
    }
    if (segment.length > 0) this.#pending.push(Buffer.from(segment));
    this.#pendingBytes += segment.length;
  }

  #finishLine(): void {
    this.#lineNumber += 1;
    if (this.#pendingOverflow) {
      this.#pendingOverflow = false;
      this.#pendingBytes = 0;
      this.#pending = [];
      this.#diagnose(
        `line exceeds the fixed ${String(MAX_AUDIT_LINE_BYTES)}-byte record ceiling`,
        "",
      );
      return;
    }
    const lineBytes = Buffer.concat(this.#pending);
    this.#pendingBytes = 0;
    this.#pending = [];
    this.#acceptLine(lineBytes);
  }

  #acceptLine(lineBytes: Buffer): void {
    const decoded = decodeUtf8PreservingBomOrNull(lineBytes);
    if (decoded === null) {
      this.#diagnose(
        "line is not valid UTF-8, which JSON-lines requires",
        lineBytes.subarray(0, 160).toString("utf8"),
      );
      return;
    }
    const line = decoded.trim();
    if (line === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#diagnose("line is not JSON", excerptOf(line));
      return;
    }
    if (!isRecord(value) || typeof value.auditID !== "string") {
      this.#diagnose(
        "JSON value is not a Kubernetes audit event (no auditID)",
        excerptOf(line),
      );
      return;
    }
    const stage = stageOf(value.stage);
    if (stage === null) {
      this.#diagnose("audit event names an unknown stage", excerptOf(line));
      return;
    }
    this.#record(value, stage);
  }

  #record(event: Record<string, unknown>, stage: KubernetesAuditStage): void {
    this.#recordCount += 1;
    const unsupported = isUnsupportedVersion(event.apiVersion);
    if (unsupported) this.#unsupportedVersionLineCount += 1;
    const auditId = event.auditID as string;
    const verb = stringOrNull(event.verb);
    this.#stageCounts.set(stage, (this.#stageCounts.get(stage) ?? 0) + 1);
    if (verb !== null)
      this.#verbCounts.set(verb, (this.#verbCounts.get(verb) ?? 0) + 1);
    const stageRecord: KubernetesAuditStageRecord = {
      stage,
      line: this.#lineNumber,
      request_received_timestamp: parseTimestamp(
        event.requestReceivedTimestamp,
      ),
    };
    const existing = this.#eventsByAuditId.get(auditId);
    if (existing === undefined) {
      this.#retain(event, stageRecord, { auditId, unsupported, verb });
      return;
    }
    const first = existing[0]!;
    // A request passes each stage at most once; a second line at the same stage
    // repeats one, which is reported rather than folded into the first.
    if (first.stages.some((seen) => seen.stage === stage))
      this.#duplicateStageLineCount += 1;
    const stages =
      first.stages.length < KUBERNETES_AUDIT_EVENT_STAGE_LIMIT
        ? [...first.stages, stageRecord]
        : first.stages;
    existing[0] = {
      ...first,
      stages,
      unsupported_version: first.unsupported_version || unsupported,
    };
  }

  /** Retain an auditID's first line as its summary, and its place in the sample. */
  #retain(
    event: Record<string, unknown>,
    stageRecord: KubernetesAuditStageRecord,
    line: {
      readonly auditId: string;
      readonly unsupported: boolean;
      readonly verb: string | null;
    },
  ): void {
    this.#eventsByAuditId.set(line.auditId, [
      summarizeEvent(event, stageRecord, line),
    ]);
    if (this.#sampleOrder.length < KUBERNETES_AUDIT_INLINE_EVENT_LIMIT)
      this.#sampleOrder.push(line.auditId);
  }

  #diagnose(reason: string, text: string): void {
    this.#malformedCount += 1;
    if (this.#malformed.length < KUBERNETES_AUDIT_INLINE_DIAGNOSTIC_LIMIT)
      this.#malformed.push({
        line: this.#lineNumber,
        reason,
        excerpt: excerptOf(text),
      });
  }
}

/** A JSON object carrying an `"auditID"` key. */
const HAS_AUDIT_ID = /"auditID"\s*:/u;
/** A stage value the audit log API defines. */
const HAS_AUDIT_STAGE =
  /"stage"\s*:\s*"(?:RequestReceived|ResponseStarted|ResponseComplete|Panic)"\s*[,}]/u;

/**
 * Recognize a Kubernetes audit log by its first line: a JSON object with a top
 * level `auditID` and a defined `stage`. The reader still validates every line;
 * recognition only decides that the file is worth the audit-log reader's
 * explicit refusals rather than ordinary inventory.
 */
export const hasKubernetesAuditEvent = (prefix: Uint8Array): boolean => {
  if (prefix.length === 0) return false;
  const newline = prefix.indexOf(0x0a);
  const firstLine = Buffer.from(
    newline < 0 ? prefix : prefix.subarray(0, newline),
  ).toString("utf8");
  return (
    firstLine.startsWith("{") &&
    HAS_AUDIT_ID.test(firstLine) &&
    HAS_AUDIT_STAGE.test(firstLine)
  );
};

export const createKubernetesAuditLogDecoder = (
  fileBytes: number,
): Result<RegionDecoder<KubernetesAuditInventory>, RegionDecodeFailure> =>
  Number.isSafeInteger(fileBytes) &&
  fileBytes >= 0 &&
  fileBytes <= KUBERNETES_AUDIT_LOG_MAX_FILE_BYTES
    ? ok(new KubernetesAuditScanner())
    : err({
        kind: "limit",
        message: `file is ${String(fileBytes)} bytes, exceeding the fixed ${String(KUBERNETES_AUDIT_LOG_MAX_FILE_BYTES)}-byte (4 GiB) ceiling`,
        boundary: "file-size",
      });
