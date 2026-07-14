import { parse } from "@babel/parser";
import * as t from "@babel/types";

import type { WebPageInspection } from "./browserObservation.js";
import { sanitizeBrowserUrl } from "./browserObservation.js";
import {
  webBundleAnalysisSchema,
  type AnalyzeWebBundleInput,
  type WebBundleAnalysis,
} from "./webBundleAnalysis.js";

type BundleObservations = WebBundleAnalysis["observations"];
type ChunkEdge = BundleObservations["chunks"]["edges"][number];
type Finding = BundleObservations["routes"][number];
type WebMcpDeclaration = BundleObservations["webmcp_declarations"][number];
type Inference = WebBundleAnalysis["inferences"][number];
type BrowserScript = WebPageInspection["scripts"]["items"][number];
type IncludedSource = Extract<BrowserScript["source"], { included: true }>;
type IncludedScript = Omit<BrowserScript, "source"> & {
  readonly source: IncludedSource;
};

interface AnalysisAccumulator {
  readonly edges: ChunkEdge[];
  readonly routes: Finding[];
  readonly endpoints: Finding[];
  readonly webMcp: WebMcpDeclaration[];
  readonly inferences: Inference[];
  readonly seen: Set<string>;
  visitedNodes: number;
  parsedScripts: number;
  parseFailures: number;
  droppedFindings: number;
  astLimitReached: boolean;
}

/** Analyze captured, explicitly approved JavaScript source without execution. */
export const analyzeCapturedWebBundle = (
  inspection: WebPageInspection,
  input: AnalyzeWebBundleInput,
  sourceMaps: BundleObservations["source_maps"] = {
    status: "not_requested",
    requested: 0,
    processed: 0,
    dropped: 0,
    dropped_script_keys: [],
    items: [],
  },
): WebBundleAnalysis => {
  const accumulator = emptyAccumulator();
  const sourceScripts = inspection.scripts.items.filter(isIncludedScript);
  for (const script of sourceScripts) analyzeScript(script, input, accumulator);
  const unavailable = inspection.scripts.items
    .filter((script) => !script.source.included)
    .map(({ script_key }) => script_key);
  const sourceMapIncomplete =
    sourceMaps.status === "partial" || sourceMaps.status === "unavailable";
  const partial =
    accumulator.parseFailures > 0 ||
    unavailable.length > 0 ||
    sourceMapIncomplete;
  const truncated =
    accumulator.astLimitReached ||
    accumulator.droppedFindings > 0 ||
    sourceMaps.status === "truncated";
  return webBundleAnalysisSchema.parse({
    schema_version: 1,
    capture: {
      target_url: inspection.target.url,
      scripts_observed: inspection.scripts.total,
      scripts_analyzed: sourceScripts.length,
      source_artifacts: sourceScripts.map((script) => {
        if (!script.source.included)
          throw new TypeError("Filtered source changed");
        const { text: _text, ...artifact } = script.source.artifact;
        return { ...artifact, text_available: true };
      }),
    },
    observations: {
      chunks: {
        nodes: sourceScripts.map((script) => {
          if (!script.source.included)
            throw new TypeError("Filtered source changed");
          return {
            script_key: script.script_key,
            url: script.url,
            artifact_sha256: script.source.artifact.sha256,
            bytes: script.source.artifact.bytes,
          };
        }),
        edges: accumulator.edges,
      },
      routes: accumulator.routes,
      endpoints: accumulator.endpoints,
      webmcp_declarations: accumulator.webMcp,
      source_maps: sourceMaps,
    },
    inferences: accumulator.inferences,
    unknowns: [
      ...(unavailable.length === 0
        ? []
        : [
            {
              dimension: "script_source",
              reason: "Source artifact was not captured within approved limits",
              affected_script_keys: unavailable,
            },
          ]),
      ...(accumulator.parseFailures === 0
        ? []
        : [
            {
              dimension: "javascript_ast",
              reason: "One or more source artifacts could not be parsed",
              affected_script_keys: sourceScripts.map(
                ({ script_key }) => script_key,
              ),
            },
          ]),
      ...(sourceMaps.status === "not_requested" ||
      sourceMaps.status === "included"
        ? []
        : [
            {
              dimension: "source_maps",
              reason:
                sourceMaps.status === "truncated"
                  ? "Source-map evidence was truncated by approved limits"
                  : "One or more requested source maps were unavailable or incomplete",
              affected_script_keys: [
                ...new Set([
                  ...sourceMaps.items
                    .filter(({ status }) => status !== "included")
                    .map(({ script_key }) => script_key),
                  ...sourceMaps.dropped_script_keys,
                ]),
              ].sort(),
            },
          ]),
    ],
    completeness: {
      status: truncated
        ? "truncated"
        : partial
          ? "partial"
          : "complete_within_limits",
      parsed_scripts: accumulator.parsedScripts,
      parse_failures: accumulator.parseFailures,
      visited_ast_nodes: accumulator.visitedNodes,
      dropped_findings: accumulator.droppedFindings,
    },
    limitations: [
      "Static bundle findings are observations or bounded inferences; REA does not execute captured JavaScript.",
      "String-built routes and endpoints, encrypted configuration, and server-side behavior may remain unknown.",
      "Page-declared WebMCP metadata is untrusted and is never registered or invoked as an REA tool.",
    ],
  });
};

