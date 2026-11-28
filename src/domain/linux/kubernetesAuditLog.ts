import { ok, err, type Result } from "../result.js";
import { z } from "zod";
import { Budget } from "../budget.js";
import {
  DEFAULT_KUBERNETES_AUDIT_LOG_READER_LIMITS,
  MAX_KUBERNETES_AUDIT_LINE_BYTES,
} from "../artifactReaderLimits.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { isRecord } from "../../kernel/isRecord.js";
import { ellipsisExcerpt } from "../excerpt.js";
import { decodeUtf8PreservingBomOrNull } from "../strictUtf8.js";
import {
  KUBERNETES_AUDIT_STAGES,
  kubernetesAuditStageOf,
  type KubernetesAuditStage,
} from "./kubernetesAuditEventProbe.js";
import { parseKubernetesAuditLine } from "./kubernetesAuditRecord.js";
import type {
  RegionDecodeFailure,
  RegionDecoder,
} from "../firmware/regionDecoder.js";

/** Whole-log work admission; retained memory is bounded independently. */
export const KUBERNETES_AUDIT_LOG_MAX_FILE_BYTES = 1024 * 1024 * 1024 * 4;
/** Inline events are a sample; totals below cover the whole file. */
export const KUBERNETES_AUDIT_INLINE_EVENT_LIMIT = 32;
/** Inline diagnostics are a sample too. */
export const KUBERNETES_AUDIT_INLINE_DIAGNOSTIC_LIMIT = 16;
/** The first-seen sample bounds keys and optional field text retained. */
export const KUBERNETES_AUDIT_INLINE_VERB_LIMIT = 32;
const MAX_SAMPLE_KEY_UNITS = 128;
const MAX_SAMPLE_FIELD_BYTES = 128 * 1024;

/** Retain one record per distinct stage before retaining repeats. */
export const KUBERNETES_AUDIT_INLINE_STAGE_LIMIT =
  KUBERNETES_AUDIT_STAGES.length;

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
  readonly response_code: number | null;
}

