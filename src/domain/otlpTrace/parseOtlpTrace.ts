import { digestCanonicalValue } from "../canonicalDigest.js";
import {
  jsonValueSchema,
  jsonValueValidationIssue,
  type JsonValue,
} from "../jsonValue.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import type {
  OtlpDiagnostic,
  OtlpResource,
  OtlpScope,
  OtlpSpan,
  OtlpTrace,
  OtlpTraceArtifact,
} from "./otlpTrace.js";
import {
  OTLP_TRACE_MAX_ATTRIBUTES_PER_SPAN,
  OTLP_TRACE_MAX_DIAGNOSTICS,
  OTLP_TRACE_MAX_SPANS,
} from "./otlpTrace.js";

type Json = unknown;

const isRecord = (value: Json): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface RawCapture {
  readonly pointer: string;
  readonly lossyNumber?: (holder: object, key: string) => boolean;
  problem?: string;
}

/** Preserve a rejected value, or refuse the inventory if Evidence cannot hold it. */
const retainedRaw = (
  value: Json,
  capture: RawCapture,
  context: "attribute" | "timestamp",
): JsonValue | null => {
  const issue = jsonValueValidationIssue(
    context === "attribute"
      ? { spans: [{ attributes: [{ int_value_raw: value }] }] }
      : { spans: [{ start_time_unix_nano_raw: value }] },
  );
  if (issue !== undefined) {
    capture.problem ??= `Rejected value at ${capture.pointer} cannot fit in Evidence: ${issue}`;
    return null;
  }
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success) {
    capture.problem ??= `Rejected value at ${capture.pointer} cannot be represented as JSON in Evidence.`;
    return null;
  }
  return parsed.data;
};

/** OTLP JSON encodes 64-bit integers as decimal strings. */
const UINT64_MAX = (1n << 64n) - 1n;
const INT64_MAX = (1n << 63n) - 1n;
const INT64_MIN = -(1n << 63n);
// The longest 64-bit value is 20 digits (19 with a sign). Bounding the digit
// count first keeps BigInt off arbitrary-length input, whose conversion cost
// grows with the digits.
const INT64_MAX_DIGITS = 20;

const readUInt64 = (value: Json): string | null => {
  if (
    typeof value === "string" &&
    value.length <= INT64_MAX_DIGITS &&
    /^(0|[1-9][0-9]*)$/u.test(value)
  ) {
    const parsed = BigInt(value);
    return parsed <= UINT64_MAX ? parsed.toString() : null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value).toString();
  return null;
};

/** OTLP intValue is a signed 64-bit integer. */
const readInt64 = (value: Json): string | null => {
  if (
    typeof value === "string" &&
    value.length <= INT64_MAX_DIGITS + 1 &&
    /^-?(0|[1-9][0-9]*)$/u.test(value)
  ) {
    const digits = value.startsWith("-") ? value.slice(1) : value;
    if (digits.length > INT64_MAX_DIGITS) return null;
    const parsed = BigInt(value);
    return parsed <= INT64_MAX && parsed >= INT64_MIN
      ? parsed.toString()
      : null;
  }
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
  capture: RawCapture,
): Attribute => {
  const empty = {
    key,
    string_value: null,
    bool_value: null,
    int_value: null,
    int_value_raw: null,
    double_value: null,
    bytes_length: null,
    bytes_base64: null,
    element_count: null,
  } as const;
  if (!isRecord(rawValue)) return { ...empty, value_kind: "empty" };
  const kind = Object.keys(rawValue)[0];
  const value = kind === undefined ? undefined : rawValue[kind];
  switch (kind) {
    case "stringValue":
      return {
        ...empty,
        value_kind: "string",
        string_value: typeof value === "string" ? value : null,
      };
    case "boolValue":
      return {
        ...empty,
        value_kind: "bool",
        bool_value: typeof value === "boolean" ? value : null,
      };
    case "intValue": {
      if (capture.lossyNumber?.(rawValue, kind) === true) {
        capture.problem ??= `The numeric intValue at ${capture.pointer} cannot be verified exactly within the numeric limits; use the verified source file.`;
        return { ...empty, value_kind: "int" };
      }
      const parsed = readInt64(value);
      return {
        ...empty,
        value_kind: "int",
        int_value: parsed,
        // An int64 the inventory cannot read is still evidence the export
        // recorded; a null alone would read as an omitted value.
        int_value_raw:
          parsed === null ? retainedRaw(value, capture, "attribute") : null,
      };
    }
    case "doubleValue":
      return {
        ...empty,
        value_kind: "double",
        double_value:
          typeof value === "number" && Number.isFinite(value) ? value : null,
      };
    case "bytesValue":
      return {
        ...empty,
        value_kind: "bytes",
        bytes_length:
          typeof value === "string"
            ? Buffer.from(value, "base64").length
            : null,
        bytes_base64: typeof value === "string" ? value : null,
      };
    case "arrayValue":
      return {
        ...empty,
        value_kind: "array",
        element_count:
          isRecord(value) && Array.isArray(value.values)
            ? value.values.length
            : null,
      };
    case "kvlistValue":
      return {
        ...empty,
        value_kind: "key-value-list",
        element_count:
          isRecord(value) && Array.isArray(value.values)
            ? value.values.length
            : null,
      };
    default:
      return { ...empty, value_kind: "empty" };
  }
};