const analyzeScript = (
  script: IncludedScript,
  input: AnalyzeWebBundleInput,
  accumulator: AnalysisAccumulator,
): void => {
  let file: ReturnType<typeof parse>;
  try {
    file = parse(script.source.artifact.text, {
      sourceType: "unambiguous",
      errorRecovery: true,
      plugins: ["jsx", "typescript"],
    });
  } catch {
    accumulator.parseFailures += 1;
    return;
  }
  accumulator.parsedScripts += 1;
  detectVendorFingerprints(
    script,
    accumulator,
    input.analysis_limits.max_findings,
  );
  t.traverseFast(file, (node) => {
    accumulator.visitedNodes += 1;
    if (accumulator.visitedNodes > input.analysis_limits.max_ast_nodes) {
      accumulator.astLimitReached = true;
      return t.traverseFast.stop;
    }
    inspectNode(script, node, accumulator, input.analysis_limits.max_findings);
    return undefined;
  });
};

const inspectNode = (
  script: IncludedScript,
  node: t.Node,
  accumulator: AnalysisAccumulator,
  maximumFindings: number,
): void => {
  if (
    (t.isImportDeclaration(node) || t.isExportAllDeclaration(node)) &&
    node.source !== undefined
  )
    addEdge(
      script,
      node.source.value,
      "static_import",
      node,
      accumulator,
      maximumFindings,
    );
  else if (t.isExportNamedDeclaration(node) && node.source != null)
    addEdge(
      script,
      node.source.value,
      "static_import",
      node,
      accumulator,
      maximumFindings,
    );
  else if (t.isImportExpression(node) && t.isStringLiteral(node.source))
    addEdge(
      script,
      node.source.value,
      "dynamic_import",
      node,
      accumulator,
      maximumFindings,
    );
  if (t.isObjectProperty(node))
    inspectRouteProperty(script, node, accumulator, maximumFindings);
  if (t.isCallExpression(node) || t.isNewExpression(node))
    inspectCall(script, node, accumulator, maximumFindings);
};

const inspectCall = (
  script: IncludedScript,
  node: t.CallExpression | t.NewExpression,
  accumulator: AnalysisAccumulator,
  maximumFindings: number,
): void => {
  const name = calleeName(node.callee);
  const first = stringArgument(node.arguments[0]);
  if ((name === "require" || name.endsWith(".require")) && first !== undefined)
    addEdge(script, first, "require", node, accumulator, maximumFindings);
  if (
    (name === "importScripts" || name.endsWith(".importScripts")) &&
    first !== undefined
  )
    addEdge(script, first, "worker_import", node, accumulator, maximumFindings);
  if (
    routeCallNames.some(
      (candidate) => name === candidate || name.endsWith(`.${candidate}`),
    )
  ) {
    if (first !== undefined)
      addFinding(
        accumulator.routes,
        script,
        first,
        `call:${name}`,
        node,
        accumulator,
        maximumFindings,
      );
    addRouteFrameworkInference(
      script,
      name,
      node,
      accumulator,
      maximumFindings,
    );
  }
  const endpoint = endpointArgument(name, node.arguments);
  if (endpoint !== undefined)
    addFinding(
      accumulator.endpoints,
      script,
      endpoint,
      `call:${name}`,
      node,
      accumulator,
      maximumFindings,
    );
  if (
    name.endsWith("modelContext.registerTool") ||
    name === "modelContext.registerTool"
  )
    addWebMcpDeclaration(script, node, accumulator, maximumFindings);
};

const inspectRouteProperty = (
  script: IncludedScript,
  node: t.ObjectProperty,
  accumulator: AnalysisAccumulator,
  maximumFindings: number,
): void => {
  const key = propertyName(node.key);
  if ((key === "path" || key === "route") && t.isStringLiteral(node.value))
    addFinding(
      accumulator.routes,
      script,
      node.value.value,
      `property:${key}`,
      node,
      accumulator,
      maximumFindings,
    );
};

