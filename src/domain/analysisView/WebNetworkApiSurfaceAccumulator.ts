import { mediaTypeEssence } from "./recordedMediaType.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { compareUnicodeCodePoints as compare } from "../unicodeCodePointOrder.js";
import { ok, type Result } from "../result.js";
import {
  WEB_NETWORK_CAPTURE_LIMITS,
  type WebNetworkCaptureRecord,
} from "../webNetworkCapture.js";
import { pageViewCoverage } from "./analysisViewCoverage.js";
import { z } from "zod";
import { apiSurfaceFields } from "./apiSurfaceSchema.js";
import { WebNetworkProjectionAccumulator } from "./WebNetworkProjectionAccumulator.js";
import {
  CAPTURE_CONTAINER_BYTES,
  ENTRY_BYTES,
  GROUP_BYTES,
  RECORD_SCRATCH_BYTES,
  SEGMENT_BYTES,
  readQueryParameterNames,
  readRecordedHeaderNames,
  readRecordedRequestLine,
  scanRouteTemplate,
  textBytes,
  type RouteRule,
  type RouteTemplate,
  type RecordedHeaderNames,
  type RecordedRequestLine,
} from "./webNetworkRouteTemplates.js";

type ApiSurfaceFields = {
  [Key in keyof typeof apiSurfaceFields]: z.output<
    (typeof apiSurfaceFields)[Key]
  >;
};
type Group = ApiSurfaceFields["groups"][number];
type Exclusion = ApiSurfaceFields["excluded_records"][number];
interface GroupState {
  readonly method: string;
  readonly origin: string;
  readonly path_template: string;
  readonly rules: string;
  readonly paths?: Map<string, number>;
  readonly segments: readonly {
    readonly segment_index: number;
    readonly rule: RouteRule;
    readonly values: Set<string>;
  }[];
  readonly ordinals: number[];
  readonly statuses: Set<number>;
  readonly contentTypes: Set<string>;
  readonly queryNames?: Map<string, number[]>;
  readonly headers?: HeaderNames;
}
/** One name surface's retained name-to-ordinal map. */
type Names = Map<string, number[]>;
interface HeaderNames {
  readonly request: Names;
  readonly cookie: Names;
  readonly setCookie: Names;
}
type Buckets = Map<string, Map<string, Map<string, Map<string, GroupState>>>>;

/** Borrowed group facts; exact membership retains whole paths, never segment products. */
export interface ApiSurfaceComparisonGroup {
  readonly method: string;
  readonly origin: string;
  readonly path_template: string;
  readonly rules: string;
  readonly templated_segments: readonly {
    readonly segment_index: number;
    readonly rule: RouteRule;
  }[];
  readonly record_ordinals: readonly number[];
  readonly exactPathOrdinal: (path: string) => number | undefined;
}

const sortedNames = (names: Names) =>
  [...names]
    .sort(([a], [b]) => compare(a, b))
    .map(([name, record_ordinals]) => ({
      name,
      record_ordinals: [...record_ordinals],
    }));

/** Own group identity, deduplication and admission for the entire projection. */
export class WebNetworkApiSurfaceAccumulator extends WebNetworkProjectionAccumulator {
  readonly #buckets: Buckets = new Map();
  readonly #groups: GroupState[] = [];
  readonly #excluded: Exclusion[] = [];
  #unavailableResponse = false;
  #unreadableHeaderMember = false;

  constructor(
    maximumBytes = WEB_NETWORK_CAPTURE_LIMITS.outputBytes,
    readonly includeQueryParameterNames = false,
    private readonly comparison?: {
      readonly operation: string;
    },
    readonly includeRequestHeaderNames = false,
  ) {
    super(maximumBytes, "API-surface", comparison?.operation);
  }