type Problem = {
  code: OtlpDiagnostic["code"];
  message: string;
  pointer?: string;
};

type ParsedSpan =
  | {
      ok: false;
      problems: readonly Problem[];
      limitReached?: boolean;
      fatalProblem?: string;
    }
  | {
      ok: true;
      span: OtlpSpan;
      problems: readonly Problem[];
      attributesDropped: number;
    };

const parseSpan = (
  record: Record<string, Json>,
  context: {
    readonly pointer: string;
    readonly resourceIndex: number;
    readonly scopeIndex: number;
    readonly budget: { spans: number };
    readonly lossyNumber:
      | ((holder: object, key: string) => boolean)
      | undefined;
  },
): ParsedSpan => {
  const { pointer, resourceIndex, scopeIndex, budget, lossyNumber } = context;
  const traceId = readHexId(record.traceId, 16);
  const spanId = readHexId(record.spanId, 8);
  if (traceId === null || spanId === null)
    return {
      ok: false,
      problems: [
        {
          code: "invalid-record",
          pointer,
          message: `Span at ${pointer} is missing a valid 16-byte traceId or 8-byte spanId.`,
        },
      ],
    };
  budget.spans += 1;
  if (budget.spans > OTLP_TRACE_MAX_SPANS)
    return {
      ok: false,
      limitReached: true,
      problems: [
        {
          code: "span-limit-exceeded",
          pointer,
          message: `Span at ${pointer} exceeds the ${OTLP_TRACE_MAX_SPANS}-span allowance and was not inventoried.`,
        },
      ],
    };
  const problems: Problem[] = [];
  const parentSpanId = readHexId(record.parentSpanId, 8);
  // An empty parentSpanId is the OTLP zero value, which declares no parent.
  const parentRecorded =
    record.parentSpanId !== undefined &&
    record.parentSpanId !== null &&
    record.parentSpanId !== "";
  const parentState =
    !parentRecorded || parentSpanId === "0000000000000000"
      ? "absent"
      : parentSpanId === null
        ? "invalid"
        : "valid";
  const rawValue = record.parentSpanId ?? null;
  // The raw value is nested beneath the inventory's spans array and span object.
  // Validate in that actual context before Evidence clones the result.
  const parentIssue =
    typeof rawValue === "object" && rawValue !== null
      ? jsonValueValidationIssue({ spans: [{ parent_span_id_raw: rawValue }] })
      : undefined;
  if (parentIssue !== undefined)
    return {
      ok: false,
      problems: [],
      fatalProblem: `Parent value at ${pointer}/parentSpanId cannot fit in Evidence: ${parentIssue}`,
    };
  const rawParent = jsonValueSchema.safeParse(rawValue);
  if (parentState === "invalid")
    problems.push({
      code: "invalid-record",
      pointer,
      message: `Span ${spanId} at ${pointer} records a parentSpanId that is not an 8-byte span id; the damaged link is reported as unreadable rather than as an absent parent.`,
    });
  if (
    lossyNumber?.(record, "startTimeUnixNano") === true ||
    lossyNumber?.(record, "endTimeUnixNano") === true
  )
    return {
      ok: false,
      problems: [],
      fatalProblem: `A numeric timestamp at ${pointer} cannot be verified exactly within the numeric limits; use the verified source file.`,
    };
  const startTime = readUInt64(record.startTimeUnixNano);
  const endTime = readUInt64(record.endTimeUnixNano);
  const capture: RawCapture = {
    pointer,
    ...(lossyNumber === undefined ? {} : { lossyNumber }),
  };
  // A timestamp the inventory cannot read is kept as recorded so callers can
  // tell a damaged value from an omitted one and still recover the original.
  const startTimeRaw =
    startTime === null && record.startTimeUnixNano !== undefined
      ? retainedRaw(record.startTimeUnixNano, capture, "timestamp")
      : null;
  const endTimeRaw =
    endTime === null && record.endTimeUnixNano !== undefined
      ? retainedRaw(record.endTimeUnixNano, capture, "timestamp")
      : null;
  if (
    (startTime === null && record.startTimeUnixNano !== undefined) ||
    (endTime === null && record.endTimeUnixNano !== undefined)
  )
    problems.push({
      code: "invalid-record",
      pointer,
      message: `Span ${spanId} at ${pointer} records a timestamp outside the uint64 range; it is retained as recorded in the *_raw fields and no duration is derived from it.`,
    });
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
  const attributes = spanAttributes(retained, capture);
  if (capture.problem !== undefined)
    return { ok: false, problems: [], fatalProblem: capture.problem };
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
    parent_span_id_state: parentState,
    parent_span_id_raw: rawParent.success ? rawParent.data : null,
    name: typeof record.name === "string" ? record.name : "",
    kind: kindName(record.kind),
    start_time_unix_nano: startTime,
    start_time_unix_nano_raw: startTimeRaw,
    end_time_unix_nano: endTime,
    end_time_unix_nano_raw: endTimeRaw,
    duration_nano: duration,
    status_code: statusCode(status?.code),
    status_message:
      typeof status?.message === "string" && status.message.length > 0
        ? status.message
        : null,
    resource_index: resourceIndex,
    scope_index: scopeIndex,
    attributes,
    event_count: Array.isArray(record.events) ? record.events.length : 0,
    link_count: Array.isArray(record.links) ? record.links.length : 0,
    source_pointer: pointer,
  };
  return { ok: true, span, problems, attributesDropped };
};

