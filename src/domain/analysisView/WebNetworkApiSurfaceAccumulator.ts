import { z } from "zod";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../analysisErrorCore.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { compareUnicodeCodePoints as compare } from "../unicodeCodePointOrder.js";
import { parseRecordedTransportUrl } from "../recordedTransportUrl.js";
import { err, ok, type Result } from "../result.js";
import { MAX_JSON_DEPTH } from "../jsonValue.js";
import {
  WEB_NETWORK_CAPTURE_LIMITS,
  type WebNetworkCaptureRecord,
} from "../webNetworkCapture.js";
import { pageViewCoverage } from "./analysisViewCoverage.js";
import type { UnsignedAnalysisView } from "./analysisView.js";

type Surface = Extract<UnsignedAnalysisView, { kind: "api-surface" }>;
type Group = Surface["groups"][number];
type Rule = Group["templated_segments"][number]["rule"];
type Exclusion = Surface["excluded_records"][number];
interface Segment {
  readonly segment_index: number;
  readonly rule: Rule;
  readonly value: string;
}
interface Route {
  readonly template: string;
  readonly rules: string;
  readonly segments: readonly Segment[];
}
interface GroupState {
  readonly method: string;
  readonly origin: string;
  readonly path_template: string;
  readonly segments: readonly {
    readonly segment_index: number;
    readonly rule: Rule;
    readonly values: Set<string>;
  }[];
  readonly ordinals: number[];
  readonly statuses: Set<number>;
  readonly contentTypes: Set<string>;
}
type Buckets = Map<string, Map<string, Map<string, Map<string, GroupState>>>>;

const requestSchema = z.object({
  request: z.object({ url: z.unknown(), method: z.unknown() }),
});
const responseSchema = z.object({
  response: z.object({
    status: z.unknown().optional(),
    content: z.unknown().optional(),
  }),
});
const contentSchema = z.object({ mimeType: z.unknown().optional() });
const MEDIA_TYPE_ESSENCE =
  /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;

const mediaTypeEssence = (reported: string): string | null => {
  const separator = reported.indexOf(";");
  let start = 0;
  let end = separator < 0 ? reported.length : separator;
  // HTTP OWS is SP/HTAB. Scan from both ends so malformed internal runs of
  // whitespace cannot cause repeated trailing-regex searches.
  while (start < end && (reported[start] === " " || reported[start] === "\t"))
    start += 1;
  while (
    end > start &&
    (reported[end - 1] === " " || reported[end - 1] === "\t")
  )
    end -= 1;
  const essence = reported.slice(start, end);
  // Validate ASCII tokens before case folding can turn Unicode into ASCII.
  return MEDIA_TYPE_ESSENCE.test(essence) ? essence.toLowerCase() : null;
};

// Conservative representation allowances, not an enforced V8 heap limit.
// Fixed charges include the accumulator, bucket/set entries, array growth and
// page/schema projection. Text includes UTF-16 storage and two worst-case JSON
// encodings (transport text and UTF-8 bytes); no serialization is needed to count.
const GROUP_BYTES = 2048;
const SEGMENT_BYTES = 1024;
const ENTRY_BYTES = 128;
const RECORD_SCRATCH_BYTES = 512;
const SEGMENT_SCRATCH_BYTES = 512;
const CAPTURE_CONTAINER_BYTES = 512;
// Covers cloned member slots and per-member validation/entries/map scratch.
// Scalar strings remain shared references, so their text is not copied here.
const CAPTURE_MEMBER_BYTES = 256;
const textBytes = (length: number): number => 32 + length * 14;

const segmentRule = (value: string): Rule | null => {
  if (/^[0-9]+$/u.test(value)) return "numeric";
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value,
    )
  )
    return "uuid";
  if (/^[0-9a-f]{32,}$/iu.test(value)) return "hex";
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    )
      return "iso-date";
  }
  return null;
};

