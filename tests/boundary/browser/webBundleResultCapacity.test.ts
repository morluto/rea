import { expect, it } from "vitest";
import type { WebBundleAnalysis } from "../../../src/domain/webBundleAnalysis.js";
import { buildCapturedWebBundleAnalysis } from "../../../src/domain/webBundleAnalyzerResult.js";
import { isIncludedScript } from "../../../src/domain/webBundleAnalyzerState.js";
import type { WebBundleScriptAnalysis } from "../../../src/domain/webBundleScriptAnalysis.js";
import { createWebPageInspection } from "../../support/browser/webPageInspection.js";

type WideCollection =
  | "edges"
  | "routes"
  | "endpoints"
  | "webmcp_declarations"
  | "inferences";

const EXPECTED_BOUNDS: Record<WideCollection, readonly [string, string]> = {
  edges: ["./first.js", "./last.js"],
  routes: ["/first", "/last"],
  endpoints: ["/api/first", "/api/last"],
  webmcp_declarations: ["firstTool", "lastTool"],
  inferences: ["/api/first", "/api/last"],
};

const fillWide = <T>(count: number, first: T, middle: T, last: T): T[] => {
  const items = new Array<T>(count).fill(middle);
  items[0] = first;
  items[count - 1] = last;
  return items;
};

const buildWideScriptResult = (
  collection: WideCollection,
  scriptKey: string,
  sha256: string,
  count: number,
): WebBundleScriptAnalysis => {
  const location = { script_key: scriptKey, line: 1, column: 0 };
  const makeEdge = (specifier: string) => ({
    from_script_key: scriptKey,
    kind: "static_import" as const,
    specifier,
    resolved_url: null,
    location,
  });
  const makeFinding = (value: string, mechanism: string) => ({
    value,
    mechanism,
    location,
  });
  const makeWebMcp = (name: string) => ({
    name,
    description: null,
    schema_property_names: [],
    trust: "page-declared-untrusted" as const,
    location,
  });
  const makeInference = (value: string) => ({
    kind: "endpoint_candidate" as const,
    value,
    confidence: "low" as const,
    basis: [
      {
        script_key: scriptKey,
        artifact_sha256: sha256,
        line: 1,
        column: 0,
        detector: "test",
      },
    ],
  });
  return {
    status: "analyzed",
    script_key: scriptKey,
    parse_status: "parsed",
    visited_ast_nodes: count,
    widened_return_references: false,
    observations: {
      edges:
        collection === "edges"
          ? fillWide(
              count,
              makeEdge("./first.js"),
              makeEdge("./mid.js"),
              makeEdge("./last.js"),
            )
          : [],
      routes:
        collection === "routes"
          ? fillWide(
              count,
              makeFinding("/first", "router"),
              makeFinding("/mid", "router"),
              makeFinding("/last", "router"),
            )
          : [],
      endpoints:
        collection === "endpoints"
          ? fillWide(
              count,
              makeFinding("/api/first", "fetch"),
              makeFinding("/api/mid", "fetch"),
              makeFinding("/api/last", "fetch"),
            )
          : [],
      webmcp_declarations:
        collection === "webmcp_declarations"
          ? fillWide(
              count,
              makeWebMcp("firstTool"),
              makeWebMcp("midTool"),
              makeWebMcp("lastTool"),
            )
          : [],
    },
    inferences:
      collection === "inferences"
        ? fillWide(
            count,
            makeInference("/api/first"),
            makeInference("/api/mid"),
            makeInference("/api/last"),
          )
        : [],
  };
};

const summarizeMerged = (
  result: WebBundleAnalysis,
  collection: WideCollection,
): readonly [number, string | null | undefined, string | null | undefined] => {
  switch (collection) {
    case "edges": {
      const items = result.observations.chunks.edges;
      return [items.length, items[0]?.specifier, items.at(-1)?.specifier];
    }
    case "routes": {
      const items = result.observations.routes;
      return [items.length, items[0]?.value, items.at(-1)?.value];
    }
    case "endpoints": {
      const items = result.observations.endpoints;
      return [items.length, items[0]?.value, items.at(-1)?.value];
    }
    case "webmcp_declarations": {
      const items = result.observations.webmcp_declarations;
      return [items.length, items[0]?.name, items.at(-1)?.name];
    }
    case "inferences": {
      const items = result.inferences;
      return [items.length, items[0]?.value, items.at(-1)?.value];
    }
  }
};

// Forked tests share the CLI/MCP main-thread stack, unlike domain threads.
it.each([
  "edges",
  "routes",
  "endpoints",
  "webmcp_declarations",
  "inferences",
] as const)(
  "merges wide %s script results without overflowing call arguments",
  (collection) => {
    const count = 130_000;
    const scriptKey = `scr_${"a".repeat(64)}`;
    const captured = createWebPageInspection([
      {
        source: "export {};\n",
        scriptKey,
        url: "https://app.example.test/app.js",
        origin: "https://app.example.test",
        cdpHash: "hash-0",
      },
    ]);
    const script = captured.scripts.items.find(isIncludedScript);
    if (script === undefined)
      throw new Error("Missing included script fixture");

    const result = buildCapturedWebBundleAnalysis(
      captured,
      { status: "not_requested", requested: 0, processed: 0, items: [] },
      [
        buildWideScriptResult(
          collection,
          scriptKey,
          script.source.artifact.sha256,
          count,
        ),
      ],
    );

    const [length, first, last] = summarizeMerged(result, collection);
    const [expectedFirst, expectedLast] = EXPECTED_BOUNDS[collection];
    expect(length).toBe(count);
    expect(first).toBe(expectedFirst);
    expect(last).toBe(expectedLast);
  },
);