export interface KubernetesAuditEventSummary {
  /** `auditID`, the identifier the stages of one request share. */
  readonly audit_id: string;
  readonly request_uri: string | null;
  readonly verb: string | null;
  readonly username: string | null;
  readonly user_groups: readonly string[] | null;
  readonly source_ips: readonly string[] | null;
  readonly user_agent: string | null;
  /** `objectRef.resource`, `namespace` and `name`; each null when unstated. */
  readonly resource: string | null;
  readonly namespace: string | null;
  readonly object_name: string | null;
  /** First understood `responseStatus.code`; individual values are on stages. */
  readonly response_code: number | null;
  /** Source line of `response_code`, even if that stage record was omitted. */
  readonly response_code_line: number | null;
  readonly stages: readonly KubernetesAuditStageRecord[];
  readonly omitted_stage_lines: number;
  /** One or more optional request fields did not fit the sample budget. */
  readonly request_fields_omitted: boolean;
  /** The tokenizer stopped inside this request, so later fields were not read. */
  readonly depth_limited: boolean;
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
  readonly oversized_line_count: number;
  readonly line_bytes_limit: number;
  readonly malformed_line_count: number;
  readonly malformed_lines: readonly KubernetesAuditDiagnostic[];
  readonly omitted_malformed_lines: number;
  /** Sampled requests with no recorded ResponseComplete or Panic. */
  readonly sample_missing_terminal_stage_count: number;
  /** Extra lines that repeat a stage for a sampled auditID. */
  readonly sample_duplicate_stage_line_count: number;
  readonly stage_counts: readonly KubernetesAuditEventCount[];
  readonly verb_counts: readonly KubernetesAuditEventCount[];
  /** Lines whose understood verbs were outside the retained labels. */
  readonly unlisted_verb_line_count: number;
  readonly events: readonly KubernetesAuditEventSummary[];
  /** Valid event lines whose auditID was outside the request sample. */
  readonly unsampled_event_line_count: number;
  /** Lines whose ignored body exceeded the tokenizer's container depth. */
  readonly depth_limited_line_count: number;
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

const stringArrayOrNull = (value: unknown): readonly string[] | null =>
  Array.isArray(value) &&
  value.every((entry): entry is string => typeof entry === "string")
    ? value
    : null;

/** Detach text from the potentially much larger JSON source string. */
const detachedText = (value: string): string =>
  Buffer.from(value, "utf16le").toString("utf16le");

/** Charge UTF-16 storage plus an allowance for a string and its reference. */
const retainedTextBytes = (value: string): number => 2 * value.length + 32;

const responseCode = (event: Record<string, unknown>): number | null => {
  const status = isRecord(event.responseStatus)
    ? event.responseStatus.code
    : null;
  return typeof status === "number" && Number.isSafeInteger(status)
    ? status
    : null;
};

const isJsonWhitespace = (code: number): boolean =>
  code === 0x20 || code === 0x09 || code === 0x0d;

/**
 * One leading U+FEFF and the JSON whitespace around a record are padding.
 * Anything else stays in the text so `JSON.parse` rejects it, which is the
 * same rule the recognizer uses before `{`.
 */
const auditRecordText = (line: string): string | undefined => {
  let start = line.charCodeAt(0) === 0xfeff ? 1 : 0;
  let end = line.length;
  while (start < end && isJsonWhitespace(line.charCodeAt(start))) start += 1;
  while (end > start && isJsonWhitespace(line.charCodeAt(end - 1))) end -= 1;
  if (start === end) return undefined;
  return line.slice(start, end);
};

/** How much of an offending line a diagnostic shows. */
const DIAGNOSTIC_EXCERPT_UNITS = 160;
/** An excerpt a diagnostic can show without dumping a whole line. */
const excerptOf = (line: string): string =>
  ellipsisExcerpt(line, DIAGNOSTIC_EXCERPT_UNITS);

const auditTimestamp = z.iso.datetime({ offset: true });
const parseTimestamp = (value: unknown): number | null => {
  const result = auditTimestamp.safeParse(value);
  if (!result.success) return null;
  const parsed = Date.parse(result.data);
  return Number.isFinite(parsed) ? parsed : null;
};

/** `audit.k8s.io/v1`-style versions; a missing one is read as supported. */
const isUnsupportedVersion = (value: unknown): boolean =>
  value !== undefined &&
  (typeof value !== "string" || !AUDIT_VERSIONS.includes(value));

/** Interpreted request fields from the first line of a sampled auditID. */
const summarizeEvent = (
  event: Record<string, unknown> | undefined,
  auditId: string,
  stageRecord: KubernetesAuditStageRecord,
  unsupported: boolean,
  fieldBudget: Budget,
): KubernetesAuditEventSummary => {
  const user = isRecord(event?.user) ? event.user : undefined;
  const object = isRecord(event?.objectRef) ? event.objectRef : undefined;
  let requestFieldsOmitted = false;
  const reserve = (bytes: number): boolean => {
    if (fieldBudget.tryCharge(bytes)) return true;
    requestFieldsOmitted = true;
    return false;
  };
  const text = (value: unknown): string | null => {
    const valid = stringOrNull(value);
    return valid !== null && reserve(retainedTextBytes(valid))
      ? detachedText(valid)
      : null;
  };
  const list = (value: unknown): readonly string[] | null => {
    const valid = stringArrayOrNull(value);
    if (valid === null) return null;
    const bytes = valid.reduce(
      (total, item) => total + retainedTextBytes(item),
      0,
    );
    return reserve(bytes) ? valid.map(detachedText) : null;
  };
  return {
    audit_id: auditId,
    request_uri: text(event?.requestURI),
    verb: text(event?.verb),
    username: text(user?.username),
    user_groups: list(user?.groups),
    source_ips: list(event?.sourceIPs),
    user_agent: text(event?.userAgent),
    resource: text(object?.resource),
    namespace: text(object?.namespace),
    object_name: text(object?.name),
    response_code: stageRecord.response_code,
    response_code_line:
      stageRecord.response_code === null ? null : stageRecord.line,
    stages: [stageRecord],
    omitted_stage_lines: 0,
    request_fields_omitted: requestFieldsOmitted,
    depth_limited: false,
    unsupported_version: unsupported,
  };
};

type SampledRequest = {
  summary: KubernetesAuditEventSummary;
  readonly seenStages: Set<KubernetesAuditStage>;
  /** Request strings come from the first stage with a modelled API version. */
  fieldsRecorded: boolean;
};

/** Keep the first observation of each stage. Repeats use the remaining slots. */
const retainStage = (
  stages: readonly KubernetesAuditStageRecord[],
  record: KubernetesAuditStageRecord,
  alreadySeen: boolean,
): readonly KubernetesAuditStageRecord[] => {
  if (stages.length < KUBERNETES_AUDIT_INLINE_STAGE_LIMIT)
    return [...stages, record];
  if (alreadySeen) return stages;
  const lastRepeat = stages.findLastIndex(
    (stage, index) =>
      stages.findIndex((earlier) => earlier.stage === stage.stage) < index,
  );
  return [...stages.filter((_stage, index) => index !== lastRepeat), record];
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
  #lineNumber = 0;
  #recordCount = 0;
  #trailingBytes = 0;
  #malformedCount = 0;
  #oversizedLineCount = 0;
  #largestSkippedLineBytes = 0;
  readonly #malformed: KubernetesAuditDiagnostic[] = [];
  /** Insertion order is the first-seen display order. */
  readonly #sample = new Map<string, SampledRequest>();
  readonly #sampleFields = new Budget(MAX_SAMPLE_FIELD_BYTES);
  #unsampledEventLines = 0;
  #unlistedVerbLines = 0;
  readonly #stageCounts = new Map<KubernetesAuditStage, number>();
  readonly #verbCounts = new Map<string, number>();
  #sampleDuplicateStageLines = 0;
  #unsupportedVersionLineCount = 0;
  #depthLimitedLines = 0;

  constructor(private readonly maxLineBytes: number) {}

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
    if (this.#pendingBytes > 0) {
      this.#trailingBytes = this.#pendingBytes;
      this.#finishLine();
    }
    if (this.#lineNumber === 0)
      return err(failure("file holds no Kubernetes audit records"));
    if (this.#recordCount === 0 && this.#oversizedLineCount === 0)
      return err(
        failure(
          `${String(this.#lineNumber)} line(s) were read but none is a Kubernetes audit event`,
        ),
      );
    const sampleWithoutTerminalStage = [...this.#sample.values()].filter(
      ({ seenStages }) =>
        !seenStages.has("ResponseComplete") && !seenStages.has("Panic"),
    ).length;
    const events = [...this.#sample.values()].map(({ summary }) => summary);
    return ok({
      metadata: {
        kind: "kubernetes-audit-log",
        line_count: this.#lineNumber,
        event_count: this.#recordCount,
        oversized_line_count: this.#oversizedLineCount,
        line_bytes_limit: this.maxLineBytes,
        malformed_line_count: this.#malformedCount,
        malformed_lines: this.#malformed,
        omitted_malformed_lines: Math.max(
          0,
          this.#malformedCount - this.#malformed.length,
        ),
        sample_missing_terminal_stage_count: sampleWithoutTerminalStage,
        sample_duplicate_stage_line_count: this.#sampleDuplicateStageLines,
        stage_counts: [...this.#stageCounts]
          .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
          .map(([label, count]) => ({ label, count })),
        verb_counts: [...this.#verbCounts]
          .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
          .map(([label, count]) => ({ label, count })),
        unlisted_verb_line_count: this.#unlistedVerbLines,
        events,
        unsampled_event_line_count: this.#unsampledEventLines,
        depth_limited_line_count: this.#depthLimitedLines,
        trailing_bytes: this.#trailingBytes,
      },
      limitations: this.#limitations(events, sampleWithoutTerminalStage),
    });
  }

  #limitations(
    events: readonly KubernetesAuditEventSummary[],
    sampleWithoutTerminalStage: number,
  ): string[] {
    const limitations: string[] = [];
    if (this.#oversizedLineCount > 0) {
      const required = this.#largestSkippedLineBytes;
      const recovery =
        required <= MAX_KUBERNETES_AUDIT_LINE_BYTES
          ? `Set artifact_limits.kubernetes_audit_log.line_bytes to at least ${String(required)} to include those lines, or inspect a capture whose records fit.`
          : `At least one record exceeds the ${String(MAX_KUBERNETES_AUDIT_LINE_BYTES)}-byte maximum. Inspect a capture whose records fit.`;
      limitations.push(
        `${String(this.#oversizedLineCount)} line(s) exceeded the ${String(this.maxLineBytes)}-byte line limit and were not parsed or included in event, stage or verb totals. ${recovery}`,
      );
    }
    if (this.#malformedCount > 0)
      limitations.push(
        `${String(this.#malformedCount)} line(s) are not JSON objects, not audit events, or name an unknown stage; their text is not represented`,
      );
    if (this.#unsupportedVersionLineCount > 0)
      limitations.push(
        `${String(this.#unsupportedVersionLineCount)} line(s) declare an audit API version this reader does not model; their auditID and stage are retained, but their request, user, object and response fields are not interpreted`,
      );
    if (sampleWithoutTerminalStage > 0)
      limitations.push(
        `${String(sampleWithoutTerminalStage)} sampled auditID(s) have no recorded ResponseComplete or Panic stage; capture and policy coverage remain unknown`,
      );
    if (this.#sampleDuplicateStageLines > 0)
      limitations.push(
        `${String(this.#sampleDuplicateStageLines)} line(s) repeat a stage for a sampled auditID; a bounded stage window retains the first occurrence of each observed stage`,
      );
    if (this.#unsampledEventLines > 0)
      limitations.push(
        `events are listed for ${String(events.length)} auditID(s); ${String(this.#unsampledEventLines)} further event line(s) contribute to aggregate counts`,
      );
    if (this.#unlistedVerbLines > 0)
      limitations.push(
        `${String(this.#unlistedVerbLines)} line(s) carry verbs outside the bounded verb histogram`,
      );
    if (this.#depthLimitedLines > 0)
      limitations.push(
        `${String(this.#depthLimitedLines)} line(s) contain an ignored value nested deeper than the tokenizer scans; fields after that value on the line were not read`,
      );
    if (events.some((event) => event.request_fields_omitted))
      limitations.push(
        "some sampled request fields exceed the retained field-text budget and are left unknown; their stage and numeric response facts remain available",
      );
    limitations.push(
      "events are inventoried by the declared request, user, object reference and response code: request and response object bodies, annotations, impersonation metadata and audit policy are not interpreted, and the log is not treated as complete or authentic",
    );
    return limitations;
  }

  #acceptSegment(segment: Buffer): void {
    this.#pendingBytes += segment.length;
    if (this.#pendingBytes > this.maxLineBytes) {
      this.#pending.length = 0;
      return;
    }
    if (segment.length > 0) this.#pending.push(Buffer.from(segment));
  }

  #finishLine(): void {
    this.#lineNumber += 1;
    const lineLength = this.#pendingBytes;
    this.#pendingBytes = 0;
    if (lineLength > this.maxLineBytes) {
      this.#oversizedLineCount += 1;
      this.#largestSkippedLineBytes = Math.max(
        this.#largestSkippedLineBytes,
        lineLength,
      );
      return;
    }
    const lineBytes = Buffer.concat(this.#pending, lineLength);
    this.#pending.length = 0;
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
    const line = auditRecordText(decoded);
    if (line === undefined) return;
    const parsed = parseKubernetesAuditLine(line);
    if (parsed.kind === "nesting") {
      this.#depthLimitedLines += 1;
      return;
    }
    if (parsed.kind !== "event") {
      this.#diagnose("line is not JSON", line);
      return;
    }
    if (parsed.depthLimited) this.#depthLimitedLines += 1;
    const { value } = parsed;
    if (typeof value.auditID !== "string") {
      this.#diagnose(
        "JSON value is not a Kubernetes audit event (no auditID)",
        line,
      );
      return;
    }
    const stage = kubernetesAuditStageOf(value.stage);
    if (stage === null) {
      this.#diagnose("audit event names an unknown stage", line);
      return;
    }
    this.#record(
      value,
      value.auditID,
      stage,
      parsed.depthLimited,
      parsed.budgetOmitted,
      parsed.verbOmitted,
    );
  }

  #countVerb(verb: string): void {
    const previous = this.#verbCounts.get(verb);
    if (previous !== undefined) {
      this.#verbCounts.set(verb, previous + 1);
      return;
    }
    if (
      this.#verbCounts.size >= KUBERNETES_AUDIT_INLINE_VERB_LIMIT ||
      verb.length > MAX_SAMPLE_KEY_UNITS
    ) {
      this.#unlistedVerbLines += 1;
      return;
    }
    this.#verbCounts.set(detachedText(verb), 1);
  }

  #record(
    event: Record<string, unknown>,
    auditId: string,
    stage: KubernetesAuditStage,
    depthLimited: boolean,
    budgetOmitted: boolean,
    verbOmitted: boolean,
  ): void {
    this.#recordCount += 1;
    const versionUnexamined =
      depthLimited && !Object.hasOwn(event, "apiVersion");
    // A cutoff before apiVersion is not a declared unmodelled version.
    const unsupported = isUnsupportedVersion(event.apiVersion);
    const suppressFields = unsupported || versionUnexamined;
    // An unread version leaves every field, including a dropped verb, out of
    // the histogram. A dropped verb on an interpreted line is unlisted.
    if (unsupported) this.#unsupportedVersionLineCount += 1;
    else if (!suppressFields && verbOmitted) this.#unlistedVerbLines += 1;
    else if (!suppressFields && typeof event.verb === "string")
      this.#countVerb(event.verb);
    this.#stageCounts.set(stage, (this.#stageCounts.get(stage) ?? 0) + 1);
    const sampled = this.#sample.get(auditId);
    if (
      sampled === undefined &&
      (this.#sample.size >= KUBERNETES_AUDIT_INLINE_EVENT_LIMIT ||
        auditId.length > MAX_SAMPLE_KEY_UNITS)
    ) {
      this.#unsampledEventLines += 1;
      return;
    }
    const stageRecord: KubernetesAuditStageRecord = {
      stage,
      line: this.#lineNumber,
      request_received_timestamp: suppressFields
        ? null
        : parseTimestamp(event.requestReceivedTimestamp),
      response_code: suppressFields ? null : responseCode(event),
    };
    if (sampled === undefined) {
      const key = detachedText(auditId);
      this.#sample.set(key, {
        summary: summarizeEvent(
          suppressFields ? undefined : event,
          key,
          stageRecord,
          unsupported,
          this.#sampleFields,
        ),
        seenStages: new Set([stage]),
        fieldsRecorded: !suppressFields,
      });
      const created = this.#sample.get(key);
      if (created !== undefined && (depthLimited || budgetOmitted))
        created.summary = {
          ...created.summary,
          depth_limited: created.summary.depth_limited || depthLimited,
          request_fields_omitted:
            created.summary.request_fields_omitted || budgetOmitted,
        };
      return;
    }

    const alreadySeen = sampled.seenStages.has(stage);
    if (alreadySeen) this.#sampleDuplicateStageLines += 1;
    else sampled.seenStages.add(stage);
    if (!suppressFields && !sampled.fieldsRecorded) {
      const filled = summarizeEvent(
        suppressFields ? undefined : event,
        sampled.summary.audit_id,
        stageRecord,
        false,
        this.#sampleFields,
      );
      sampled.fieldsRecorded = true;
      sampled.summary = {
        ...sampled.summary,
        request_uri: filled.request_uri,
        verb: filled.verb,
        username: filled.username,
        user_groups: filled.user_groups,
        source_ips: filled.source_ips,
        user_agent: filled.user_agent,
        resource: filled.resource,
        namespace: filled.namespace,
        object_name: filled.object_name,
        request_fields_omitted: filled.request_fields_omitted,
      };
    }
    const previous = sampled.summary;
    const stages = retainStage(previous.stages, stageRecord, alreadySeen);
    sampled.summary = {
      ...previous,
      response_code: previous.response_code ?? stageRecord.response_code,
      response_code_line:
        previous.response_code_line ??
        (stageRecord.response_code === null ? null : stageRecord.line),
      stages,
      omitted_stage_lines:
        previous.omitted_stage_lines +
        previous.stages.length +
        1 -
        stages.length,
      unsupported_version: previous.unsupported_version || unsupported,
      depth_limited: previous.depth_limited || depthLimited,
      request_fields_omitted: previous.request_fields_omitted || budgetOmitted,
    };
  }

  #diagnose(reason: string, text: string): void {
    this.#malformedCount += 1;
    if (this.#malformed.length < KUBERNETES_AUDIT_INLINE_DIAGNOSTIC_LIMIT)
      this.#malformed.push({
        line: this.#lineNumber,
        reason,
        excerpt: detachedText(excerptOf(text)),
      });
  }
}

export const createKubernetesAuditLogDecoder = (
  fileBytes: number,
  maxLineBytes = DEFAULT_KUBERNETES_AUDIT_LOG_READER_LIMITS.line_bytes,
): Result<RegionDecoder<KubernetesAuditInventory>, RegionDecodeFailure> =>
  Number.isSafeInteger(fileBytes) &&
  fileBytes >= 0 &&
  fileBytes <= KUBERNETES_AUDIT_LOG_MAX_FILE_BYTES
    ? ok(new KubernetesAuditScanner(maxLineBytes))
    : err({
        kind: "limit",
        message: `file is ${String(fileBytes)} bytes, exceeding the fixed ${String(KUBERNETES_AUDIT_LOG_MAX_FILE_BYTES)}-byte (4 GiB) ceiling`,
        boundary: "file-size",
      });