/** Own group identity, deduplication and admission for the entire projection. */
export class WebNetworkApiSurfaceAccumulator {
  readonly #buckets: Buckets = new Map();
  readonly #groups: GroupState[] = [];
  readonly #excluded: Exclusion[] = [];
  readonly #limitations = new Set<string>();
  #unavailableResponse = false;
  #retainedBytes = 0;
  #temporaryBytes = 0;

  constructor(readonly maximumBytes = WEB_NETWORK_CAPTURE_LIMITS.outputBytes) {}

  #retain(bytes: number): boolean {
    if (this.#retainedBytes + this.#temporaryBytes + bytes > this.maximumBytes)
      return false;
    this.#retainedBytes += bytes;
    return true;
  }

  #temporary(bytes: number): boolean {
    if (this.#retainedBytes + this.#temporaryBytes + bytes > this.maximumBytes)
      return false;
    this.#temporaryBytes += bytes;
    return true;
  }

  #overBudget(): Result<never, AnalysisError> {
    return err(
      new AnalysisResourceConstraintError(
        "inspect_analysis_view",
        "memory",
        "API-surface retained state and temporary work exceed the projection representation budget.",
        { output_bytes: this.maximumBytes },
      ),
    );
  }

  /** Reserve schema output and validation scratch while the borrowed parent stays live. */
  admitCaptureClone(value: unknown): Result<void, AnalysisError> {
    return this.#admitCaptureValue(value, new Set(), 0, false);
  }

  /** Admit the complete portable envelope before cloning or authenticating it. */
  admitInlineEvidence(value: unknown): Result<void, AnalysisError> {
    return this.#admitCaptureValue(value, new Set(), 0, true);
  }

  #admitCaptureValue(
    value: unknown,
    ancestors: Set<object>,
    depth: number,
    inline: boolean,
  ): Result<void, AnalysisError> {
    // Capture records add three levels before reported; inline Evidence adds one.
    if (
      depth > MAX_JSON_DEPTH + (inline ? 4 : 3) ||
      (typeof value === "object" && value !== null && ancestors.has(value))
    )
      return this.#invalidCapture();
    if (!this.#retain(CAPTURE_MEMBER_BYTES)) return this.#overBudget();
    // Evidence authentication encodes strings and object keys for hashing.
    // Keep that allowance live alongside the envelope clone and projection.
    if (
      inline &&
      typeof value === "string" &&
      !this.#retain(textBytes(value.length))
    )
      return this.#overBudget();
    if (typeof value !== "object" || value === null) return ok(undefined);
    if (!this.#retain(CAPTURE_CONTAINER_BYTES)) return this.#overBudget();
    ancestors.add(value);
    // Walk depth-first without building a second capture graph. Member charges
    // include key enumeration; aliases count each time the schema copies them.
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
          return this.#invalidCapture();
        const admitted = this.#admitCaptureValue(
          descriptor.value,
          ancestors,
          depth + 1,
          inline,
        );
        if (!admitted.ok) return admitted;
      }
    } else {
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        return this.#invalidCapture();
      // Zod reads named fields even when they are non-enumerable.
      for (const key of Object.getOwnPropertyNames(value)) {
        if (inline && !this.#retain(textBytes(key.length)))
          return this.#overBudget();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
          return this.#invalidCapture();
        const admitted = this.#admitCaptureValue(
          descriptor.value,
          ancestors,
          depth + 1,
          inline,
        );
        if (!admitted.ok) return admitted;
      }
    }
    ancestors.delete(value);
    return ok(undefined);
  }

  #invalidCapture(): Result<never, AnalysisError> {
    return err(
      new AnalysisInputError("inspect_analysis_view", undefined, [
        {
          path: ["source"],
          reason: "invalid_value",
          message:
            "Parent capture must contain bounded ordinary JSON data without cycles or accessors.",
        },
      ]),
    );
  }

  addLimitations(limitations: readonly string[]): Result<void, AnalysisError> {
    for (const limitation of limitations) {
      if (this.#limitations.has(limitation)) continue;
      if (!this.#retain(ENTRY_BYTES + textBytes(limitation.length)))
        return this.#overBudget();
      this.#limitations.add(limitation);
    }
    return ok(undefined);
  }

  #exclude(
    ordinal: number,
    reason: Exclusion["reason"],
  ): Result<void, AnalysisError> {
    if (!this.#retain(ENTRY_BYTES + RECORD_SCRATCH_BYTES))
      return this.#overBudget();
    this.#excluded.push({ ordinal, reason });
    return ok(undefined);
  }

  /** Scan literal spans; only matched segments need descriptors or template parts. */
  #route(path: string): Result<Route, AnalysisError> {
    const segments: Segment[] = [];
    const parts: string[] = [];
    const rules: string[] = [];
    let templateLength = path.length;
    let rulesLength = 0;
    let copied = 0;
    let index = 0;
    let start = 1;
    for (;;) {
      const slash = path.indexOf("/", start);
      const end = slash < 0 ? path.length : slash;
      const value = path.slice(start, end);
      const rule = segmentRule(value);
      if (rule !== null) {
        if (!this.#temporary(SEGMENT_SCRATCH_BYTES)) return this.#overBudget();
        const placeholder = `{${rule}}`;
        const identity = `${index}:${rule};`;
        segments.push({ segment_index: index, rule, value });
        parts.push(path.slice(copied, start), placeholder);
        rules.push(identity);
        templateLength += placeholder.length - value.length;
        rulesLength += identity.length;
        copied = end;
      }
      if (slash < 0) break;
      start = slash + 1;
      index += 1;
    }
    if (segments.length === 0)
      return ok({ template: path, rules: "", segments });
    if (!this.#temporary(textBytes(templateLength) + textBytes(rulesLength)))
      return this.#overBudget();
    parts.push(path.slice(copied));
    return ok({ template: parts.join(""), rules: rules.join(""), segments });
  }

  add(record: WebNetworkCaptureRecord): Result<void, AnalysisError> {
    const limitations = this.addLimitations(record.limitations);
    if (!limitations.ok) return limitations;
    const request = requestSchema.safeParse(record.reported);
    if (!request.success)
      return this.#exclude(record.ordinal, "request-unavailable");
    const { url, method } = request.data.request;
    if (url === null) return this.#exclude(record.ordinal, "url-redacted");
    if (typeof url !== "string")
      return this.#exclude(record.ordinal, "url-unparseable");
    // Admission precedes URL parsing, text normalization and path materialization.
    if (!this.#temporary(RECORD_SCRATCH_BYTES + textBytes(url.length)))
      return this.#overBudget();
    try {
      const parsed = parseRecordedTransportUrl(url);
      if (parsed.origin === null)
        return this.#exclude(record.ordinal, "url-unparseable");
      if (typeof method !== "string" || method.length === 0)
        return this.#exclude(record.ordinal, "method-unavailable");
      if (parsed.path === null)
        return this.#exclude(record.ordinal, "url-unparseable");
      const response = responseSchema.safeParse(record.reported);
      const status = response.success
        ? response.data.response.status
        : undefined;
      const content = contentSchema.safeParse(
        response.success ? response.data.response.content : undefined,
      );
      const mime = content.success ? content.data.mimeType : undefined;
      const rawMime = typeof mime === "string" ? mime : "";
      if (!this.#temporary(textBytes(rawMime.length)))
        return this.#overBudget();
      const route = this.#route(parsed.path);
      if (!route.ok) return route;
      return this.#append(
        record.ordinal,
        method,
        parsed.origin,
        route.value,
        typeof status === "number" && status !== 0 ? status : null,
        mediaTypeEssence(rawMime),
      );
    } finally {
      // Per-record strings and descriptors never become cumulative scratch.
      this.#temporaryBytes = 0;
    }
  }

  #append(
    ordinal: number,
    method: string,
    origin: string,
    route: Route,
    status: number | null,
    mime: string | null,
  ): Result<void, AnalysisError> {
    let group = this.#buckets
      .get(method)
      ?.get(origin)
      ?.get(route.template)
      ?.get(route.rules);
    let bytes = ENTRY_BYTES; // One retained record ordinal, including page output.
    if (group === undefined) {
      bytes +=
        GROUP_BYTES +
        textBytes(method.length) +
        textBytes(origin.length) +
        textBytes(route.template.length) +
        textBytes(route.rules.length);
      for (const segment of route.segments)
        bytes += SEGMENT_BYTES + ENTRY_BYTES + textBytes(segment.value.length);
    } else {
      for (const [index, segment] of route.segments.entries()) {
        if (!group.segments[index]!.values.has(segment.value))
          bytes += ENTRY_BYTES + textBytes(segment.value.length);
      }
    }
    if (status !== null && !group?.statuses.has(status)) bytes += ENTRY_BYTES;
    if (mime !== null && !group?.contentTypes.has(mime))
      bytes += ENTRY_BYTES + textBytes(mime.length);
    // Reserve the whole mutation while route scratch is still live. No sets,
    // map entries, arrays or new observed values are retained before admission.
    if (!this.#retain(bytes)) return this.#overBudget();
    if (group === undefined) {
      group = {
        method,
        origin,
        path_template: route.template,
        segments: route.segments.map((segment) => ({
          segment_index: segment.segment_index,
          rule: segment.rule,
          values: new Set([segment.value]),
        })),
        ordinals: [],
        statuses: new Set(),
        contentTypes: new Set(),
      };
      const byOrigin = this.#buckets.get(method) ?? new Map();
      this.#buckets.set(method, byOrigin);
      const byTemplate = byOrigin.get(origin) ?? new Map();
      byOrigin.set(origin, byTemplate);
      const byRule = byTemplate.get(route.template) ?? new Map();
      byTemplate.set(route.template, byRule);
      byRule.set(route.rules, group);
      this.#groups.push(group);
    } else {
      for (const [index, segment] of route.segments.entries())
        group.segments[index]!.values.add(segment.value);
    }
    group.ordinals.push(ordinal);
    if (status === null || mime === null) this.#unavailableResponse = true;
    if (status !== null) group.statuses.add(status);
    if (mime !== null) group.contentTypes.add(mime);
    return ok(undefined);
  }

  page(
    offset: number,
    limit: number,
  ): Pick<
    Surface,
    | "coverage"
    | "groups"
    | "templated_groups"
    | "excluded_records"
    | "limitations"
    | "unknowns"
  > {
    this.#groups.sort(
      (a, b) =>
        compare(a.origin, b.origin) ||
        compare(a.path_template, b.path_template) ||
        compare(a.method, b.method),
    );
    const groups = this.#groups
      .slice(offset, offset + limit)
      .map((group): Group => ({
        method: group.method,
        origin: group.origin,
        path_template: group.path_template,
        templated_segments: group.segments.map((segment) => ({
          segment_index: segment.segment_index,
          rule: segment.rule,
          basis: "inferred",
          observed_values: [...segment.values].sort(compare),
        })),
        record_ordinals: [...group.ordinals],
        statuses: [...group.statuses].sort((a, b) => a - b),
        content_types: [...group.contentTypes].sort(compare),
        flags: [
          ...(group.ordinals.length === 1 ? ["single-sample" as const] : []),
          ...(group.statuses.size > 1 ? ["mixed-statuses" as const] : []),
          ...(group.contentTypes.size > 1
            ? ["mixed-content-types" as const]
            : []),
        ],
      }));
    return {
      coverage: pageViewCoverage(offset, groups.length, this.#groups.length),
      groups,
      templated_groups: this.#groups.reduce(
        (count, group) => count + (group.segments.length > 0 ? 1 : 0),
        0,
      ),
      excluded_records: [...this.#excluded],
      limitations: [...this.#limitations].sort(compare),
      unknowns: this.#unavailableResponse
        ? [
            "Some retained records have unavailable status or content type values.",
          ]
        : [],
    };
  }
}
