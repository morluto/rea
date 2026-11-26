import { digestCanonicalValue } from "../canonicalDigest.js";
import { compareUnicodeCodePoints as compare } from "../unicodeCodePointOrder.js";
import { parseRecordedTransportUrl } from "../recordedTransportUrl.js";
import { err, ok, type Result } from "../result.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import type { JavaScriptApplicationGraph } from "./javascriptApplicationGraph.js";
import {
  WebNetworkApiSurfaceAccumulator,
  type ApiSurfaceComparisonGroup,
} from "../analysisView/WebNetworkApiSurfaceAccumulator.js";
import {
  ENTRY_BYTES,
  GROUP_BYTES,
  scanRouteTemplate,
  textBytes,
} from "../analysisView/webNetworkRouteTemplates.js";
import type { StaticObservedEndpointComparison } from "./staticObservedEndpointSchemas.js";

type Endpoint = StaticObservedEndpointComparison["static_endpoints"][number];
type Group = StaticObservedEndpointComparison["observed_groups"][number];
type Match = StaticObservedEndpointComparison["matches"][number];
const identity = (prefix: string, facts: unknown) =>
  `${prefix}_${digestCanonicalValue(facts)}`;
const routeKey = (origin: string, path: string, rules: string) =>
  JSON.stringify([origin, path, rules]);

/** Interpret only method-bearing API spellings; fetch options and XHR methods stay unknown. */
const methodFor = (
  mechanism: unknown,
): Pick<Endpoint, "method" | "method_basis"> => {
  if (typeof mechanism !== "string")
    return { method: null, method_basis: "unknown" };
  if (/(?:^|[.:])EventSource$/u.test(mechanism))
    return { method: "GET", method_basis: "api-definition" };
  if (/(?:^|[.:])sendBeacon$/u.test(mechanism))
    return { method: "POST", method_basis: "api-definition" };
  const method = /(?:^|[.:])(get|post|put|patch|delete|head|options)$/u.exec(
    mechanism,
  )?.[1];
  return method === undefined
    ? { method: null, method_basis: "unknown" }
    : { method: method.toUpperCase(), method_basis: "callee-spelling" };
};