const spanAttributes = (
  rawAttributes: readonly Json[],
  capture: RawCapture,
): Attribute[] => {
  const parsed: Attribute[] = [];
  for (const entry of rawAttributes) {
    if (!isRecord(entry) || typeof entry.key !== "string") continue;
    parsed.push(readAttribute(entry.key, entry.value, capture));
  }
  return parsed;
};

const isServiceName = (entry: Json): boolean =>
  isRecord(entry) && entry.key === "service.name";

/** Retain one bounded set of attributes for each inventoried resource. */
const resourceAttributes = (
  resource: Json,
  capture: RawCapture,
): { attributes: Attribute[]; dropped: number } => {
  if (!isRecord(resource) || !Array.isArray(resource.attributes))
    return { attributes: [], dropped: 0 };
  // A service.name that carries a string is the one the resource summarises as
  // `service_name`, so it is not repeated here. One that does not is evidence
  // the derived field cannot hold, and dropping it would lose it entirely.
  const candidates = resource.attributes.filter(
    (entry) => !isServiceName(entry) || !isStringServiceName(entry),
  );
  const retained = candidates.slice(0, OTLP_TRACE_MAX_ATTRIBUTES_PER_SPAN);
  return {
    attributes: spanAttributes(retained, capture),
    dropped: candidates.length - retained.length,
  };
};

const isStringServiceName = (entry: Json): boolean =>
  isRecord(entry) &&
  isRecord(entry.value) &&
  typeof entry.value.stringValue === "string";

const resourceServiceName = (resource: Json): string | null => {
  if (!isRecord(resource) || !Array.isArray(resource.attributes)) return null;
  for (const entry of resource.attributes)
    if (isServiceName(entry) && isRecord(entry) && isRecord(entry.value)) {
      const value = entry.value.stringValue;
      return typeof value === "string" ? value : null;
    }
  return null;
};

/** Retain a bounded prefix before constructing diagnostic messages and hashes. */
class ProblemCollector {
  readonly retained: Problem[] = [];
  omitted = 0;