  #exclude(
    ordinal: number,
    reason: Exclusion["reason"],
  ): Result<void, AnalysisError> {
    if (!this.retain(ENTRY_BYTES + RECORD_SCRATCH_BYTES))
      return this.overBudget();
    this.#excluded.push({ ordinal, reason });
    return ok(undefined);
  }

  add(record: WebNetworkCaptureRecord): Result<void, AnalysisError> {
    const rollbackAdmission = this.retainedCheckpoint();
    const limitations = this.prepareLimitations(record.limitations);
    if (!limitations.ok) return limitations;
    let committed = false;
    try {
      const line = readRecordedRequestLine(
        record.reported,
        this.includeQueryParameterNames,
        this.scratch,
      );
      if (line === null) return this.overBudget();
      let appended: Result<void, AnalysisError>;
      if (line.kind === "excluded")
        appended = this.#exclude(record.ordinal, line.reason);
      else {
        const route = scanRouteTemplate(line.path, this.scratch);
        if (route === null) return this.overBudget();
        const queryNames = readQueryParameterNames(line.query, this.scratch);
        if (queryNames === null) return this.overBudget();
        const headers = this.includeRequestHeaderNames
          ? readRecordedHeaderNames(record.reported, this.scratch)
          : undefined;
        if (headers === null) return this.overBudget();
        appended = this.#append(
          record.ordinal,
          line,
          route,
          queryNames,
          headers,
        );
      }
      if (appended.ok) {
        limitations.value();
        committed = true;
      }
      return appended;
    } finally {
      if (!committed) rollbackAdmission();
      this.releaseTemporary();
    }
  }

  #append(
    ordinal: number,
    line: Extract<RecordedRequestLine, { readonly kind: "line" }>,
    route: RouteTemplate,
    queryNames: ReadonlySet<string> | undefined,
    headers: RecordedHeaderNames | undefined,
  ): Result<void, AnalysisError> {
    const { method, origin, path, status } = line;
    const mime = mediaTypeEssence(line.rawMime);
    let group = this.#buckets
      .get(method)
      ?.get(origin)
      ?.get(route.template)
      ?.get(route.rules);
    let bytes = ENTRY_BYTES; // One retained record ordinal, including page output.
    if (this.comparison !== undefined && !group?.paths?.has(path))
      bytes += ENTRY_BYTES + textBytes(path.length);
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
    if (queryNames !== undefined) {
      if (group === undefined) bytes += CAPTURE_CONTAINER_BYTES;
      for (const name of queryNames) {
        bytes += ENTRY_BYTES; // This name's source ordinal, once per record.
        if (!group?.queryNames?.has(name))
          bytes += ENTRY_BYTES + textBytes(name.length);
      }
    }
    if (headers !== undefined) {
      if (group === undefined) bytes += CAPTURE_CONTAINER_BYTES * 3;
      for (const [surface, names] of [
        ["request", headers.request],
        ["cookie", headers.cookie],
        ["setCookie", headers.setCookie],
      ] as const) {
        for (const name of names) {
          bytes += ENTRY_BYTES; // This name's source ordinal, once per record.
          if (!group?.headers?.[surface].has(name))
            bytes += ENTRY_BYTES + textBytes(name.length);
        }
      }
    }
    // Reserve the whole mutation while route scratch is still live. No sets,
    // map entries, arrays or new observed values are retained before admission.
    if (!this.retain(bytes)) return this.overBudget();
    if (group === undefined) {
      group = {
        method,
        origin,
        path_template: route.template,
        rules: route.rules,
        ...(this.comparison === undefined
          ? {}
          : { paths: new Map<string, number>() }),
        segments: route.segments.map((segment) => ({
          segment_index: segment.segment_index,
          rule: segment.rule,
          values: new Set([segment.value]),
        })),
        ordinals: [],
        statuses: new Set(),
        contentTypes: new Set(),
        ...(queryNames === undefined ? {} : { queryNames: new Map() }),
        ...(headers === undefined
          ? {}
          : {
              headers: {
                request: new Map(),
                cookie: new Map(),
                setCookie: new Map(),
              },
            }),
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
    if (group.paths !== undefined && !group.paths.has(path))
      group.paths.set(path, ordinal);
    if (status === null || mime === null) this.#unavailableResponse = true;
    if (headers?.unreadableMember === true) this.#unreadableHeaderMember = true;
    if (status !== null) group.statuses.add(status);
    if (mime !== null) group.contentTypes.add(mime);
    if (queryNames !== undefined && group.queryNames !== undefined) {
      for (const name of queryNames) {
        const ordinals = group.queryNames.get(name);
        if (ordinals === undefined) group.queryNames.set(name, [ordinal]);
        else ordinals.push(ordinal);
      }
    }
    if (group.headers !== undefined && headers !== undefined)
      for (const [names, selected] of [
        [group.headers.request, headers.request],
        [group.headers.cookie, headers.cookie],
        [group.headers.setCookie, headers.setCookie],
      ] as const)
        for (const name of selected) {
          const ordinals = names.get(name);
          if (ordinals === undefined) names.set(name, [ordinal]);
          else ordinals.push(ordinal);
        }
    return ok(undefined);
  }

  /** Comparison-only inventory, borrowing admitted ordinals without page serialization. */
  *comparisonGroups(): IterableIterator<ApiSurfaceComparisonGroup> {
    if (this.comparison === undefined)
      throw new Error(
        "Exact paths must be retained when admitting comparison records",
      );
    for (const group of this.#groups)
      yield {
        method: group.method,
        origin: group.origin,
        path_template: group.path_template,
        rules: group.rules,
        templated_segments: group.segments.map(({ segment_index, rule }) => ({
          segment_index,
          rule,
        })),
        record_ordinals: group.ordinals,
        exactPathOrdinal: (path) => group.paths!.get(path),
      };
  }

  /** Counts do not allocate the existing view's complete page or exclusion list. */
  comparisonCoverage() {
    return {
      groups: this.#groups.length,
      excluded_records: this.#excluded.length,
    };
  }

  page(offset: number, limit: number) {
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
        ...(group.queryNames === undefined
          ? {}
          : { query_parameter_names: sortedNames(group.queryNames) }),
        ...(group.headers === undefined
          ? {}
          : {
              request_header_names: {
                request_headers: sortedNames(group.headers.request),
                cookie_names: sortedNames(group.headers.cookie),
                set_cookie_names: sortedNames(group.headers.setCookie),
              },
            }),
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
      limitations: this.sortedLimitations(),
      unknowns: [
        ...(this.#unavailableResponse
          ? [
              "Some retained records have unavailable status or content type values.",
            ]
          : []),
        ...(this.#unreadableHeaderMember
          ? [
              "Some retained header, cookie or set-cookie members have no string name, so the selected name lists are incomplete.",
            ]
          : []),
      ],
    };
  }
}