const addEdge = (
  script: IncludedScript,
  specifier: string,
  kind: ChunkEdge["kind"],
  node: t.Node,
  accumulator: AnalysisAccumulator,
  maximumFindings: number,
): void => {
  const bounded = specifier.slice(0, 4_096);
  const key = `edge\0${script.script_key}\0${kind}\0${bounded}`;
  addBounded(accumulator, key, maximumFindings, () =>
    accumulator.edges.push({
      from_script_key: script.script_key,
      kind,
      specifier: bounded,
      resolved_url: resolveSpecifier(bounded, script.url),
      location: location(script.script_key, node),
    }),
  );
};

const addFinding = (
  collection: Finding[],
  script: IncludedScript,
  rawValue: string,
  mechanism: string,
  node: t.Node,
  accumulator: AnalysisAccumulator,
  maximumFindings: number,
): void => {
  const value = sanitizeCandidate(rawValue);
  const key = `finding\0${mechanism}\0${script.script_key}\0${value}`;
  addBounded(accumulator, key, maximumFindings, () =>
    collection.push({
      value,
      mechanism,
      location: location(script.script_key, node),
    }),
  );
};

const addWebMcpDeclaration = (
  script: IncludedScript,
  node: t.CallExpression | t.NewExpression,
  accumulator: AnalysisAccumulator,
  maximumFindings: number,
): void => {
  const declaration = node.arguments[0];
  if (!t.isObjectExpression(declaration)) return;
  const name = objectString(declaration, "name");
  const description = objectString(declaration, "description");
  const schema =
    objectValue(declaration, "inputSchema") ??
    objectValue(declaration, "input_schema");
  const declaredProperties = t.isObjectExpression(schema)
    ? objectValue(schema, "properties")
    : undefined;
  const propertyObject = t.isObjectExpression(declaredProperties)
    ? declaredProperties
    : schema;
  const schemaPropertyNames = t.isObjectExpression(propertyObject)
    ? propertyObject.properties.flatMap((property) =>
        t.isObjectProperty(property)
          ? [propertyName(property.key)].filter(Boolean)
          : [],
      )
    : [];
  const key = `webmcp\0${script.script_key}\0${name ?? ""}\0${schemaPropertyNames.join("\0")}`;
  addBounded(accumulator, key, maximumFindings, () =>
    accumulator.webMcp.push({
      name: name?.slice(0, 256) ?? null,
      description: description?.slice(0, 2_048) ?? null,
      schema_property_names: [...new Set(schemaPropertyNames)]
        .sort()
        .slice(0, 256),
      trust: "page-declared-untrusted",
      location: location(script.script_key, node),
    }),
  );
};

const detectVendorFingerprints = (
  script: IncludedScript,
  accumulator: AnalysisAccumulator,
  maximumFindings: number,
): void => {
  const text = script.source.artifact.text;
  for (const detector of vendorDetectors) {
    if (!detector.patterns.some((pattern) => text.includes(pattern))) continue;
    const key = `vendor\0${script.script_key}\0${detector.value}`;
    addBounded(accumulator, key, maximumFindings, () =>
      accumulator.inferences.push({
        kind: detector.kind,
        value: detector.value,
        confidence: detector.confidence,
        basis: [basis(script, detector.detector)],
      }),
    );
  }
};

const addRouteFrameworkInference = (
  script: IncludedScript,
  name: string,
  node: t.Node,
  accumulator: AnalysisAccumulator,
  maximumFindings: number,
): void => {
  const value =
    name.endsWith("useRoutes") || name.endsWith("createBrowserRouter")
      ? "React Router-compatible route API"
      : "Generic route registration API";
  const key = `route-framework\0${script.script_key}\0${value}`;
  addBounded(accumulator, key, maximumFindings, () =>
    accumulator.inferences.push({
      kind: "route_framework",
      value,
      confidence: "medium",
      basis: [{ ...basis(script, `call:${name}`), ...locationFields(node) }],
    }),
  );
};

const addBounded = (
  accumulator: AnalysisAccumulator,
  key: string,
  maximum: number,
  add: () => void,
): void => {
  if (accumulator.seen.has(key)) return;
  const findings =
    accumulator.edges.length +
    accumulator.routes.length +
    accumulator.endpoints.length +
    accumulator.webMcp.length +
    accumulator.inferences.length;
  if (findings >= maximum) {
    accumulator.droppedFindings += 1;
    return;
  }
  accumulator.seen.add(key);
  add();
};

const endpointArgument = (
  name: string,
  args: readonly (
    | t.Expression
    | t.SpreadElement
    | t.JSXNamespacedName
    | t.ArgumentPlaceholder
  )[],
): string | undefined => {
  if (name === "fetch" || name.endsWith(".fetch") || name === "WebSocket")
    return stringArgument(args[0]);
  if (name.endsWith(".open") && stringArgument(args[1]) !== undefined)
    return stringArgument(args[1]);
  if (
    ["get", "post", "put", "patch", "delete", "request"].some(
      (method) => name === method || name.endsWith(`.${method}`),
    )
  )
    return stringArgument(args[0]);
  return undefined;
};

