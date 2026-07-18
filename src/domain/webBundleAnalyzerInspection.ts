import { parse } from "@babel/parser";
import * as t from "@babel/types";

import type { WebPageInspection } from "./browserObservation.js";
import type {
  AnalyzeWebBundleInput,
  WebBundleAnalysis,
} from "./webBundleAnalysis.js";
import {
  calleeName,
  endpointArgument,
  location,
  locationFields,
  objectString,
  objectValue,
  propertyName,
  resolveSpecifier,
  sanitizeCandidate,
  stringArgument,
} from "./webBundleAnalyzerAst.js";

type BundleObservations = WebBundleAnalysis["observations"];
type ChunkEdge = BundleObservations["chunks"]["edges"][number];
type Finding = BundleObservations["routes"][number];
type WebMcpDeclaration = BundleObservations["webmcp_declarations"][number];
type Inference = WebBundleAnalysis["inferences"][number];
type BrowserScript = WebPageInspection["scripts"]["items"][number];
type IncludedSource = Extract<BrowserScript["source"], { included: true }>;
export type IncludedScript = Omit<BrowserScript, "source"> & {
  readonly source: IncludedSource;
};

export interface AnalysisAccumulator {
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

export const analyzeScript = (
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
    addEdge({
      script,
      specifier: node.source.value,
      kind: "static_import",
      node,
      accumulator,
      maximumFindings,
    });
  else if (t.isExportNamedDeclaration(node) && node.source != null)
    addEdge({
      script,
      specifier: node.source.value,
      kind: "static_import",
      node,
      accumulator,
      maximumFindings,
    });
  else if (t.isImportExpression(node) && t.isStringLiteral(node.source))
    addEdge({
      script,
      specifier: node.source.value,
      kind: "dynamic_import",
      node,
      accumulator,
      maximumFindings,
    });
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
    addEdge({
      script,
      specifier: first,
      kind: "require",
      node,
      accumulator,
      maximumFindings,
    });
  if (
    (name === "importScripts" || name.endsWith(".importScripts")) &&
    first !== undefined
  )
    addEdge({
      script,
      specifier: first,
      kind: "worker_import",
      node,
      accumulator,
      maximumFindings,
    });
  if (
    routeCallNames.some(
      (candidate) => name === candidate || name.endsWith(`.${candidate}`),
    )
  ) {
    if (first !== undefined)
      addFinding({
        collection: accumulator.routes,
        script,
        rawValue: first,
        mechanism: `call:${name}`,
        node,
        accumulator,
        maximumFindings,
      });
    addRouteFrameworkInference({
      script,
      name,
      node,
      accumulator,
      maximumFindings,
    });
  }
  const endpoint = endpointArgument(name, node.arguments);
  if (endpoint !== undefined)
    addFinding({
      collection: accumulator.endpoints,
      script,
      rawValue: endpoint,
      mechanism: `call:${name}`,
      node,
      accumulator,
      maximumFindings,
    });
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
    addFinding({
      collection: accumulator.routes,
      script,
      rawValue: node.value.value,
      mechanism: `property:${key}`,
      node,
      accumulator,
      maximumFindings,
    });
};

interface AddEdgeContext {
  readonly script: IncludedScript;
  readonly specifier: string;
  readonly kind: ChunkEdge["kind"];
  readonly node: t.Node;
  readonly accumulator: AnalysisAccumulator;
  readonly maximumFindings: number;
}

const addEdge = (context: AddEdgeContext): void => {
  const bounded = context.specifier.slice(0, 4_096);
  const key = `edge\0${context.script.script_key}\0${context.kind}\0${bounded}`;
  addBounded(context.accumulator, key, context.maximumFindings, () =>
    context.accumulator.edges.push({
      from_script_key: context.script.script_key,
      kind: context.kind,
      specifier: bounded,
      resolved_url: resolveSpecifier(bounded, context.script.url),
      location: location(context.script.script_key, context.node),
    }),
  );
};

interface AddFindingContext {
  readonly collection: Finding[];
  readonly script: IncludedScript;
  readonly rawValue: string;
  readonly mechanism: string;
  readonly node: t.Node;
  readonly accumulator: AnalysisAccumulator;
  readonly maximumFindings: number;
}

const addFinding = (context: AddFindingContext): void => {
  const value = sanitizeCandidate(context.rawValue);
  const key = `finding\0${context.mechanism}\0${context.script.script_key}\0${value}`;
  addBounded(context.accumulator, key, context.maximumFindings, () =>
    context.collection.push({
      value,
      mechanism: context.mechanism,
      location: location(context.script.script_key, context.node),
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

interface RouteFrameworkContext {
  readonly script: IncludedScript;
  readonly name: string;
  readonly node: t.Node;
  readonly accumulator: AnalysisAccumulator;
  readonly maximumFindings: number;
}

const addRouteFrameworkInference = (context: RouteFrameworkContext): void => {
  const value =
    context.name.endsWith("useRoutes") ||
    context.name.endsWith("createBrowserRouter")
      ? "React Router-compatible route API"
      : "Generic route registration API";
  const key = `route-framework\0${context.script.script_key}\0${value}`;
  addBounded(context.accumulator, key, context.maximumFindings, () =>
    context.accumulator.inferences.push({
      kind: "route_framework",
      value,
      confidence: "medium",
      basis: [
        {
          ...basis(context.script, `call:${context.name}`),
          ...locationFields(context.node),
        },
      ],
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

const basis = (script: IncludedScript, detector: string) => ({
  script_key: script.script_key,
  artifact_sha256: script.source.artifact.sha256,
  line: null,
  column: null,
  detector,
});

export const emptyAccumulator = (): AnalysisAccumulator => ({
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

export const isIncludedScript = (
  script: BrowserScript,
): script is IncludedScript => script.source.included;

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
