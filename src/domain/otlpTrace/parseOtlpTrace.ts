import { digestCanonicalValue } from "../canonicalDigest.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import type {
  OtlpDiagnostic,
  OtlpSpan,
  OtlpTrace,
  OtlpTraceArtifact,
} from "./otlpTrace.js";
import {
  OTLP_TRACE_MAX_ATTRIBUTES_PER_SPAN,
  OTLP_TRACE_MAX_DIAGNOSTICS,
  OTLP_TRACE_MAX_SPANS,
} from "./otlpTrace.js";

/**
 * Attribute keys whose values are credentials by kind rather than by name.
 * A name alone never proves secrecy elsewhere in REA, so this list is limited
 * to keys that carry a bearer token or shared secret under the OTLP semantic
 * conventions.
 */
const REDACTED_ATTRIBUTE_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "http.request.header.authorization",
  "http.request.header.cookie",
  "http.request.header.proxy-authorization",
  "http.response.header.set-cookie",
  "rpc.metadata.authorization",
]);

const SENSITIVE_KEY_PATTERN =
  /(^|\.)(api[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?token|client[-_]?secret|password|passwd|secret|bearer)$/iu;

const redactKey = (key: string): boolean =>
  REDACTED_ATTRIBUTE_KEYS.has(key.toLowerCase()) ||
  SENSITIVE_KEY_PATTERN.test(key);

type Json = unknown;

const isRecord = (value: Json): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** OTLP JSON encodes 64-bit integers as decimal strings. */
const readUInt64 = (value: Json): string | null => {
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value))
    return BigInt(value).toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value).toString();
  return null;
};

/** OTLP intValue is a signed 64-bit integer. */
const readInt64 = (value: Json): string | null => {
  if (typeof value === "string" && /^-?(0|[1-9][0-9]*)$/u.test(value))
    return BigInt(value).toString();
  if (typeof value === "number" && Number.isSafeInteger(value))
    return BigInt(value).toString();
  return null;
};