const calleeName = (callee: t.Node): string => {
  if (t.isIdentifier(callee)) return callee.name;
  if (t.isImport(callee)) return "import";
  if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
    const object = t.isExpression(callee.object)
      ? calleeName(callee.object)
      : "";
    const property = propertyName(callee.property);
    return object === "" ? property : `${object}.${property}`;
  }
  return "";
};

const stringArgument = (
  value: t.Node | null | undefined,
): string | undefined => (t.isStringLiteral(value) ? value.value : undefined);

const propertyName = (value: t.Node): string => {
  if (t.isIdentifier(value)) return value.name;
  if (t.isStringLiteral(value)) return value.value;
  return "";
};

const objectValue = (
  object: t.ObjectExpression,
  name: string,
): t.ObjectProperty["value"] | undefined => {
  for (const property of object.properties)
    if (t.isObjectProperty(property) && propertyName(property.key) === name)
      return property.value;
  return undefined;
};

const objectString = (
  object: t.ObjectExpression,
  name: string,
): string | undefined => {
  const value = objectValue(object, name);
  return t.isStringLiteral(value) ? value.value : undefined;
};

const resolveSpecifier = (specifier: string, base: string): string | null => {
  try {
    const resolved = new URL(specifier, base);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:")
      return null;
    return sanitizeBrowserUrl(resolved.href).url;
  } catch {
    return null;
  }
};

const sanitizeCandidate = (value: string): string => {
  const bounded = value.slice(0, 4_096);
  try {
    const parsed = new URL(bounded, "https://rea.invalid");
    const sanitized = sanitizeBrowserUrl(parsed.href).url;
    return parsed.origin === "https://rea.invalid"
      ? sanitized.replace("https://rea.invalid", "")
      : sanitized;
  } catch {
    return bounded.split("#", 1)[0]?.split("?", 1)[0] ?? "";
  }
};

const location = (scriptKey: string, node: t.Node) => ({
  script_key: scriptKey,
  ...locationFields(node),
});

const locationFields = (node: t.Node) => ({
  line: node.loc?.start.line ?? null,
  column: node.loc?.start.column ?? null,
});

const basis = (script: IncludedScript, detector: string) => ({
  script_key: script.script_key,
  artifact_sha256: script.source.artifact.sha256,
  line: null,
  column: null,
  detector,
});

const emptyAccumulator = (): AnalysisAccumulator => ({
  edges: [],
  routes: [],
  endpoints: [],
  webMcp: [],
  inferences: [],
  seen: new Set(),
  visitedNodes: 0,
  parsedScripts: 0,
  parseFailures: 0,
  droppedFindings: 0,
  astLimitReached: false,
});

const isIncludedScript = (script: BrowserScript): script is IncludedScript =>
  script.source.included;

const routeCallNames = [
  "route",
  "addRoute",
  "useRoutes",
  "createBrowserRouter",
  "createHashRouter",
] as const;

const vendorDetectors: readonly {
  readonly value: string;
  readonly detector: string;
  readonly patterns: readonly string[];
  readonly confidence: Inference["confidence"];
  readonly kind: Inference["kind"];
}[] = [
  {
    value: "webpack",
    detector: "webpack-runtime",
    patterns: ["__webpack_require__"],
    confidence: "high",
    kind: "bundle_runtime",
  },
  {
    value: "Vite",
    detector: "vite-runtime",
    patterns: ["__vite__", "import.meta.hot"],
    confidence: "medium",
    kind: "bundle_runtime",
  },
  {
    value: "React",
    detector: "react-runtime",
    patterns: ["__REACT_DEVTOOLS_GLOBAL_HOOK__", "React.createElement"],
    confidence: "medium",
    kind: "vendor_fingerprint",
  },
  {
    value: "Vue",
    detector: "vue-runtime",
    patterns: ["__VUE__", "createApp("],
    confidence: "medium",
    kind: "vendor_fingerprint",
  },
  {
    value: "Next.js",
    detector: "next-runtime",
    patterns: ["__NEXT_DATA__", "/_next/"],
    confidence: "high",
    kind: "vendor_fingerprint",
  },
  {
    value: "Angular",
    detector: "angular-runtime",
    patterns: ["ɵɵdefineComponent"],
    confidence: "high",
    kind: "vendor_fingerprint",
  },
  {
    value: "Svelte",
    detector: "svelte-runtime",
    patterns: ["svelte/internal"],
    confidence: "medium",
    kind: "vendor_fingerprint",
  },
];