  add(create: () => Problem): void {
    if (this.retained.length >= OTLP_TRACE_MAX_DIAGNOSTICS) {
      this.omitted += 1;
      return;
    }
    this.retained.push(create());
  }
}

type Walked = {
  spans: OtlpSpan[];
  resources: OtlpResource[];
  scopes: OtlpScope[];
  droppedRecords: number;
  spansTruncated: boolean;
  attributesTruncated: boolean;
  resourceAttributesTruncated: boolean;
};

const walkResourceSpans = (
  envelope: unknown,
  budget: { spans: number },
  problems: ProblemCollector,
  lossyNumber?: (holder: object, key: string) => boolean,
): { walked: Walked; unsupported: boolean; problem?: string } => {
  const walked: Walked = {
    spans: [],
    resources: [],
    scopes: [],
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
      problems.add(() => ({
        code: "invalid-record",
        pointer: `/resourceSpans/${resourceIndex}`,
        message: `Resource group at /resourceSpans/${resourceIndex} is not an object and was not inventoried.`,
      }));
      continue;
    }
    let resourceRef: number | undefined;
    const serviceName = resourceServiceName(resourceSpans.resource);
    const capture: RawCapture = {
      pointer: `/resourceSpans/${resourceIndex}/resource/attributes`,
      ...(lossyNumber === undefined ? {} : { lossyNumber }),
    };
    const { attributes: resourceFacts, dropped: resourceDropped } =
      resourceAttributes(resourceSpans.resource, capture);
    if (capture.problem !== undefined)
      return { walked, unsupported: false, problem: capture.problem };
    if (resourceDropped > 0) walked.resourceAttributesTruncated = true;
    // OTLP omits an empty repeated field, so a missing scopeSpans is an empty
    // collection rather than damage; only a present non-array value is.
    if (resourceSpans.scopeSpans === undefined) continue;
    if (!Array.isArray(resourceSpans.scopeSpans)) {
      walked.droppedRecords += 1;
      problems.add(() => ({
        code: "invalid-record",
        pointer: `/resourceSpans/${resourceIndex}/scopeSpans`,
        message: `Resource group at /resourceSpans/${resourceIndex} carries a scopeSpans value that is not an array; its spans were not inventoried.`,
      }));
      continue;
    }
    for (const [scopeIndex, scopeSpans] of resourceSpans.scopeSpans.entries()) {
      if (!isRecord(scopeSpans)) {
        walked.droppedRecords += 1;
        problems.add(() => ({
          code: "invalid-record",
          pointer: `/resourceSpans/${resourceIndex}/scopeSpans/${scopeIndex}`,
          message: `Scope group at /resourceSpans/${resourceIndex}/scopeSpans/${scopeIndex} is not an object and was not inventoried.`,
        }));
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
        problems.add(() => ({
          code: "invalid-record",
          pointer: `/resourceSpans/${resourceIndex}/scopeSpans/${scopeIndex}/spans`,
          message: `Scope at /resourceSpans/${resourceIndex}/scopeSpans/${scopeIndex} carries a spans value that is not an array; its spans were not inventoried.`,
        }));
        continue;
      }
      let scopeRef: number | undefined;
      for (const [spanIndex, record] of scopeSpans.spans.entries()) {
        const pointer = `/resourceSpans/${resourceIndex}/scopeSpans/${scopeIndex}/spans/${spanIndex}`;
        if (!isRecord(record)) {
          walked.droppedRecords += 1;
          problems.add(() => ({
            code: "invalid-record",
            pointer,
            message: `Span entry at ${pointer} is not an object and was not inventoried.`,
          }));
          continue;
        }
        const parsed = parseSpan(record, {
          pointer,
          resourceIndex: resourceRef ?? walked.resources.length,
          scopeIndex: scopeRef ?? walked.scopes.length,
          budget,
          lossyNumber,
        });
        if (!parsed.ok) {
          if (parsed.fatalProblem !== undefined)
            return { walked, unsupported: false, problem: parsed.fatalProblem };
          if (parsed.limitReached) walked.spansTruncated = true;
          walked.droppedRecords += 1;
          for (const problem of parsed.problems) problems.add(() => problem);
          continue;
        }
        if (resourceRef === undefined) {
          resourceRef = walked.resources.length;
          walked.resources.push({
            source_pointer: `/resourceSpans/${resourceIndex}`,
            service_name: serviceName,
            attributes: resourceFacts,
          });
        }
        if (scopeRef === undefined) {
          scopeRef = walked.scopes.length;
          walked.scopes.push({
            source_pointer: `/resourceSpans/${resourceIndex}/scopeSpans/${scopeIndex}`,
            resource_index: resourceRef,
            ...scope,
          });
        }
        walked.spans.push(parsed.span);
        if (parsed.attributesDropped > 0) walked.attributesTruncated = true;
        for (const problem of parsed.problems) problems.add(() => problem);
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
  options?: { readonly lossyNumber?: (holder: object, key: string) => boolean },
): { ok: true; value: OtlpTrace } | { ok: false; problem: string } => {
  const budget = { spans: 0 };
  const problems = new ProblemCollector();
  const { walked, unsupported, problem } = walkResourceSpans(
    document,
    budget,
    problems,
    options?.lossyNumber,
  );
  if (unsupported)
    return {
      ok: false,
      problem:
        "The document is not an OTLP JSON trace export with a resourceSpans array.",
    };
  if (problem !== undefined) return { ok: false, problem };
  const byId = new Map<string, OtlpSpan>();

  // A parent link is only meaningful inside its own trace: the same span id may
  // legitimately appear under different trace ids, and a parent recorded only
  // in another trace is not this span's parent.
  const spanKey = (traceId: string, spanId: string): string =>
    `${traceId}:${spanId}`;
  for (const span of walked.spans) {
    const key = spanKey(span.trace_id, span.span_id);
    if (byId.has(key)) {
      problems.add(() => ({
        code: "duplicate-span-id",
        pointer: span.source_pointer,
        message: `Span id ${span.span_id} appears more than once within trace ${span.trace_id}; the later record at ${span.source_pointer} is retained and the earlier one remains recorded here only.`,
      }));
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
      problems.add(() => ({
        code: "self-parent",
        pointer: span.source_pointer,
        message: `Span ${span.span_id} names itself as its parent.`,
      }));
    else if (!byId.has(spanKey(span.trace_id, parent)))
      orphanParents.set(spanKey(span.trace_id, parent), parent);
  }
  for (const [key, parent] of orphanParents) {
    problems.add(() => ({
      code: "missing-parent",
      message: `Parent span id ${parent} is referenced but not present in trace ${key.slice(0, key.indexOf(":"))}; its children remain parented to an unrecorded span.`,
    }));
  }
  // A span whose recorded parent link is unreadable is not a root: it may be a
  // damaged child, so only a span that declares no parent counts as a root.
  const roots = walked.spans
    .filter((span) => span.parent_span_id_state === "absent")
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
    problems.add(() => ({
      code: "cycle",
      message: `Span ${id} participates in a parent cycle; the recorded links are preserved and no ordering is derived from them.`,
    }));
  const diagnostics = problems.retained.map((problem) =>
    diagnostic(problem.code, problem.pointer ?? "", problem.message),
  );
  diagnostics.sort((left, right) =>
    compareUnicodeCodePoints(left.diagnostic_id, right.diagnostic_id),
  );

  return {
    ok: true,
    value: {
      trace_import_id: digestCanonicalValue([
        artifact.sha256,
        walked.spans.map((span) => span.span_id),
      ]).replace(/^/, "otlp_trace_"),
      format: "otlp-json",
      artifact,
      resources: walked.resources,
      scopes: walked.scopes,
      spans: walked.spans,
      orphan_span_ids: [...orphanParents.values()].sort(),
      roots,
      // A file of malformed groups reaches here with no spans at all, so the
      // span allowance cannot bound it; cap the diagnostics and say so.
      diagnostics,
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
          walked.resources
            .map((resource) => resource.service_name)
            .filter((name): name is string => name !== null),
        ).size,
        diagnostics: diagnostics.length,
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
        ...(problems.omitted > 0
          ? [
              `${problems.omitted} diagnostic${problems.omitted === 1 ? " was" : "s were"} omitted after the first ${OTLP_TRACE_MAX_DIAGNOSTICS} findings in processing order.`,
            ]
          : []),
        ...(walked.resourceAttributesTruncated
          ? [
              `Some resources declare more than ${OTLP_TRACE_MAX_ATTRIBUTES_PER_SPAN} attributes beyond service.name; the excess is dropped from that resource's inventory.`,
            ]
          : []),
      ],
    },
  };
};