/** The JSON mapping permits id fields as either hex strings or base64 bytes. */
const readHexId = (value: Json, bytes: number): string | null => {
  if (typeof value !== "string" || value.length === 0) return null;
  if (new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`, "u").test(value))
    return value.toLowerCase();
  if (
    new RegExp(
      `^[A-Za-z0-9+/]{${Math.ceil((bytes * 4) / 3)}}={0,2}$`,
      "u",
    ).test(value)
  ) {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === bytes ? decoded.toString("hex") : null;
  }
  return null;
};

const kindName = (value: Json): OtlpSpan["kind"] => {
  switch (value) {
    case 1:
      return "internal";
    case 2:
      return "server";
    case 3:
      return "client";
    case 4:
      return "producer";
    case 5:
      return "consumer";
    case 0:
      return "unspecified";
    default:
      return typeof value === "number" ? "unknown-kind" : "unspecified";
  }
};

const statusCode = (value: Json): OtlpSpan["status_code"] => {
  // OTLP's JSON mapping leaves an omitted code at its zero value, which the
  // proto declares as UNSET.
  if (value === undefined) return "unset";
  switch (value) {
    case 1:
      return "ok";
    case 2:
      return "error";
    case 0:
      return "unset";
    default:
      return "unknown-code";
  }
};

type Attribute = OtlpSpan["attributes"][number];

const readAttribute = (
  key: string,
  rawValue: Json,
): { attribute: Attribute; redacted: boolean } => {
  const redacted = redactKey(key);
  const empty = {
    key,
    redacted,
    string_value: null,
    bool_value: null,
    int_value: null,
    double_value: null,
    bytes_length: null,
    element_count: null,
  } as const;
  if (redacted)
    return {
      attribute: { ...empty, value_kind: "string", string_value: null },
      redacted: true,
    };
  if (!isRecord(rawValue))
    return { attribute: { ...empty, value_kind: "empty" }, redacted: false };
  const kind = Object.keys(rawValue)[0];
  const value = kind === undefined ? undefined : rawValue[kind];
  switch (kind) {
    case "stringValue":
      return {
        attribute: {
          ...empty,
          value_kind: "string",
          string_value: typeof value === "string" ? value : null,
        },
        redacted: false,
      };
    case "boolValue":
      return {
        attribute: {
          ...empty,
          value_kind: "bool",
          bool_value: typeof value === "boolean" ? value : null,
        },
        redacted: false,
      };
    case "intValue": {
      return {
        attribute: {
          ...empty,
          value_kind: "int",
          int_value: readInt64(value),
        },
        redacted: false,
      };
    }
    case "doubleValue":
      return {
        attribute: {
          ...empty,
          value_kind: "double",
          double_value:
            typeof value === "number" && Number.isFinite(value) ? value : null,
        },
        redacted: false,
      };
    case "bytesValue":
      return {
        attribute: {
          ...empty,
          value_kind: "bytes",
          bytes_length:
            typeof value === "string"
              ? Buffer.from(value, "base64").length
              : null,
        },
        redacted: false,
      };
    case "arrayValue":
      return {
        attribute: {
          ...empty,
          value_kind: "array",
          element_count:
            isRecord(value) && Array.isArray(value.values)
              ? value.values.length
              : null,
        },
        redacted: false,
      };
    case "kvlistValue":
      return {
        attribute: {
          ...empty,
          value_kind: "key-value-list",
          element_count:
            isRecord(value) && Array.isArray(value.values)
              ? value.values.length
              : null,
        },
        redacted: false,
      };
    default:
      return { attribute: { ...empty, value_kind: "empty" }, redacted: false };
  }
};

type Problem = {
  code: OtlpDiagnostic["code"];
  message: string;
  pointer?: string;
};

type ParsedSpan =
  | { ok: false; problems: readonly Problem[] }
  | {
      ok: true;
      span: OtlpSpan;
      problems: readonly Problem[];
      attributesDropped: number;
    };

const parseSpan = (
  record: Record<string, Json>,
  pointer: string,
  serviceName: string | null,
  resourceFacts: readonly Attribute[],
  scope: { name: string | null; version: string | null },
  budget: { spans: number },
): ParsedSpan => {
  const traceId = readHexId(record.traceId, 16);
  const spanId = readHexId(record.spanId, 8);
  if (traceId === null || spanId === null)
    return {
      ok: false,
      problems: [
        {
          code: "invalid-record",
          message: `Span at ${pointer} is missing a valid 16-byte traceId or 8-byte spanId.`,
        },
      ],
    };
  budget.spans += 1;
  const problems: Problem[] = [];
  if (budget.spans > OTLP_TRACE_MAX_SPANS)
    problems.push({
      code: "span-limit-exceeded",
      pointer,
      message: `Span at ${pointer} exceeds the ${OTLP_TRACE_MAX_SPANS}-span allowance and was not inventoried.`,
    });
  const parentSpanId = readHexId(record.parentSpanId, 8);
  // An empty parentSpanId is the OTLP zero value, which declares no parent.
  const parentRecorded =
    record.parentSpanId !== undefined &&
    record.parentSpanId !== null &&
    record.parentSpanId !== "";
  if (parentRecorded && parentSpanId === null)
    problems.push({
      code: "invalid-record",
      pointer,
      message: `Span ${spanId} at ${pointer} records a parentSpanId that is not an 8-byte span id; the damaged link is reported as unreadable rather than as an absent parent.`,
    });
  const startTime = readUInt64(record.startTimeUnixNano);
  const endTime = readUInt64(record.endTimeUnixNano);
  let duration: string | null = null;
  if (startTime !== null && endTime !== null) {
    const delta = BigInt(endTime) - BigInt(startTime);
    if (delta < 0n)
      problems.push({
        code: "invalid-time-interval",
        pointer,
        message: `Span ${spanId} at ${pointer} ends before it starts; the recorded timestamps are preserved but no duration is derived.`,
      });
    else duration = delta.toString();
  }
  const rawAttributes = Array.isArray(record.attributes)
    ? record.attributes
    : [];
  const retained = rawAttributes
    .filter((entry) => isRecord(entry) && typeof entry.key === "string")
    .slice(0, OTLP_TRACE_MAX_ATTRIBUTES_PER_SPAN);
  const attributes = spanAttributes(retained);
  const redacted = attributes.filter((attribute) => attribute.redacted).length;
  const attributesDropped =
    rawAttributes.filter(
      (entry) => isRecord(entry) && typeof entry.key === "string",
    ).length - retained.length;
  if (attributesDropped > 0)
    problems.push({
      code: "attribute-limit-exceeded",
      pointer,
      message: `Span ${spanId} at ${pointer} dropped ${attributesDropped} attributes beyond the ${OTLP_TRACE_MAX_ATTRIBUTES_PER_SPAN}-attribute per-span allowance.`,
    });
  const status = isRecord(record.status) ? record.status : undefined;
  const span: OtlpSpan = {
    span_id: spanId,
    trace_id: traceId,
    parent_span_id: parentSpanId,
    name: typeof record.name === "string" ? record.name : "",
    kind: kindName(record.kind),
    start_time_unix_nano: startTime,
    end_time_unix_nano: endTime,
    duration_nano: duration,
    status_code: statusCode(status?.code),
    status_message:
      typeof status?.message === "string" && status.message.length > 0
        ? status.message
        : null,
    service_name: serviceName,
    resource_attributes: [...resourceFacts],
    scope_name: scope.name,
    scope_version: scope.version,
    attributes,
    event_count: Array.isArray(record.events) ? record.events.length : 0,
    link_count: Array.isArray(record.links) ? record.links.length : 0,
    source_pointer: pointer,
  };
  return { ok: true, span, problems, attributesDropped };
};

const spanAttributes = (rawAttributes: readonly Json[]): Attribute[] => {
  const parsed: Attribute[] = [];
  for (const entry of rawAttributes) {
    if (!isRecord(entry) || typeof entry.key !== "string") continue;
    parsed.push(readAttribute(entry.key, entry.value).attribute);
  }
  return parsed;
};

const isServiceName = (entry: Json): boolean =>
  isRecord(entry) && entry.key === "service.name";

/** Bounded to the per-span allowance so one resource cannot expand every span. */
const resourceAttributes = (
  resource: Json,
): { attributes: Attribute[]; dropped: number } => {
  if (!isRecord(resource) || !Array.isArray(resource.attributes))
    return { attributes: [], dropped: 0 };
  const candidates = resource.attributes.filter(
    (entry) => !isServiceName(entry),
  );
  const retained = candidates.slice(0, OTLP_TRACE_MAX_ATTRIBUTES_PER_SPAN);
  return {
    attributes: spanAttributes(retained),
    dropped: candidates.length - retained.length,
  };
};

const resourceServiceName = (resource: Json): string | null => {
  if (!isRecord(resource) || !Array.isArray(resource.attributes)) return null;
  for (const entry of resource.attributes)
    if (isServiceName(entry) && isRecord(entry) && isRecord(entry.value)) {
      const value = entry.value.stringValue;
      return typeof value === "string" ? value : null;
    }
  return null;
};

type Walked = {
  spans: OtlpSpan[];
  problems: Problem[];
  redactedAttributes: number;
  droppedRecords: number;
  spansTruncated: boolean;
  attributesTruncated: boolean;
  resourceAttributesTruncated: boolean;
};

const walkResourceSpans = (
  envelope: unknown,
  budget: { spans: number },
): { walked: Walked; unsupported: boolean } => {
  const walked: Walked = {
    spans: [],
    problems: [],
    redactedAttributes: 0,
    droppedRecords: 0,
    spansTruncated: false,
    attributesTruncated: false,
    resourceAttributesTruncated: false,
  };
  if (!isRecord(envelope) || !Array.isArray(envelope.resourceSpans))
    return { walked, unsupported: true };
  for (const [
    resourceIndex,
    resourceSpans,
  ] of envelope.resourceSpans.entries()) {
    if (!isRecord(resourceSpans)) {
      walked.droppedRecords += 1;
      walked.problems.push({
        code: "invalid-record",
        pointer: `/resourceSpans/${resourceIndex}`,
        message: `Resource group at /resourceSpans/${resourceIndex} is not an object and was not inventoried.`,
      });
      continue;
    }
    const serviceName = resourceServiceName(resourceSpans.resource);
    const { attributes: resourceFacts, dropped: resourceDropped } =
      resourceAttributes(resourceSpans.resource);
    if (resourceDropped > 0) walked.resourceAttributesTruncated = true;
    // OTLP omits an empty repeated field, so a missing scopeSpans is an empty
    // collection rather than damage; only a present non-array value is.
    if (resourceSpans.scopeSpans === undefined) continue;
    if (!Array.isArray(resourceSpans.scopeSpans)) {
      walked.droppedRecords += 1;
      walked.problems.push({
        code: "invalid-record",
        pointer: `/resourceSpans/${resourceIndex}/scopeSpans`,
        message: `Resource group at /resourceSpans/${resourceIndex} carries a scopeSpans value that is not an array; its spans were not inventoried.`,
      });
      continue;
    }
    for (const [scopeIndex, scopeSpans] of resourceSpans.scopeSpans.entries()) {
      if (!isRecord(scopeSpans)) {
        walked.droppedRecords += 1;
        walked.problems.push({
          code: "invalid-record",
          pointer: `/resourceSpans/${resourceIndex}/scopeSpans/${scopeIndex}`,
          message: `Scope group at /resourceSpans/${resourceIndex}/scopeSpans/${scopeIndex} is not an object and was not inventoried.`,
        });
        continue;
      }
      const scopeRecord = isRecord(scopeSpans.scope)
        ? scopeSpans.scope
        : undefined;
      const scope = {
        name: typeof scopeRecord?.name === "string" ? scopeRecord.name : null,
        version:
          typeof scopeRecord?.version === "string" ? scopeRecord.version : null,
      };
      if (scopeSpans.spans === undefined) continue;
      if (!Array.isArray(scopeSpans.spans)) {
        walked.droppedRecords += 1;
        walked.problems.push({
          code: "invalid-record",
          pointer: `/resourceSpans/${resourceIndex}/scopeSpans/${scopeIndex}/spans`,
          message: `Scope at /resourceSpans/${resourceIndex}/scopeSpans/${scopeIndex} carries a spans value that is not an array; its spans were not inventoried.`,
        });
        continue;
      }
      for (const [spanIndex, record] of scopeSpans.spans.entries()) {
        const pointer = `/resourceSpans/${resourceIndex}/scopeSpans/${scopeIndex}/spans/${spanIndex}`;
        if (!isRecord(record)) {
          walked.droppedRecords += 1;
          walked.problems.push({
            code: "invalid-record",
            message: `Span entry at ${pointer} is not an object and was not inventoried.`,
          });
          continue;
        }
        const parsed = parseSpan(
          record,
          pointer,
          serviceName,
          resourceFacts,
          scope,
          budget,
        );
        if (!parsed.ok) {
          walked.droppedRecords += 1;
          walked.problems.push(...parsed.problems);
          continue;
        }
        if (budget.spans > OTLP_TRACE_MAX_SPANS) {
          walked.spansTruncated = true;
          walked.problems.push(...parsed.problems);
          continue;
        }
        walked.spans.push(parsed.span);
        walked.redactedAttributes += [
          ...parsed.span.attributes,
          ...parsed.span.resource_attributes,
        ].filter((attribute) => attribute.redacted).length;
        if (parsed.attributesDropped > 0) walked.attributesTruncated = true;
        walked.problems.push(...parsed.problems);
      }
    }
  }
  return { walked, unsupported: false };
};

const diagnostic = (
  code: OtlpDiagnostic["code"],
  pointer: string,
  message: string,
): OtlpDiagnostic => ({
  diagnostic_id: `otlp_diagnostic_${digestCanonicalValue([code, pointer, message])}`,
  source_pointer: pointer,
  code,
  message,
});

const LIMITATIONS = [
  "Recording completeness is unknown: a caller-supplied export may omit spans, and an absent span never proves a step did not occur.",
  "Timestamps are reported exactly as recorded. Clock domains, skew and monotonic guarantees are not established and no correction is applied.",
  "Only the OTLP JSON encoding is decoded. Protobuf exports and live collector or observability-backend queries are not supported.",
  "Derived durations describe recorded start and end timestamps only; they are not measurements of the underlying operation.",
] as const;

export const parseOtlpTrace = (
  document: unknown,
  artifact: OtlpTraceArtifact,
): { ok: true; value: OtlpTrace } | { ok: false; problem: string } => {
  const budget = { spans: 0 };
  const { walked, unsupported } = walkResourceSpans(document, budget);
  if (unsupported)
    return {
      ok: false,
      problem:
        "The document is not an OTLP JSON trace export with a resourceSpans array.",
    };
  const byId = new Map<string, OtlpSpan>();
  const diagnostics: OtlpDiagnostic[] = walked.problems.map((problem) =>
    diagnostic(problem.code, problem.pointer ?? "", problem.message),
  );
  // A parent link is only meaningful inside its own trace: the same span id may
  // legitimately appear under different trace ids, and a parent recorded only
  // in another trace is not this span's parent.
  const spanKey = (traceId: string, spanId: string): string =>
    `${traceId}:${spanId}`;
  for (const span of walked.spans) {
    const key = spanKey(span.trace_id, span.span_id);
    if (byId.has(key)) {
      diagnostics.push(
        diagnostic(
          "duplicate-span-id",
          span.source_pointer,
          `Span id ${span.span_id} appears more than once within trace ${span.trace_id}; the later record at ${span.source_pointer} is retained and the earlier one remains recorded here only.`,
        ),
      );
    }
    byId.set(key, span);
  }
  // Keys carry the trace id so two traces cannot suppress each other's
  // missing-parent report; only the span id is part of the public result.
  const orphanParents = new Map<string, string>();
  for (const span of walked.spans) {
    const parent = span.parent_span_id;
    if (parent === null || parent === "0000000000000000") continue;
    if (parent === span.span_id)
      diagnostics.push(
        diagnostic(
          "self-parent",
          span.source_pointer,
          `Span ${span.span_id} names itself as its parent.`,
        ),
      );
    else if (!byId.has(spanKey(span.trace_id, parent)))
      orphanParents.set(spanKey(span.trace_id, parent), parent);
  }
  for (const [key, parent] of orphanParents) {
    diagnostics.push(
      diagnostic(
        "missing-parent",
        "",
        `Parent span id ${parent} is referenced but not present in trace ${key.slice(0, key.indexOf(":"))}; its children remain parented to an unrecorded span.`,
      ),
    );
  }
  // A span whose recorded parent link is unreadable is not a root: it may be a
  // damaged child, so only a span that declares no parent counts as a root.
  const roots = walked.spans
    .filter(
      (span) =>
        span.parent_span_id === null ||
        span.parent_span_id === "0000000000000000",
    )
    .map((span) => span.span_id);
  // A captured subtree can be reachable through its recorded root and still not
  // prove the export is complete: an unrecorded ancestor may still exist.
  // Walk every edge once instead of replaying each span's whole ancestor chain,
  // which is quadratic on a deep trace. State 1 means "on the current path".
  const cycles = new Set<string>();
  const state = new Map<string, 1 | 2>();
  for (const start of walked.spans) {
    if (state.has(start.source_pointer)) continue;
    const path: string[] = [];
    const pathSpans: OtlpSpan[] = [];
    let cursor: OtlpSpan | undefined = start;
    while (cursor !== undefined) {
      // Identity is the record, not the trace/span id: duplicate records that
      // disagree about their parents must each be walked, or a cycle spanning
      // two of them would be missed once the first record finished.
      const cursorKey = cursor.source_pointer;
      const seenState = state.get(cursorKey);
      if (seenState === 1) {
        // The cycle is the portion of the path from the revisited record
        // onward; report every member, not only the one that closed it.
        for (const member of pathSpans.slice(path.indexOf(cursorKey)))
          cycles.add(member.span_id);
        break;
      }
      if (seenState === 2) break;
      state.set(cursorKey, 1);
      path.push(cursorKey);
      pathSpans.push(cursor);
      const parent = cursor.parent_span_id;
      if (parent === null || parent === "0000000000000000") break;
      if (parent === cursor.span_id) {
        cycles.add(cursor.span_id);
        break;
      }
      cursor = byId.get(spanKey(cursor.trace_id, parent));
    }
    for (const visited of path) state.set(visited, 2);
  }
  for (const id of cycles)
    diagnostics.push(
      diagnostic(
        "cycle",
        "",
        `Span ${id} participates in a parent cycle; the recorded links are preserved and no ordering is derived from them.`,
      ),
    );
  const diagnosticsTruncated = diagnostics.length > OTLP_TRACE_MAX_DIAGNOSTICS;
  diagnostics.sort((left, right) =>
    compareUnicodeCodePoints(left.diagnostic_id, right.diagnostic_id),
  );
  const boundedDiagnostics = diagnosticsTruncated
    ? diagnostics.slice(0, OTLP_TRACE_MAX_DIAGNOSTICS)
    : diagnostics;
  return {
    ok: true,
    value: {
      trace_import_id: digestCanonicalValue([
        artifact.sha256,
        walked.spans.map((span) => span.span_id),
      ]).replace(/^/, "otlp_trace_"),
      format: "otlp-json",
      artifact,
      spans: walked.spans,
      orphan_span_ids: [...orphanParents.values()].sort(),
      roots,
      // A file of malformed groups reaches here with no spans at all, so the
      // span allowance cannot bound it; cap the diagnostics and say so.
      diagnostics: boundedDiagnostics,
      summary: {
        spans: walked.spans.length,
        roots: roots.length,
        orphans: orphanParents.size,
        error_status: walked.spans.filter(
          (span) => span.status_code === "error",
        ).length,
        with_parent: walked.spans.filter(
          (span) =>
            span.parent_span_id !== null &&
            span.parent_span_id !== "0000000000000000",
        ).length,
        distinct_traces: new Set(walked.spans.map((span) => span.trace_id))
          .size,
        distinct_services: new Set(
          walked.spans
            .map((span) => span.service_name)
            .filter((name): name is string => name !== null),
        ).size,
        redacted_attributes: walked.redactedAttributes,
        diagnostics: boundedDiagnostics.length,
      },
      source_coverage: {
        scope: "single-caller-supplied-export",
        encoding: "otlp-json",
        protobuf_encodings: "not-supported",
        recording_completeness: "unknown",
        live_collector: "not-contacted",
        clock_skew: "not-corrected",
      },
      limitations: [
        ...LIMITATIONS,
        ...(walked.spansTruncated
          ? [
              `The export declares more than ${OTLP_TRACE_MAX_SPANS} spans; the inventory stops at the allowance and no completeness claim is made.`,
            ]
          : []),
        ...(walked.attributesTruncated
          ? [
              `Some spans carry more attributes than the ${OTLP_TRACE_MAX_ATTRIBUTES_PER_SPAN}-attribute per-span allowance; the dropped count is reported per span.`,
            ]
          : []),
        ...(diagnosticsTruncated
          ? [
              `The export produced more than ${OTLP_TRACE_MAX_DIAGNOSTICS} diagnostics; only the first ${OTLP_TRACE_MAX_DIAGNOSTICS} by diagnostic id are reported and the rest are dropped.`,
            ]
          : []),
        ...(walked.resourceAttributesTruncated
          ? [
              `Some resources declare more than ${OTLP_TRACE_MAX_ATTRIBUTES_PER_SPAN} attributes beyond service.name; the excess is dropped rather than repeated on every span of that resource.`,
            ]
          : []),
      ],
    },
  };
};