/** Keep recorded spelling; targets requiring URL normalization stay unknown instead of acquiring a different identity. */
const targetFor = (
  value: unknown,
  origin: string | undefined,
): Pick<Endpoint, "origin" | "origin_basis" | "path" | "reason"> => {
  const unknown = (reason: Endpoint["reason"]) => ({
    origin: null,
    origin_basis: "unknown" as const,
    path: null,
    reason,
  });
  if (typeof value !== "string") return unknown("unparseable-target");
  if (value.startsWith("/") && !value.startsWith("//")) {
    const path = value.split(/[?#]/u, 1)[0]!;
    if (origin === undefined) return { ...unknown("origin-required"), path };
    // Use the same recorded URL owner as HAR, rather than URL.pathname's normalization.
    const parsed = parseRecordedTransportUrl(`${origin}${path}`);
    if (
      parsed.path !== path ||
      parsed.origin !== origin ||
      parsed.credentials !== null
    )
      return unknown("unparseable-target");
    if (URL.parse(`${origin}${path}`)?.pathname !== path)
      return unknown("normalization-required");
    return { origin, origin_basis: "caller-origin", path, reason: null };
  }
  if (!/^https?:\/\//iu.test(value))
    return unknown(
      /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
        ? "non-http-target"
        : "unresolved-target",
    );
  const parsed = parseRecordedTransportUrl(value);
  if (
    parsed.path === null ||
    parsed.origin === null ||
    parsed.credentials !== null
  )
    return unknown("unparseable-target");
  if (URL.parse(value)?.pathname !== parsed.path)
    return unknown("normalization-required");
  return {
    origin: parsed.origin,
    origin_basis: "literal-url",
    path: parsed.path,
    reason: null,
  };
};

interface ComparisonInput {
  readonly applicationEvidenceId: string;
  readonly captureEvidenceId: string;
  readonly graph: JavaScriptApplicationGraph;
  readonly accumulator: WebNetworkApiSurfaceAccumulator;
  readonly origin?: string;
  readonly captureComplete: boolean;
}
interface IndexedGroup {
  readonly source: ApiSurfaceComparisonGroup;
  readonly row: Group;
}
interface ObservedIndex {
  readonly rows: Group[];
  readonly routes: Map<
    string,
    { methods: Map<string, IndexedGroup>; ambiguous: boolean }
  >;
  readonly origins: Set<string>;
  readonly complete: boolean;
}
type Node = JavaScriptApplicationGraph["nodes"][number];

/** Each route owns its methods and ambiguity; a group is never guessed from display text. */
const indexObservedGroups = (
  input: ComparisonInput,
): Result<ObservedIndex, AnalysisError> => {
  const { accumulator } = input;
  const index: ObservedIndex = {
    rows: [],
    routes: new Map(),
    origins: new Set(),
    complete:
      input.captureComplete &&
      accumulator.comparisonCoverage().excluded_records === 0,
  };
  for (const source of accumulator.comparisonGroups()) {
    const admitted = accumulator.admitDerivedBytes(
      GROUP_BYTES + ENTRY_BYTES * source.record_ordinals.length,
    );
    if (!admitted.ok) return admitted;
    const row: Group = {
      group_id: identity("observed_endpoint", [
        input.captureEvidenceId,
        source.method,
        source.origin,
        source.path_template,
        source.templated_segments,
      ]),
      method: source.method,
      origin: source.origin,
      path_template: source.path_template,
      templated_segments: [...source.templated_segments],
      record_ordinals: [...source.record_ordinals],
      status: "observed-without-static-match",
      reason: null,
    };
    index.rows.push(row);
    index.origins.add(source.origin);
    const key = routeKey(source.origin, source.path_template, source.rules);
    const bucket = index.routes.get(key);
    if (bucket === undefined)
      index.routes.set(key, {
        methods: new Map([[source.method, { source, row }]]),
        ambiguous: false,
      });
    else bucket.methods.set(source.method, { source, row });
  }
  return ok(index);
};

const readStaticEndpoint = (
  input: ComparisonInput,
  node: Node,
  observation: Node["observations"][number],
): Result<Endpoint | undefined, AnalysisError> => {
  const properties = observation.properties;
  if (properties.endpoint_kind !== "network") return ok(undefined);
  const admitted = input.accumulator.admitDerivedBytes(
    GROUP_BYTES +
      (typeof properties.value === "string"
        ? textBytes(properties.value.length)
        : 0),
  );
  if (!admitted.ok) return admitted;
  const candidate = properties.interpretation === "candidate";
  const partial = properties.resolution === "partial";
  let reason: Endpoint["reason"] = null;
  if (candidate) reason = "candidate-endpoint";
  else if (observation.evidence.state !== "observed")
    reason = "unconfirmed-static-observation";
  else if (partial) reason = "partial-target";
  return ok({
    endpoint_id: identity("static_endpoint", [
      input.applicationEvidenceId,
      node.node_id,
      observation.observation_id,
    ]),
    node_id: node.node_id,
    observation_id: observation.observation_id,
    ...methodFor(reason === null ? properties.mechanism : undefined),
    ...(reason !== null
      ? {
          origin: null,
          origin_basis: "unknown" as const,
          path: null,
          reason,
        }
      : targetFor(properties.value, input.origin)),
    status: "unknown",
  });
};

const matchEndpoint = (
  endpoint: Endpoint,
  index: ObservedIndex,
  budget: WebNetworkApiSurfaceAccumulator,
): Result<Match | undefined, AnalysisError> => {
  if (
    endpoint.reason !== null ||
    endpoint.path === null ||
    endpoint.origin === null
  )
    return ok(undefined);
  let failure: AnalysisError | undefined;
  const route = scanRouteTemplate(endpoint.path, (bytes) => {
    const admitted = budget.admitDerivedBytes(bytes);
    if (!admitted.ok) failure = admitted.error;
    return admitted.ok;
  });
  if (route === null) {
    if (failure === undefined)
      throw new Error("Route reservation failed without its owned error");
    return err(failure);
  }
  const bucket = index.routes.get(
    routeKey(endpoint.origin, route.template, route.rules),
  );
  if (
    endpoint.method === null &&
    bucket !== undefined &&
    bucket.methods.size > 1
  ) {
    endpoint.reason = "ambiguous-method";
    bucket.ambiguous = true;
    return ok(undefined);
  }
  const selected =
    endpoint.method === null
      ? bucket?.methods.values().next().value
      : bucket?.methods.get(endpoint.method);
  if (selected !== undefined) {
    const admitted = budget.admitDerivedBytes(GROUP_BYTES);
    if (!admitted.ok) return admitted;
    endpoint.status = "matched";
    selected.row.status = "matched";
    const exactOrdinal = selected.source.exactPathOrdinal(endpoint.path);
    const basis =
      exactOrdinal !== undefined
        ? ("exact" as const)
        : ("template-compatible" as const);
    return ok({
      match_id: identity("endpoint_match", [
        endpoint.endpoint_id,
        selected.row.group_id,
        basis,
      ]),
      endpoint_id: endpoint.endpoint_id,
      group_id: selected.row.group_id,
      basis,
      supporting_record_ordinal:
        exactOrdinal ?? selected.source.record_ordinals[0]!,
    });
  }
  if (!index.complete) endpoint.reason = "capture-incomplete";
  else if (!index.origins.has(endpoint.origin))
    endpoint.reason = "origin-not-exercised";
  else {
    endpoint.status = "not-observed-in-capture";
    endpoint.reason = "no-observed-match";
  }
  return ok(undefined);
};

const finalizeObservedGroups = (index: ObservedIndex): void => {
  for (const bucket of index.routes.values()) {
    if (!bucket.ambiguous) continue;
    for (const { row } of bucket.methods.values()) {
      if (row.status === "matched") continue;
      row.status = "unknown";
      row.reason = "ambiguous-static-method";
    }
  }
  index.rows.sort((a, b) => compare(a.group_id, b.group_id));
};

const summarize = (
  endpoints: readonly Endpoint[],
  groups: readonly Group[],
  matchCount: number,
): StaticObservedEndpointComparison["summary"] => {
  const summary = {
    static_network_endpoint_observations: endpoints.length,
    matched: 0,
    not_observed_in_capture: 0,
    unknown: 0,
    observed_groups: groups.length,
    observed_without_static_match: 0,
    observed_unknown: 0,
    matches: matchCount,
  };
  for (const endpoint of endpoints) {
    if (endpoint.status === "matched") summary.matched++;
    else if (endpoint.status === "unknown") summary.unknown++;
    else summary.not_observed_in_capture++;
  }
  for (const group of groups) {
    if (group.status === "observed-without-static-match")
      summary.observed_without_static_match++;
    else if (group.status === "unknown") summary.observed_unknown++;
  }
  return summary;
};

/** Join admitted observations in indexed work; retain one concrete witness per pairing. */
export const compareStaticObservedEndpoints = (
  input: ComparisonInput,
): Result<
  Pick<
    StaticObservedEndpointComparison,
    "static_endpoints" | "observed_groups" | "matches" | "summary"
  >,
  AnalysisError
> => {
  const indexed = indexObservedGroups(input);
  if (!indexed.ok) return indexed;
  const index = indexed.value;
  const endpoints: Endpoint[] = [];
  const matches: Match[] = [];
  for (const node of input.graph.nodes) {
    if (node.kind !== "endpoint") continue;
    for (const observation of node.observations) {
      const endpoint = readStaticEndpoint(input, node, observation);
      if (!endpoint.ok) return endpoint;
      if (endpoint.value === undefined) continue;
      endpoints.push(endpoint.value);
      const match = matchEndpoint(endpoint.value, index, input.accumulator);
      if (!match.ok) return match;
      if (match.value !== undefined) matches.push(match.value);
    }
  }
  finalizeObservedGroups(index);
  endpoints.sort((a, b) => compare(a.endpoint_id, b.endpoint_id));
  matches.sort((a, b) => compare(a.match_id, b.match_id));
  return ok({
    static_endpoints: endpoints,
    observed_groups: index.rows,
    matches,
    summary: summarize(endpoints, index.rows, matches.length),
  });
};
