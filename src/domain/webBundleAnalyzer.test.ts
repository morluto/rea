import {
  projectAnalysisView,
  analysisViewRequestSchema,
} from "./analysisView/analysisView.js";
import { describe, expect, it } from "vitest";
import { createWebPageInspection } from "../../tests/support/browser/webPageInspection.js";

import { analyzeJavaScriptStaticSource } from "./javascript/javascriptStaticAnalysis.js";
import { analyzeCapturedWebScript } from "./webBundleAnalyzer.js";
import { analyzeWebBundleFixture } from "../../tests/support/browser/analyzeWebBundleFixture.js";
import { buildCapturedWebBundleAnalysis } from "./webBundleAnalyzerResult.js";
import { webBundleAnalysisSchema } from "./webBundleAnalysis.js";
import { isIncludedScript } from "./webBundleAnalyzerState.js";
import { webBundleScriptAnalysisSchema } from "./webBundleScriptAnalysis.js";
import { createWebTextArtifact } from "./webContentArtifact.js";

const origin = "https://app.example.test";

it("retains standalone GraphQL Source operations in captured scripts", () => {
  const result = analyzeWebBundleFixture(
    inspection(`
    const source = {
      body: "query GetUser { user { id } }",
      locationOffset: { line: 1, column: 1 },
    };
  `),
  );
  expect(result.observations.endpoints).toEqual([
    expect.objectContaining({ value: "GetUser", mechanism: "graphql:query" }),
  ]);
});

it.each([
  {
    kind: "recovered",
    source: "function legacy(a, a) { return a; } fetch('/partial');",
    parsed: 2,
    failures: 0,
    reason: "recovered",
    endpoints: ["/partial", "/complete"],
  },
  {
    kind: "failed",
    source: "function broken( {",
    parsed: 1,
    failures: 1,
    reason: "could not be parsed",
    endpoints: ["/complete"],
  },
])(
  "attributes $kind parse uncertainty only to its affected source",
  ({ source, parsed, failures, reason, endpoints }) => {
    const captured = inspection(source);
    const good = inspection("fetch('/complete');").scripts.items[0];
    if (good === undefined) throw new Error("Missing valid script fixture");
    captured.scripts.items.push({ ...good, script_key: "valid-script" });
    captured.scripts.total += 1;
    const result = analyzeWebBundleFixture(captured);
    expect(result.completeness).toMatchObject({
      status: "partial",
      parsed_scripts: parsed,
      parse_failures: failures,
    });
    expect(result.unknowns).toContainEqual({
      dimension: "javascript_ast",
      reason: expect.stringContaining(reason),
      affected_script_keys: [captured.scripts.items[0]?.script_key],
    });
    expect(result.observations.endpoints.map(({ value }) => value)).toEqual(
      endpoints,
    );
  },
);

it.each([
  [
    "const records = new Map(); const alias = records; alias.get('/accounts');",
    false,
  ],
  ["new Map().delete('/accounts');", false],
  [
    "const records = new Map(); records.get('/accounts'); records.delete('/accounts');",
    false,
  ],
  [
    "const records = new Map(); records.get = fetch; records.get('/accounts');",
    true,
  ],
  [
    "Object.getPrototypeOf = () => Map.prototype; Object.getPrototypeOf({}).get = fetch; new Map().get('/accounts');",
    true,
  ],
  ["client.get('/accounts');", true],
  ["eval('Map.prototype.get = fetch'); new Map().get('/accounts');", true],
] as const)(
  "shares Map receiver certainty with application analysis: %s",
  (source, candidate) => {
    const input = source + " fetch('/network');";
    const result = analyzeWebBundleFixture(inspection(input));
    expect(result.observations.endpoints.map(({ value }) => value)).toEqual([
      "/network",
    ]);
    expect(
      result.inferences
        .filter(({ kind }) => kind === "endpoint_candidate")
        .map(({ value }) => value),
    ).toEqual(candidate ? ["/accounts"] : []);
    const staticResult = analyzeJavaScriptStaticSource(input);
    expect(
      staticResult.endpoints
        .map(({ value, interpretation }) => [value, interpretation ?? null])
        .sort(),
    ).toEqual(
      candidate
        ? [
            ["/accounts", "candidate"],
            ["/network", null],
          ]
        : [["/network", null]],
    );
  },
);

it("discloses widened returned-reference effects only for the affected script", () => {
  const captured = inspection(`
    function expose() { return Map.prototype; }
    let cursor = { target: expose };
    function walk(flag) {
      while (flag) cursor = cursor.next;
      patch(cursor.target());
    }
    new Map().get('/candidate');
    fetch('/preserved');
  `);
  const independent = inspection(
    "new Map().get('/intrinsic'); fetch('/independent');",
  ).scripts.items[0];
  if (independent === undefined) throw new Error("Missing independent script");
  captured.scripts.items.push({ ...independent, script_key: "independent" });
  captured.scripts.total += 1;
  const result = analyzeWebBundleFixture(captured);
  expect(result.completeness).toMatchObject({
    status: "partial",
    parsed_scripts: 2,
    parse_failures: 0,
  });
  expect(result.unknowns).toContainEqual({
    dimension: "javascript_ast",
    reason: expect.stringContaining("returned-reference projections"),
    affected_script_keys: [captured.scripts.items[0]?.script_key],
  });
  expect(result.observations.endpoints.map(({ value }) => value)).toEqual([
    "/preserved",
    "/independent",
  ]);
  expect(
    result.inferences
      .filter(({ kind }) => kind === "endpoint_candidate")
      .map(({ value }) => value),
  ).toEqual(["/candidate"]);
});

it.each([
  {
    label: "inline declaration and schema spreads",
    source: `document.modelContext.registerTool({
      ...{
        name: "spread-tool",
        description: "Copied from a literal",
        inputSchema: {
          ...{
            type: "object",
            properties: { query: { type: "string" } }
          }
        }
      }
    });`,
    name: "spread-tool",
    description: "Copied from a literal",
    properties: ["query"],
    coverage: "complete",
  },
  {
    label: "unrelated trailing literal spread",
    source: `document.modelContext.registerTool({
      name: "direct-tool",
      description: "Explicit metadata",
      inputSchema: { properties: { query: { type: "string" } } },
      ...{ timeout: 5 }
    });`,
    name: "direct-tool",
    description: "Explicit metadata",
    properties: ["query"],
    coverage: "complete",
  },
  {
    label: "null spread after explicit metadata",
    source: `document.modelContext.registerTool({
      name: "null-safe-tool",
      description: "Null spread is inert",
      inputSchema: { properties: { query: { type: "string" } } },
      ...null
    });`,
    name: "null-safe-tool",
    description: "Null spread is inert",
    properties: ["query"],
    coverage: "complete",
  },
  {
    label: "snake-case schema property from a spread",
    source: `document.modelContext.registerTool({
      ...{
        name: "snake-tool",
        description: "Snake-case schema",
        input_schema: { properties: { item_id: { type: "string" } } }
      }
    });`,
    name: "snake-tool",
    description: "Snake-case schema",
    properties: ["item_id"],
    coverage: "complete",
  },
])(
  "preserves WebMCP facts through $label",
  ({ source, name, description, properties, coverage }) => {
    const result = analyzeWebBundleFixture(inspection(source));

    expect(result.observations.webmcp_declarations).toEqual([
      expect.objectContaining({
        name,
        description,
        schema_property_names: properties,
        schema_property_names_coverage: coverage,
        trust: "page-declared-untrusted",
      }),
    ]);
    expect(result.completeness.status).toBe("complete");
  },
);

it.each([
  {
    label: "unknown spread after explicit facts",
    source: `document.modelContext.registerTool({
      name: "possibly-overridden",
      description: "Possibly overridden",
      inputSchema: { properties: { query: { type: "string" } } },
      ...dynamicOptions
    });`,
    name: null,
    description: null,
    properties: [],
    coverage: "unknown",
  },
  {
    label: "explicit facts after an unknown spread",
    source: `document.modelContext.registerTool({
      ...dynamicOptions,
      name: "known-after-spread",
      description: "Explicitly restored",
      inputSchema: { properties: { query: { type: "string" } } }
    });`,
    name: "known-after-spread",
    description: "Explicitly restored",
    properties: ["query"],
    coverage: "complete",
  },
])(
  "preserves rightmost uncertainty for $label",
  ({ source, name, description, properties, coverage }) => {
    const result = analyzeWebBundleFixture(inspection(source));

    expect(result.observations.webmcp_declarations).toEqual([
      expect.objectContaining({
        name,
        description,
        schema_property_names: properties,
        schema_property_names_coverage: coverage,
        trust: "page-declared-untrusted",
      }),
    ]);
    expect(result.completeness.status).toBe("complete");
  },
);

it.each([
  {
    label: "an unknown camel-case schema override",
    source: `document.modelContext.registerTool({
      ...dynamicOptions,
      inputSchema: { properties: { camel: {} } },
      ...anotherDynamicOptions,
      input_schema: { properties: { snake: {} } },
      name: "tool",
      description: "Explicit metadata"
    });`,
    name: "tool",
    properties: [],
    coverage: "unknown",
  },
  {
    label: "an explicit null camel-case schema",
    source: `document.modelContext.registerTool({
      name: "null-alias",
      description: "Fallback applies",
      inputSchema: null,
      input_schema: { properties: { snake: {} } }
    });`,
    name: "null-alias",
    properties: ["snake"],
    coverage: "complete",
  },
  {
    label: "literal property spreads",
    source: `document.modelContext.registerTool({
      name: "spread-properties",
      inputSchema: { properties: { ...{ query: {} }, direct: {} } }
    });`,
    name: "spread-properties",
    properties: ["direct", "query"],
    coverage: "complete",
  },
  {
    label: "prototype setters are not schema properties",
    source: `document.modelContext.registerTool({
      name: "prototype-properties",
      inputSchema: { properties: { __proto__: { hidden: {} }, direct: {}, ["__proto__"]: {} } }
    });`,
    name: "prototype-properties",
    properties: ["__proto__", "direct"],
    coverage: "complete",
  },
  {
    label: "own schema properties before a prototype setter",
    source: `document.modelContext.registerTool({
      name: "own-before-prototype",
      inputSchema: { properties: { known: {} }, __proto__: { properties: { inherited: {} } } }
    });`,
    name: "own-before-prototype",
    properties: ["known"],
    coverage: "complete",
  },
  {
    label: "own schema properties after a prototype setter",
    source: `document.modelContext.registerTool({
      name: "own-after-prototype",
      inputSchema: { __proto__: { properties: { inherited: {} } }, properties: { known: {} } }
    });`,
    name: "own-after-prototype",
    properties: ["known"],
    coverage: "complete",
  },
  {
    label: "an unresolved property spread",
    source: `document.modelContext.registerTool({
      name: "unknown-properties",
      inputSchema: { properties: { ...dynamicProperties, direct: {} } }
    });`,
    name: "unknown-properties",
    properties: ["direct"],
    coverage: "partial",
  },
  {
    label: "an unresolved computed property key",
    source: `document.modelContext.registerTool({
      name: "computed-properties",
      inputSchema: { properties: { [propertyName]: {}, direct: {} } }
    });`,
    name: "computed-properties",
    properties: ["direct"],
    coverage: "partial",
  },
])(
  "preserves WebMCP schema ownership for $label",
  ({ source, name, properties, coverage }) => {
    const result = analyzeWebBundleFixture(inspection(source));

    expect(result.observations.webmcp_declarations).toEqual([
      expect.objectContaining({
        name,
        schema_property_names: properties,
        schema_property_names_coverage: coverage,
        trust: "page-declared-untrusted",
      }),
    ]);
  },
);

describe("web bundle analyzer", () => {
  it("extracts graph, route, endpoint, vendor, and WebMCP evidence", () => {
    const source = `
      import { createApp } from "./chunk.js?token=secret";
      const lazy = import("./lazy.js");
      const routes = [{ path: "/users/:id?token=secret" }];
      fetch("/api/users?authorization=secret");
      document.modelContext.registerTool({
        name: "lookup-user",
        description: "Untrusted page declaration",
        inputSchema: {
          type: "object",
          properties: {
            userId: { type: "string" },
            verbose: { type: "boolean" }
          }
        }
      });
      const __webpack_require__ = () => createApp(routes, lazy);
    `;
    const result = analyzeWebBundleFixture(inspection(source));

    expect(result.observations.chunks.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "static_import",
          specifier: "./chunk.js?token=secret",
          resolved_url: `${origin}/assets/chunk.js?token=secret`,
        }),
        expect.objectContaining({
          kind: "dynamic_import",
          specifier: "./lazy.js",
        }),
      ]),
    );
    expect(result.observations.routes).toEqual([
      expect.objectContaining({ value: "/users/:id?token=secret" }),
    ]);
    expect(result.observations.endpoints).toEqual([
      expect.objectContaining({
        value: "/api/users?authorization=secret",
      }),
    ]);
    expect(result.observations.webmcp_declarations).toEqual([
      expect.objectContaining({
        name: "lookup-user",
        trust: "page-declared-untrusted",
        schema_property_names: ["userId", "verbose"],
        schema_property_names_coverage: "complete",
      }),
    ]);
    expect(result.inferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "webpack", confidence: "high" }),
        expect.objectContaining({ value: "Vue" }),
      ]),
    );
    expect(JSON.stringify(result)).toContain("authorization=secret");
    expect(result.completeness.status).toBe("complete");
  });

  it("reports parser gaps without imposing a finding cap", () => {
    const malformed = inspection("function broken( {");
    const failed = analyzeWebBundleFixture(malformed);
    expect(failed.completeness).toMatchObject({
      status: "partial",
      parse_failures: 1,
    });
    expect(failed.unknowns[0]?.dimension).toBe("javascript_ast");

    const analyzed = analyzeWebBundleFixture(
      inspection("fetch('/one'); fetch('/two'); fetch('/three');"),
    );
    expect(analyzed.observations.endpoints).toHaveLength(3);
    expect(analyzed.completeness.status).toBe("complete");
  });

  it("analyzes AST nodes after the former fixed node ceiling", () => {
    const source = `${";".repeat(250_001)}fetch('/last');`;
    const result = analyzeWebBundleFixture(inspection(source));

    expect(result.observations.endpoints).toContainEqual(
      expect.objectContaining({ value: "/last" }),
    );
    expect(result.completeness.visited_ast_nodes).toBeGreaterThan(250_000);
    expect(result.completeness.status).toBe("complete");
  });

  it("retains complete long chunk and WebMCP declaration text", () => {
    const specifier = `./${"chunk".repeat(1_000)}.js`;
    const name = "tool".repeat(100);
    const description = "untrusted declaration ".repeat(150);
    const propertyName = "property".repeat(100);
    const result = analyzeWebBundleFixture(
      inspection(`
        import "${specifier}";
        document.modelContext.registerTool({
          name: "${name}",
          description: "${description}",
          inputSchema: { properties: { "${propertyName}": { type: "string" } } }
        });
      `),
    );

    expect(result.observations.chunks.edges[0]?.specifier).toBe(specifier);
    expect(result.observations.webmcp_declarations[0]).toMatchObject({
      name,
      description,
      schema_property_names: [propertyName],
      schema_property_names_coverage: "complete",
      trust: "page-declared-untrusted",
    });
  });
});

describe("web bundle source-map coverage", () => {
  it("reports unavailable source maps as partial without dropping requested maps", () => {
    const analysis = analyzeWebBundleFixture(inspection("export {};"), {
      status: "unavailable",
      requested: 1,
      processed: 1,
      items: [
        {
          script_key: `scr_${"1".repeat(64)}`,
          declared_url: "https://app.example.test/app.js.map",
          effective_url: null,
          status: "fetch_failed",
          artifact: null,
          original_sources: [],
          original_module_edges: [],
          mappings: [],
          limitation: "Source-map fetch failed.",
        },
      ],
    });

    expect(analysis.completeness.status).toBe("partial");
    expect(analysis.unknowns).toContainEqual({
      dimension: "source_maps",
      reason:
        "One or more requested source maps were unavailable or incomplete",
      affected_script_keys: [`scr_${"1".repeat(64)}`],
    });
  });

  it("keeps map-less captured source complete when no maps were requested", () => {
    const analysis = analyzeWebBundleFixture(inspection("export {};"), {
      status: "not_requested",
      requested: 0,
      processed: 0,
      items: [],
    });

    expect(analysis.completeness.status).toBe("complete");
    expect(analysis.unknowns).toEqual([]);
  });

  it("rejects inconsistent source-map coverage counts", () => {
    const result = analyzeWebBundleFixture(inspection("export {};"));
    expect(
      webBundleAnalysisSchema.safeParse({
        ...result,
        observations: {
          ...result.observations,
          source_maps: {
            ...result.observations.source_maps,
            requested: 1,
          },
        },
      }).success,
    ).toBe(false);
  });
});

describe("web bundle static-analysis parity", () => {
  it("recognizes endpoints through nested dynamic receivers like static analysis", () => {
    const result = analyzeWebBundleFixture(
      inspection('window[recv].fetch("/nested-fetch");'),
    );
    expect(result.observations.endpoints).toContainEqual(
      expect.objectContaining({ value: "/nested-fetch" }),
    );
  });

  it("reads open endpoints only from XMLHttpRequest method and URL pairs", () => {
    const result = analyzeWebBundleFixture(
      inspection(`
        xhr.open("GET", "/xhr-get");
        xhr.open("post", "https://xhr.example.test/submit");
        dav.open("PROPFIND", "/dav/");
        fs.open("/tmp/data.txt", "r", done);
        window.open("https://help.example.test/", "_blank");
        xhr.open(method, "/dynamic-method");
        fs.open(path, "r", done);
        window.open(url, "_blank");
        window.open(url, "/preview");
        globalThis.open(url, "./frame");
        document.open("text/html", "/replace");
        parent.open("GET", "/parent-xhr");
        self.open("post", "/self-xhr");
        top.open("GET", "/top-target");
        opener.open("GET", "/opener-target");
        frames.open("GET", "/frames-target");
        globalThis.open("GET", "/global-target");
        document.open("GET", "/document-target");
        const parentWindow = parent;
        parentWindow.open("GET", "/alias-target");
        {
          const parent = new XMLHttpRequest();
          parent.open(method, "/shadowed-parent-xhr");
        }
        xhr.open(method, "api/relative");
        fs.open(path, "w+", done);
        popup.open(url, "_TOP");
      `),
    );
    expect(
      result.observations.endpoints.map(({ value }) => value).sort(),
    ).toEqual([
      "/dav/",
      "/dynamic-method",
      "/shadowed-parent-xhr",
      "/xhr-get",
      "https://xhr.example.test/submit",
    ]);
    expect(result.inferences).toContainEqual(
      expect.objectContaining({
        kind: "endpoint_candidate",
        value: "api/relative",
        confidence: "low",
      }),
    );
  });
});

const socketEndpoints = (source: string) => {
  const analysis = analyzeJavaScriptStaticSource(source);
  expect(analysis.parse_status).not.toBe("failed");
  const staticEndpoints = analysis.endpoints;
  const capturedEndpoints = analyzeWebBundleFixture(inspection(source))
    .observations.endpoints;
  return [staticEndpoints, capturedEndpoints].map((items) =>
    items.map(({ value, mechanism }) => ({ value, mechanism })),
  );
};

describe("web bundle WebSocket endpoint identity", () => {
  it("retains qualified global WebSocket URLs through both source consumers", () => {
    const source = `
      new WebSocket("wss://example.test/bare");
      new window.WebSocket("wss://example.test/window");
      new self.WebSocket("wss://example.test/self");
      new global.WebSocket("wss://example.test/node-global");
      new globalThis.WebSocket("wss://example.test/global");
      new globalThis["WebSocket"]("wss://example.test/computed");
      new globalThis[\`WebSocket\`]("wss://example.test/template");
      new globalThis.\\u0057ebSocket("wss://example.test/escaped");
    `;
    const expected = [
      ["bare", "WebSocket"],
      ["window", "window.WebSocket"],
      ["self", "self.WebSocket"],
      ["node-global", "global.WebSocket"],
      ["global", "globalThis.WebSocket"],
      ["computed", "globalThis.WebSocket"],
      ["template", "globalThis.WebSocket"],
      ["escaped", "globalThis.WebSocket"],
    ].map(([path, constructor]) => ({
      value: `wss://example.test/${path}`,
      mechanism: `call:${constructor}`,
    }));
    expect(socketEndpoints(source)).toEqual([expected, expected]);
  });

  it("does not turn shadowed or local constructors into network endpoints", () => {
    const source = `
      function local(WebSocket, window, self, globalThis) {
        new WebSocket("wss://example.test/shadowed-bare");
        new window.WebSocket("wss://example.test/shadowed-window");
        new self.WebSocket("wss://example.test/shadowed-self");
        new globalThis.WebSocket("wss://example.test/shadowed-global");
      }
      const factory = { WebSocket: class {} };
      new factory.WebSocket("wss://example.test/lookalike");
      new globalThis.WebSocket("wss://example.test/control");
    `;
    const expected = [
      {
        value: "wss://example.test/control",
        mechanism: "call:globalThis.WebSocket",
      },
    ];
    expect(socketEndpoints(source)).toEqual([expected, expected]);
  });

  it.each([
    "WebSocket = replacement;",
    "globalThis.WebSocket = replacement;",
    "const root = window; root.WebSocket = replacement;",
    "delete self.WebSocket;",
    'Object.defineProperty(globalThis, "WebSocket", { value: replacement });',
    'const root = globalThis; Reflect.set(root, "WebSocket", replacement);',
    "globalThis[key] = replacement;",
  ])("does not assert a global socket endpoint after %s", (write) => {
    expect(
      socketEndpoints(`
        ${write}
        new WebSocket("wss://example.test/bare");
        new window.WebSocket("wss://example.test/window");
        new self.WebSocket("wss://example.test/self");
        new globalThis.WebSocket("wss://example.test/global");
      `),
    ).toEqual([[], []]);
  });

  it("keeps namespace replacement distinct from constructor replacement", () => {
    const source = `
      window = replacement;
      new window.WebSocket("wss://example.test/replaced-window");
      new globalThis.WebSocket("wss://example.test/control");
    `;
    const expected = [
      {
        value: "wss://example.test/control",
        mechanism: "call:globalThis.WebSocket",
      },
    ];
    expect(socketEndpoints(source)).toEqual([expected, expected]);
  });

  it("keeps a later visible constructor write conservative rather than proving runtime order", () => {
    expect(
      socketEndpoints(`
        new globalThis.WebSocket("wss://example.test/before-write");
        globalThis.WebSocket = replacement;
      `),
    ).toEqual([[], []]);
  });

  it("preserves sockets after unrelated writes and writes to a local namespace", () => {
    const source = `
      globalThis.unrelated = replacement;
      function local(window) { window.WebSocket = replacement; }
      new window.WebSocket("wss://example.test/control");
    `;
    const expected = [
      {
        value: "wss://example.test/control",
        mechanism: "call:window.WebSocket",
      },
    ];
    expect(socketEndpoints(source)).toEqual([expected, expected]);
  });
});

describe("web bundle bound WebSocket constructors", () => {
  it.each([
    [
      'const WebSocket = globalThis.WebSocket; new WebSocket("wss://example.test/bound");',
      "WebSocket",
    ],
    [
      'const Captured = window.WebSocket; const Socket = Captured; new Socket("wss://example.test/bound");',
      "Socket",
    ],
    [
      'import WebSocket from "ws"; new WebSocket("wss://example.test/bound");',
      "WebSocket",
    ],
    [
      'import { WebSocket as Socket } from "ws"; new Socket("wss://example.test/bound");',
      "Socket",
    ],
    [
      'import * as ws from "ws"; new ws[`WebSocket`]("wss://example.test/bound");',
      "ws.WebSocket",
    ],
    [
      'import Imported from "ws"; const Socket = Imported; new Socket("wss://example.test/bound");',
      "Socket",
    ],
    [
      'const WebSocket = require("ws"); new WebSocket("wss://example.test/bound");',
      "WebSocket",
    ],
    [
      'import WebSocket = require("ws"); new WebSocket("wss://example.test/bound");',
      "WebSocket",
    ],
    [
      'const Imported = require("ws"); const Socket = Imported; new Socket("wss://example.test/bound");',
      "Socket",
    ],
    [
      'const { WebSocket: Socket } = require("ws"); new Socket("wss://example.test/bound");',
      "Socket",
    ],
    [
      'const Socket = require("ws").WebSocket; new Socket("wss://example.test/bound");',
      "Socket",
    ],
    [
      'const { WebSocket } = globalThis; new WebSocket("wss://example.test/bound");',
      "WebSocket",
    ],
    [
      'const { [`WebSocket`]: Socket } = window; new Socket("wss://example.test/bound");',
      "Socket",
    ],
    [
      'function connect() { new WebSocket("wss://example.test/bound"); } const WebSocket = globalThis.WebSocket; connect();',
      "WebSocket",
    ],
    [
      'const connect = () => new Socket("wss://example.test/bound"); const { WebSocket: Socket } = globalThis; connect();',
      "Socket",
    ],
    [
      'const connect = (function () { new Socket("wss://example.test/bound"); }).bind(null); const Socket = globalThis.WebSocket; connect();',
      "Socket",
    ],
  ])(
    "retains a proven constructor binding in both consumers: %s",
    (source, name) => {
      const expected = [
        { value: "wss://example.test/bound", mechanism: `call:${name}` },
      ];
      expect(socketEndpoints(source)).toEqual([expected, expected]);
    },
  );

  it.each([
    'const WebSocket = class {}; new WebSocket("wss://example.test/local");',
    'import WebSocket from "other-library"; new WebSocket("wss://example.test/local");',
    'import type WebSocket from "ws"; new WebSocket("wss://example.test/local");',
    'import { type WebSocket } from "ws"; new WebSocket("wss://example.test/local");',
    'let Socket = globalThis.WebSocket; Socket = replacement; new Socket("wss://example.test/local");',
    'import WebSocket from "ws"; WebSocket = replacement; new WebSocket("wss://example.test/local");',
    'new WebSocket("wss://example.test/local"); const WebSocket = globalThis.WebSocket;',
    'const WebSocket = Socket; const Socket = WebSocket; new Socket("wss://example.test/local");',
    'if (condition) { var WebSocket = globalThis.WebSocket; } new WebSocket("wss://example.test/local");',
    'function local(globalThis) { const WebSocket = globalThis.WebSocket; new WebSocket("wss://example.test/local"); }',
    'const Socket = globalThis.WebSocket; new Socket("wss://example.test/local"); globalThis.WebSocket = replacement;',
    'import Socket from "ws"; Socket.WebSocket = replacement; new Socket.WebSocket("wss://example.test/local");',
    'function local(require) { const WebSocket = require("ws"); new WebSocket("wss://example.test/local"); }',
    'const WebSocket = require("ws"); WebSocket = replacement; new WebSocket("wss://example.test/local");',
    'const Socket = require("ws").Server; new Socket("wss://example.test/local");',
    'const { default: Socket } = require("ws"); new Socket("wss://example.test/local");',
    'const Socket = require("other-library").WebSocket; new Socket("wss://example.test/local");',
    'import type WebSocket = require("ws"); new WebSocket("wss://example.test/local");',
    'const { [key]: WebSocket } = globalThis; new WebSocket("wss://example.test/local");',
    'const { WebSocket = replacement } = globalThis; new WebSocket("wss://example.test/local");',
    'const { WebSocket } = globalThis; globalThis.WebSocket = replacement; new WebSocket("wss://example.test/local");',
    '(function connect() { new WebSocket("wss://example.test/local"); })(); const WebSocket = globalThis.WebSocket;',
    'new (function () { new Socket("wss://probe.test/new"); })(); const Socket = globalThis.WebSocket;',
    '(function () { new Socket("wss://probe.test/call"); }).call(null); const Socket = globalThis.WebSocket;',
    '(function () { new Socket("wss://probe.test/apply"); }).apply(null, []); const Socket = globalThis.WebSocket;',
    'new WebSocket("wss://example.test/local"); import WebSocket = require("ws");',
  ])(
    "does not infer constructor identity from an unresolved binding: %s",
    (source) => {
      expect(socketEndpoints(source)).toEqual([[], []]);
    },
  );
});

describe("web bundle WebSocket execution phases", () => {
  it.each([
    '(function () { new Socket("wss://example.test/eager"); } as any)();',
    '(function () { new Socket("wss://example.test/eager"); })!();',
    '(function () { new Socket("wss://example.test/eager"); } satisfies Function).call(null);',
    '(function () { new Socket("wss://example.test/eager"); }).bind(null)();',
    'new ((function () { new Socket("wss://example.test/eager"); }).bind(null))();',
    '(function* (x = new Socket("wss://example.test/eager")) {})();',
    '(function* (x = new Socket("wss://example.test/eager")) {}).call(null);',
    '(function* (x = new Socket("wss://example.test/eager")) {}).apply(null, []);',
    'class Client { static socket = new Socket("wss://example.test/eager"); }',
    'class Client { [new Socket("wss://example.test/eager")] = 1; }',
    '(async () => { new Socket("wss://example.test/eager"); await ready; })();',
    '(async () => { new Socket("wss://example.test/eager", await ready); })();',
    '(async () => { if (condition) await ready; new Socket("wss://example.test/eager"); })();',
    '(async () => { const later = async () => { await ready; }; new Socket("wss://example.test/eager"); })();',
  ])("excludes an eager capture before initialization: %s", (expression) => {
    expect(
      socketEndpoints(`${expression} const Socket = globalThis.WebSocket;`),
    ).toEqual([[], []]);
  });

  it.each([
    'class Client { socket = new Socket("wss://example.test/deferred"); }',
    'class Client { #socket = new Socket("wss://example.test/deferred"); }',
    '(function* () { new Socket("wss://example.test/deferred"); })();',
    '(async () => { await ready; new Socket("wss://example.test/deferred"); })();',
    '(async () => { const value = await ready; new Socket("wss://example.test/deferred"); })();',
    '(async () => { (await ready, new Socket("wss://example.test/deferred")); })();',
    'const connect = (function () { new Socket("wss://example.test/deferred"); } as any).bind(null);',
  ])("retains a deferred capture of the later binding: %s", (expression) => {
    const expected = [
      { value: "wss://example.test/deferred", mechanism: "call:Socket" },
    ];
    expect(
      socketEndpoints(`${expression} const Socket = globalThis.WebSocket;`),
    ).toEqual([expected, expected]);
  });

  it.each([
    '(async () => { await ready; new Socket("wss://example.test/tdz"); const Socket = globalThis.WebSocket; })();',
    '(async () => { new Socket("wss://example.test/tdz"); await ready; const Socket = globalThis.WebSocket; })();',
    '(async () => { await ready; new Socket("wss://example.test/tdz"); await ready; const Socket = globalThis.WebSocket; })();',
    '(async () => { (() => { new Socket("wss://example.test/tdz"); })(); await ready; const Socket = globalThis.WebSocket; })();',
  ])(
    "preserves initializer ordering across awaits in a shared frame: %s",
    (source) => {
      expect(socketEndpoints(source)).toEqual([[], []]);
    },
  );

  it.each([
    'new (class { socket = new Socket("wss://example.test/tdz"); })();',
    'new (class { #socket = new Socket("wss://example.test/tdz"); })();',
    'new ((class { socket = new Socket("wss://example.test/tdz"); } as any).bind(null))();',
    'new (class { constructor() { new Socket("wss://example.test/tdz"); } })();',
  ])(
    "keeps immediately constructed class initialization eager: %s",
    (expression) => {
      expect(
        socketEndpoints(`${expression} const Socket = globalThis.WebSocket;`),
      ).toEqual([[], []]);
    },
  );

  it.each([
    'const Socket = globalThis.WebSocket; new (class { socket = new Socket("wss://example.test/class"); })();',
    '(async () => { await ready; new (class { socket = new Socket("wss://example.test/class"); })(); })(); const Socket = globalThis.WebSocket;',
    'const Client = class { socket = new Socket("wss://example.test/class"); }; const Socket = globalThis.WebSocket; new Client();',
  ])("retains initialized or deferred class construction: %s", (source) => {
    const expected = [
      { value: "wss://example.test/class", mechanism: "call:Socket" },
    ];
    expect(socketEndpoints(source)).toEqual([expected, expected]);
  });
});

describe("web bundle constructor suspension order", () => {
  it.each([
    'let value; (async () => { value = await ready; new Socket("wss://example.test/resumed"); })();',
    '(async () => { (() => { new Socket("wss://example.test/resumed"); })(await ready); })();',
    '(async () => { new (class { socket = new Socket("wss://example.test/resumed"); })(await ready); })();',
    '(async () => { new (class { constructor() { new Socket("wss://example.test/resumed"); } })(await ready); })();',
    '(async () => { new (class { [await ready] = 0; socket = new Socket("wss://example.test/resumed"); })(); })();',
    '(async () => { new (class { socket = new Socket("wss://example.test/resumed"); [await ready] = 0; })(); })();',
    '(async () => { new (class { static socket = new Socket("wss://example.test/resumed"); [await ready] = 0; })(); })();',
    '(function* () { yield 0; new Socket("wss://example.test/resumed"); })().next();',
    '(async () => { (function* () { new Socket("wss://example.test/resumed"); })().next(await ready); })();',
  ])(
    "retains a constructor read after its preceding suspension: %s",
    (expression) => {
      const expected = [
        { value: "wss://example.test/resumed", mechanism: "call:Socket" },
      ];
      expect(
        socketEndpoints(`${expression} const Socket = globalThis.WebSocket;`),
      ).toEqual([expected, expected]);
    },
  );

  it.each([
    '(function* () { new Socket("wss://example.test/tdz"); })().next();',
    '(async function* () { new Socket("wss://example.test/tdz"); })().next();',
    '(function* () { new Socket("wss://example.test/tdz"); }).call(null).next();',
    '(async () => { new (class { static socket = new Socket("wss://example.test/tdz"); })(await ready); })();',
    '(async () => { new (class { [new Socket("wss://example.test/tdz")] = 0; })(await ready); })();',
    'let value; (async () => { value &&= await ready; new Socket("wss://example.test/tdz"); })();',
    '(async () => { new (class { socket = new Socket("wss://example.test/tdz"); })(await ready); const Socket = globalThis.WebSocket; })();',
  ])(
    "does not move a callee, key, or local TDZ past a later suspension: %s",
    (expression) => {
      expect(
        socketEndpoints(`${expression} const Socket = globalThis.WebSocket;`),
      ).toEqual([[], []]);
    },
  );
});

describe("web bundle CommonJS socket member mutation", () => {
  it.each([
    'const ws = require("ws"); ws.WebSocket = class {}; new ws.WebSocket("wss://example.test/local");',
    'const ws = require("ws"); const alias = ws; alias.WebSocket = class {}; new ws.WebSocket("wss://example.test/local");',
    'const ws = require("ws"); const alias = ws; ws.WebSocket = class {}; new alias.WebSocket("wss://example.test/local");',
    'const ws = require("ws"); const box = { ws }; box.ws.WebSocket = class {}; new ws.WebSocket("wss://example.test/local");',
    'require("ws").WebSocket = class {}; const ws = require("ws"); new ws.WebSocket("wss://example.test/local");',
    'const ws = require("ws"); ws.WebSocket = class {}; const Socket = ws.WebSocket; new Socket("wss://example.test/local");',
    'const ws = require("ws"); ws.WebSocket = class {}; const { WebSocket: Socket } = ws; new Socket("wss://example.test/local");',
    'const ws = require("ws"); Object.defineProperty(ws, "WebSocket", { value: class {} }); new ws.WebSocket("wss://example.test/local");',
    'const ws = require("ws"); const set = Reflect.set; set(ws, "WebSocket", class {}); new ws.WebSocket("wss://example.test/local");',
    'const ws = require("ws"); ws[key] = class {}; new ws.WebSocket("wss://example.test/local");',
    'const ws = require("ws"); const alias = ws[key]; alias.WebSocket = class {}; new ws.WebSocket("wss://example.test/local");',
    'const ws = require("ws"); const { WebSocket: alias } = ws; alias.WebSocket = class {}; new ws.WebSocket("wss://example.test/local");',
    'const ws = require("ws"); delete ws.WebSocket; new ws.WebSocket("wss://example.test/local");',
  ])("excludes a visibly replaced selected export: %s", (source) => {
    expect(socketEndpoints(source)).toEqual([[], []]);
  });

  it.each([
    'const ws = require("ws"); const Socket = ws.WebSocket; ws.WebSocket = class {}; new Socket("wss://example.test/intact");',
    'const ws = require("ws"); new ws.WebSocket("wss://example.test/intact"); ws.WebSocket = class {};',
    'const ws = require("ws"); ws.Server = class {}; new ws.WebSocket("wss://example.test/intact");',
    'const ws = require("ws"); ws.WebSocket = class {}; new ws("wss://example.test/intact");',
    'const ws = require("ws"); const Socket = ws.WebSocket; Socket.WebSocket = class {}; new Socket("wss://example.test/intact");',
    'const ws = require("ws"); let alias = ws; alias = {}; alias.WebSocket = class {}; new ws.WebSocket("wss://example.test/intact");',
    'const ws = require("ws"); const copy = { ...ws }; copy.WebSocket = class {}; new ws.WebSocket("wss://example.test/intact");',
    'const ws = require("ws"); const { WebSocket: Socket } = ws; ws.WebSocket = class {}; new Socket("wss://example.test/intact");',
  ])(
    "retains a constructor captured before replacement or an untouched slot: %s",
    (source) => {
      const result = socketEndpoints(source);
      expect(result[0]?.map(({ value }) => value)).toEqual([
        "wss://example.test/intact",
      ]);
      expect(result[1]?.map(({ value }) => value)).toEqual([
        "wss://example.test/intact",
      ]);
    },
  );
});

describe("web bundle conditional suspension and sequence invocations", () => {
  it.each([
    '(async () => { if (await ready) new Socket("wss://example.test/branch"); })();',
    '(async () => { if (await ready) {} else new Socket("wss://example.test/branch"); })();',
    '(async () => { if (await ready) {} new Socket("wss://example.test/branch"); })();',
    '(async () => { (await ready) ? new Socket("wss://example.test/branch") : 0; })();',
    '(async () => { (await ready) && new Socket("wss://example.test/branch"); })();',
  ])(
    "retains branch reads after an evaluated test suspension: %s",
    (expression) => {
      const expected = [
        { value: "wss://example.test/branch", mechanism: "call:Socket" },
      ];
      expect(
        socketEndpoints(`${expression} const Socket = globalThis.WebSocket;`),
      ).toEqual([expected, expected]);
    },
  );

  it.each([
    '(0, function () { new Socket("wss://example.test/tdz"); })();',
    '((0, function () { new Socket("wss://example.test/tdz"); }) as any)();',
    '(0, () => { new Socket("wss://example.test/tdz"); })();',
    '(0, function () { new Socket("wss://example.test/tdz"); }).call(null);',
    'new (0, class { socket = new Socket("wss://example.test/tdz"); })();',
    '(0, function* () { new Socket("wss://example.test/tdz"); })().next();',
    '(async () => { if (condition) await ready; new Socket("wss://example.test/tdz"); })();',
    '(async () => { condition && (await ready); new Socket("wss://example.test/tdz"); })();',
  ])(
    "keeps immediate final operands eager without assuming skipped branch suspension: %s",
    (expression) => {
      expect(
        socketEndpoints(`${expression} const Socket = globalThis.WebSocket;`),
      ).toEqual([[], []]);
    },
  );

  it("retains a stored final-operand constructor capture", () => {
    const expected = [
      { value: "wss://example.test/stored-sequence", mechanism: "call:Socket" },
    ];
    expect(
      socketEndpoints(
        'const connect = (0, function () { new Socket("wss://example.test/stored-sequence"); }); const Socket = globalThis.WebSocket; connect();',
      ),
    ).toEqual([expected, expected]);
  });
});

describe("web bundle evaluated socket continuations", () => {
  it.each([
    '(async () => { while (await ready) { new Socket("wss://example.test/resumed"); break; } })();',
    '(async () => { for (; await ready;) { new Socket("wss://example.test/resumed"); break; } })();',
    '(async () => { [await ready, new Socket("wss://example.test/resumed")]; })();',
    '(async () => { [,[...(await ready)], new Socket("wss://example.test/resumed")]; })();',
    '(async () => { while (await ready) {} new Socket("wss://example.test/resumed"); })();',
    '(async function* () { yield* []; new Socket("wss://example.test/resumed"); })().next();',
    '(function* () { yield; new Socket("wss://example.test/resumed"); })().next();',
    '(async () => { await (async () => { await ready; new Socket("wss://example.test/resumed"); })(); })();',
  ])(
    "retains a read after its mandatory evaluation prefix: %s",
    (expression) => {
      const expected = [
        { value: "wss://example.test/resumed", mechanism: "call:Socket" },
      ];
      expect(
        socketEndpoints(`${expression} const Socket = globalThis.WebSocket;`),
      ).toEqual([expected, expected]);
    },
  );

  it.each([
    '(function* () { yield* []; new Socket("wss://example.test/tdz"); })().next(); const Socket = globalThis.WebSocket;',
    '(function* () { yield* values; new Socket("wss://example.test/tdz"); })().next(); const Socket = globalThis.WebSocket;',
    '(async () => { do { new Socket("wss://example.test/tdz"); } while (await ready); })(); const Socket = globalThis.WebSocket;',
    '(async () => { while (condition) await ready; new Socket("wss://example.test/tdz"); })(); const Socket = globalThis.WebSocket;',
    '(async () => { [new Socket("wss://example.test/tdz"), await ready]; })(); const Socket = globalThis.WebSocket;',
    '(async () => { await (async () => { await ready; new Socket("wss://example.test/tdz"); })(); const Socket = globalThis.WebSocket; })();',
    '(async () => { await (async () => { await (async () => { await ready; new Socket("wss://example.test/tdz"); })(); })(); const Socket = globalThis.WebSocket; })();',
    '(async () => { while (await ready) { new Socket("wss://example.test/tdz"); const Socket = globalThis.WebSocket; } })();',
  ])(
    "does not turn conditional suspension or a waiting initializer into identity: %s",
    (source) => {
      expect(socketEndpoints(source)).toEqual([[], []]);
    },
  );
});

describe("web bundle exact constructor result values", () => {
  it.each([
    "const Socket = (0, globalThis.WebSocket);",
    "const Socket = (0, (1, globalThis.WebSocket));",
    "const Socket = (0, globalThis).WebSocket;",
  ])("follows only a sequence's resulting value: %s", (capture) => {
    const expected = [
      { value: "wss://example.test/result", mechanism: "call:Socket" },
    ];
    expect(
      socketEndpoints(`${capture} new Socket("wss://example.test/result");`),
    ).toEqual([expected, expected]);
  });

  it.each([
    'const Socket = (globalThis.WebSocket, class {}); new Socket("wss://example.test/invalid");',
    'switch (kind) { case 0: const Socket = globalThis.WebSocket; break; case 1: new Socket("wss://example.test/invalid"); }',
  ])("rejects skipped or discarded constructor values: %s", (source) => {
    expect(socketEndpoints(source)).toEqual([[], []]);
  });
});

it("retains a constructor initialized in the same selected switch case", () => {
  const expected = [
    { value: "wss://example.test/result", mechanism: "call:Socket" },
  ];
  expect(
    socketEndpoints(
      'switch (kind) { case 0: const Socket = globalThis.WebSocket; new Socket("wss://example.test/result"); break; }',
    ),
  ).toEqual([expected, expected]);
});

describe("web bundle literal dynamic socket imports", () => {
  it.each([
    'const { WebSocket: Socket } = await import("ws");',
    'const { default: Socket } = await import("ws");',
    'const ws = await import("ws"); const Socket = ws.WebSocket;',
    'const Socket = (await import("ws")).WebSocket;',
  ])("retains an exact awaited module export: %s", (capture) => {
    const expected = [
      { value: "wss://example.test/imported", mechanism: "call:Socket" },
    ];
    expect(
      socketEndpoints(`${capture} new Socket("wss://example.test/imported");`),
    ).toEqual([expected, expected]);
  });

  it.each([
    'const { WebSocket: Socket } = import("ws");',
    "const { WebSocket: Socket } = await import(name);",
    'const { WebSocket: Socket } = await import("other");',
    'const { Server: Socket } = await import("ws");',
    'const Socket = (await import("ws")).default.WebSocket;',
    'let { WebSocket: Socket } = await import("ws"); Socket = class {};',
  ])(
    "does not infer promise values or unresolved module exports: %s",
    (capture) => {
      expect(
        socketEndpoints(`${capture} new Socket("wss://example.test/invalid");`),
      ).toEqual([[], []]);
    },
  );
});

describe("web bundle promise aliases and object evaluation", () => {
  it.each([
    '({ first: await ready, second: new Socket("wss://example.test/object") });',
    '({ [await ready]: new Socket("wss://example.test/object") });',
    '({ [await ready]: 0, second: new Socket("wss://example.test/object") });',
    '({ ...(await ready), second: new Socket("wss://example.test/object") });',
    '({ [await ready]() {}, second: new Socket("wss://example.test/object") });',
    '({ first: { nested: await ready }, second: new Socket("wss://example.test/object") });',
  ])(
    "carries completed property evaluation into later values: %s",
    (expression) => {
      const expected = [
        { value: "wss://example.test/object", mechanism: "call:Socket" },
      ];
      expect(
        socketEndpoints(
          `(async () => { ${expression} })(); const Socket = globalThis.WebSocket;`,
        ),
      ).toEqual([expected, expected]);
    },
  );

  it.each([
    '({ first: new Socket("wss://example.test/invalid"), second: await ready });',
    '({ async method() { await ready; }, second: new Socket("wss://example.test/invalid") });',
    '({ first: condition && (await ready), second: new Socket("wss://example.test/invalid") });',
  ])(
    "does not promote later, deferred or skipped property awaits: %s",
    (expression) => {
      expect(
        socketEndpoints(
          `(async () => { ${expression} })(); const Socket = globalThis.WebSocket;`,
        ),
      ).toEqual([[], []]);
    },
  );

  it.each([
    'const pending = (async () => { await ready; new Socket("wss://example.test/invalid"); })(); await pending; const Socket = globalThis.WebSocket;',
    'const pending = (async () => { await ready; new Socket("wss://example.test/invalid"); })(); const alias = pending; await alias; const Socket = globalThis.WebSocket;',
    '(async () => { const pending = (async () => { await ready; new Socket("wss://example.test/invalid"); })(); await pending; const Socket = globalThis.WebSocket; })();',
    'const pending = (async () => { await ready; new Socket("wss://example.test/invalid"); })(); await pending; await pending; const Socket = globalThis.WebSocket;',
  ])(
    "retains the actual wait point of a stable promise result: %s",
    (source) => {
      expect(socketEndpoints(source)).toEqual([[], []]);
    },
  );

  it.each([
    'const pending = (async () => { await ready; new Socket("wss://example.test/wait"); })(); const Socket = globalThis.WebSocket; await pending;',
    'const pending = (async () => { await ready; new Socket("wss://example.test/wait"); })(); const alias = pending; const Socket = globalThis.WebSocket; await alias;',
    '(async () => { const pending = (async () => { await ready; new Socket("wss://example.test/wait"); })(); const Socket = globalThis.WebSocket; await pending; })();',
    'const pending = (async () => { await ready; new Socket("wss://example.test/wait"); })(); (async (pending) => { await pending; })(ready); const Socket = globalThis.WebSocket;',
  ])(
    "keeps initialization before a wait distinct from promise creation: %s",
    (source) => {
      const expected = [
        { value: "wss://example.test/wait", mechanism: "call:Socket" },
      ];
      expect(socketEndpoints(source)).toEqual([expected, expected]);
    },
  );

  it.each([
    'const pending = import("ws"); const { WebSocket: Socket } = await pending;',
    'const pending = import("ws"); const alias = pending; const { default: Socket } = await alias;',
    "const pending = import(`ws`); const Socket = (await pending).WebSocket;",
  ])(
    "retains a literal module through its stable pending promise: %s",
    (capture) => {
      const expected = [
        { value: "wss://example.test/import-alias", mechanism: "call:Socket" },
      ];
      expect(
        socketEndpoints(
          `${capture} new Socket("wss://example.test/import-alias");`,
        ),
      ).toEqual([expected, expected]);
    },
  );

  it.each([
    'let pending = import("ws"); pending = import("other"); const { WebSocket: Socket } = await pending;',
    'const pending = import("other"); const { WebSocket: Socket } = await pending;',
    "const pending = other; const other = pending; const { WebSocket: Socket } = await pending;",
    'const { WebSocket: Socket } = await pending; const pending = import("ws");',
    'const box = { pending: import("ws") }; const { WebSocket: Socket } = await box.pending;',
  ])(
    "leaves unstable, forward and unproven promise identities unresolved: %s",
    (capture) => {
      expect(
        socketEndpoints(`${capture} new Socket("wss://example.test/invalid");`),
      ).toEqual([[], []]);
    },
  );
});

describe("web bundle selected invocations, imports and case waits", () => {
  it.each([
    '(true ? () => new Socket("wss://example.test/invalid") : noop)(); const Socket = globalThis.WebSocket;',
    '(false ? noop : function () { new Socket("wss://example.test/invalid"); })(); const Socket = globalThis.WebSocket;',
    '(true && (() => new Socket("wss://example.test/invalid")))(); const Socket = globalThis.WebSocket;',
    '(false || function () { new Socket("wss://example.test/invalid"); })(); const Socket = globalThis.WebSocket;',
    '(null ?? function () { new Socket("wss://example.test/invalid"); })(); const Socket = globalThis.WebSocket;',
    '({ run() { new Socket("wss://example.test/invalid"); } }).run(); const Socket = globalThis.WebSocket;',
    '({ [`run`]() { new Socket("wss://example.test/invalid"); } })[`run`](); const Socket = globalThis.WebSocket;',
    '({ run: () => new Socket("wss://example.test/invalid") }).run(); const Socket = globalThis.WebSocket;',
    '({ run() { new Socket("wss://example.test/invalid"); } }).run.call(null); const Socket = globalThis.WebSocket;',
    '({ run() { new Socket("wss://example.test/invalid"); } }).run.bind(null)(); const Socket = globalThis.WebSocket;',
    '(true ? { run() { new Socket("wss://example.test/invalid"); } } : other).run(); const Socket = globalThis.WebSocket;',
    '@(function () { new Socket("wss://example.test/invalid"); }) class Client {}; const Socket = globalThis.WebSocket;',
    '@(() => { new Socket("wss://example.test/invalid"); }) class Client {}; const Socket = globalThis.WebSocket;',
    'class Client { @(function () { new Socket("wss://example.test/invalid"); }) run() {} }; const Socket = globalThis.WebSocket;',
    '(async () => { switch (kind) { case 0: const pending = (async () => { await ready; new Socket("wss://example.test/invalid"); })(); await pending; } const Socket = globalThis.WebSocket; })();',
    '(async () => { switch (kind) { case 0: const pending = (async () => { await ready; new Socket("wss://example.test/invalid"); })(); const alias = pending; await alias; } const Socket = globalThis.WebSocket; })();',
    '(async () => { switch (kind) { case 0: const pending = (async () => { await ready; new Socket("wss://example.test/invalid"); })(); await (async () => { await pending; })(); } const Socket = globalThis.WebSocket; })();',
    '(async () => { import("owned:module"); new Socket("wss://example.test/invalid"); })(); const Socket = globalThis.WebSocket;',
    '(async () => { import("owned:module", { ignored: async () => await ready }); new Socket("wss://example.test/invalid"); })(); const Socket = globalThis.WebSocket;',
    'const Socket = condition ? globalThis.WebSocket : Fake; new Socket("wss://example.test/invalid");',
  ])(
    "does not manufacture a deferred activation or a mandatory wait: %s",
    (source) => {
      expect(socketEndpoints(source)).toEqual([[], []]);
    },
  );

  it.each([
    '(async () => { import(await ready); new Socket("wss://example.test/selected"); })(); const Socket = globalThis.WebSocket;',
    '(async () => { import("owned:module", await ready); new Socket("wss://example.test/selected"); })(); const Socket = globalThis.WebSocket;',
    '(async () => { import("owned:module", { with: { type: await ready } }); new Socket("wss://example.test/selected"); })(); const Socket = globalThis.WebSocket;',
    'const connect = (true ? () => new Socket("wss://example.test/selected") : noop); const Socket = globalThis.WebSocket; connect();',
    'const connect = ({ run() { new Socket("wss://example.test/selected"); } }).run; const Socket = globalThis.WebSocket; connect();',
    '({ async run() { await ready; new Socket("wss://example.test/selected"); } }).run(); const Socket = globalThis.WebSocket;',
    '@(function* () { new Socket("wss://example.test/selected"); }) class Client {}; const Socket = globalThis.WebSocket;',
    '@(function () { return function () { new Socket("wss://example.test/selected"); }; }) class Client {}; const Socket = globalThis.WebSocket; Client();',
    '(async () => { @(function () { new Socket("wss://example.test/selected"); }) class Client { [await ready]() {} } })(); const Socket = globalThis.WebSocket;',
    '(async () => { class Client { @(function () { new Socket("wss://example.test/selected"); }) run() {} [await ready]() {} } })(); const Socket = globalThis.WebSocket;',
    'const Socket = true ? globalThis.WebSocket : Fake; new Socket("wss://example.test/selected");',
    'const Socket = false || globalThis.WebSocket; new Socket("wss://example.test/selected");',
    '(async () => { switch (kind) { case 0: const pending = (async () => { await ready; new Socket("wss://example.test/selected"); })(); break; await pending; } const Socket = globalThis.WebSocket; })();',
    '(async () => { const pending = (async () => { await ready; new Socket("wss://example.test/selected"); })(); switch (kind) { case 0: await pending; } const Socket = globalThis.WebSocket; })();',
  ])(
    "retains proven selections and suspension without promoting skipped paths: %s",
    (source) => {
      expect(
        socketEndpoints(source).map((items) => items.map((item) => item.value)),
      ).toEqual([
        ["wss://example.test/selected"],
        ["wss://example.test/selected"],
      ]);
    },
  );
});

describe("web bundle selected bindings and reachable waits", () => {
  it.each([
    'const pending = (async () => { await 0; new Socket("wss://example.test/invalid"); })(); await (async () => { await pending; })(); const Socket = globalThis.WebSocket;',
    'const pending = (async () => { await 0; new Socket("wss://example.test/invalid"); })(); await (async () => { await 0; await pending; })(); const Socket = globalThis.WebSocket;',
    'const pending = (async () => { await 0; new Socket("wss://example.test/invalid"); })(); const alias = pending; await (async () => { await alias; })(); const Socket = globalThis.WebSocket;',
    'const pending = (async () => { await 0; new Socket("wss://example.test/invalid"); })(); await (async () => { await (async () => { await pending; })(); })(); const Socket = globalThis.WebSocket;',
    '(async () => { if (condition) { const pending = (async () => { await 0; new Socket("wss://example.test/invalid"); })(); await (async () => { await pending; })(); } const Socket = globalThis.WebSocket; })();',
  ])(
    "retains initialized blocking aliases through literal callers: %s",
    (source) => {
      // Declare module mode: await(f)() can also be an ordinary script call.
      expect(socketEndpoints(`export {}; ${source}`)).toEqual([[], []]);
    },
  );

  it.each([
    'const pending = (async () => { await ready; new Socket("wss://example.test/selected"); })(); await (async () => { if (condition) await pending; })(); const Socket = globalThis.WebSocket;',
    'const pending = (async () => { await ready; new Socket("wss://example.test/selected"); })(); try { await (async () => { await alias; })(); } catch {} const alias = pending; const Socket = globalThis.WebSocket;',
    'const pending = (async () => { await 0; new Socket("wss://example.test/selected"); })(); (async () => { await pending; })(); const Socket = globalThis.WebSocket;',
    '(async () => { const pending = (async () => { await 0; new Socket("wss://example.test/selected"); })(); if (condition) await (async () => { await pending; })(); const Socket = globalThis.WebSocket; })();',
  ])(
    "does not promote optional or uninitialized cross-caller waits: %s",
    (source) => {
      expect(
        socketEndpoints(`export {}; ${source}`).map((items) =>
          items.map((item) => item.value),
        ),
      ).toEqual([
        ["wss://example.test/selected"],
        ["wss://example.test/selected"],
      ]);
    },
  );

  it.each([
    'const pending = (async () => { await 0; new Socket("wss://example.test/selected"); })(); try { await alias; } catch {} const alias = pending; const Socket = globalThis.WebSocket;',
    'const pending = (async () => { await 0; new Socket("wss://example.test/selected"); })(); try { await second; } catch {} const first = pending; const second = first; const Socket = globalThis.WebSocket;',
    '(async () => { const pending = (async () => { await ready; new Socket("wss://example.test/selected"); })(); while (true) { break; await pending; } const Socket = globalThis.WebSocket; })();',
    '(async () => { const pending = (async () => { await ready; new Socket("wss://example.test/selected"); })(); for (let i = 0; i < 1; i++) { continue; await pending; } const Socket = globalThis.WebSocket; })();',
    '(async () => { (await ready).value &&= new Socket("wss://example.test/selected"); })(); const Socket = globalThis.WebSocket;',
    '(async () => { (await ready).value ||= new Socket("wss://example.test/selected"); })(); const Socket = globalThis.WebSocket;',
    '(async () => { (await ready).value ??= new Socket("wss://example.test/selected"); })(); const Socket = globalThis.WebSocket;',
    '(async () => { switch (kind) { case 0: await ready; new Socket("wss://example.test/selected"); } })(); const Socket = globalThis.WebSocket;',
    '(async () => { switch (kind) { default: 0; await ready; new Socket("wss://example.test/selected"); } })(); const Socket = globalThis.WebSocket;',
    // export= declares a CommonJS fixture, where the bare require is available.
    'export = {}; import ws = require("ws"); const other = require("ws"); ws = {}; ws.WebSocket = class {}; new other.WebSocket("wss://example.test/selected");',
    'export = {}; import ws = require("ws"); const other = require("ws"); ws = {}; const replacement = ws; replacement.WebSocket = class {}; new other.WebSocket("wss://example.test/selected");',
    'Array.prototype[Symbol.iterator] = function* () { yield class {}; }; const { 0: Socket } = [globalThis.WebSocket]; new Socket("wss://example.test/selected");',
    'let box; const { WebSocket: Socket, unused = (box.WebSocket = class {}) } = (box = { WebSocket: globalThis.WebSocket }); new Socket("wss://example.test/selected");',
    'let box; const { 0: Socket, unused = (box.length = 0) } = (box = [globalThis.WebSocket]); new Socket("wss://example.test/selected");',
  ])("retains source-proven constructor reads: %s", (source) => {
    expect(
      socketEndpoints(source).map((items) => items.map((item) => item.value)),
    ).toEqual([
      ["wss://example.test/selected"],
      ["wss://example.test/selected"],
    ]);
  });

  it.each([
    '(async () => { if (condition) { const pending = (async () => { await ready; new Socket("wss://example.test/invalid"); })(); await pending; } const Socket = globalThis.WebSocket; })();',
    '(async () => { if (condition) { const pending = (async () => { await ready; new Socket("wss://example.test/invalid"); })(); const alias = pending; await alias; } const Socket = globalThis.WebSocket; })();',
    'let box; const { unused = (box.WebSocket = class {}), WebSocket: Socket } = (box = { WebSocket: globalThis.WebSocket }); new Socket("wss://example.test/invalid");',
    'let box; const { [box.WebSocket = class {}]: unused, WebSocket: Socket } = (box = { WebSocket: globalThis.WebSocket }); new Socket("wss://example.test/invalid");',
    'let box; const { nested: { unused = (box.nested.WebSocket = class {}), WebSocket: Socket } } = (box = { nested: { WebSocket: globalThis.WebSocket } }); new Socket("wss://example.test/invalid");',
    'let box; const { unused = (box.length = 0), 0: Socket } = (box = [globalThis.WebSocket]); new Socket("wss://example.test/invalid");',
    'Array.prototype[Symbol.iterator] = function* () { yield class {}; }; const [Socket] = [globalThis.WebSocket]; new Socket("wss://example.test/invalid");',
    'const prototype = Array.prototype; prototype[Symbol.iterator] = function* () { yield class {}; }; const [Socket] = (0, [globalThis.WebSocket]); new Socket("wss://example.test/invalid");',
    'globalThis.Array.prototype[Symbol.iterator] = function* () { yield class {}; }; const { nested: [Socket] } = { nested: [globalThis.WebSocket] }; new Socket("wss://example.test/invalid");',
    'globalThis.WebSocket("wss://example.test/invalid");',
    'const Socket = globalThis.WebSocket; Socket("wss://example.test/invalid");',
    'window[`WebSocket`]("wss://example.test/invalid");',
    '(async () => { try { using resource = 1; await 0; } finally { new Socket("wss://example.test/invalid"); } })(); const Socket = globalThis.WebSocket;',
    '(async () => { try { await using resource = 1; await 0; } finally { new Socket("wss://example.test/invalid"); } })(); const Socket = globalThis.WebSocket;',
    '(async () => { condition &&= await ready; new Socket("wss://example.test/invalid"); })(); const Socket = globalThis.WebSocket;',
    '(async () => { switch (kind) { case 0: await ready; break; case 1: new Socket("wss://example.test/invalid"); } })(); const Socket = globalThis.WebSocket;',
    'import ws = require("ws"); const other = require("ws"); ws.WebSocket = class {}; new other.WebSocket("wss://example.test/invalid");',
    '(async () => { const pending = (async () => { await ready; new Socket("wss://example.test/invalid"); })(); const alias = pending; await alias; const Socket = globalThis.WebSocket; })();',
  ])(
    "does not manufacture construction, value or wait proofs: %s",
    (source) => {
      expect(socketEndpoints(source)).toEqual([[], []]);
    },
  );
});

describe("web bundle owned waits and exact result paths", () => {
  it.each([
    '(async () => { try { await 0; } finally { new Socket("wss://example.test/owned"); } })(); const Socket = globalThis.WebSocket;',
    '(async () => { try { 1; await 0; throw 0; } finally { new Socket("wss://example.test/owned"); } })(); const Socket = globalThis.WebSocket;',
    '(async () => { try { { await 0; } } catch {} finally { new Socket("wss://example.test/owned"); } })(); const Socket = globalThis.WebSocket;',
    'const [Socket] = (0, [globalThis.WebSocket]); new Socket("wss://example.test/owned");',
    'let saved; const [Socket] = (saved = [globalThis.WebSocket]); new Socket("wss://example.test/owned");',
    'const { nested: [Socket] } = (0, { nested: (0, [globalThis.WebSocket]) }); new Socket("wss://example.test/owned");',
    'const [[Socket]] = [(0, [globalThis.WebSocket])]; new Socket("wss://example.test/owned");',
    '(async () => { switch (await ready) { default: new Socket("wss://example.test/owned"); } })(); const Socket = globalThis.WebSocket;',
    '(async () => { switch (await ready) { default: break; } new Socket("wss://example.test/owned"); })(); const Socket = globalThis.WebSocket;',
    '(async () => { (await ready)?.(new Socket("wss://example.test/owned")); })(); const Socket = globalThis.WebSocket;',
    '(async () => { (await ready)?.call(null, new Socket("wss://example.test/owned")); })(); const Socket = globalThis.WebSocket;',
    '(async () => { (await ready).count++; new Socket("wss://example.test/owned"); })(); const Socket = globalThis.WebSocket;',
    '(async () => { ++(await ready).count; new Socket("wss://example.test/owned"); })(); const Socket = globalThis.WebSocket;',
    'const ws = require("ws"); const Socket = ws.WebSocket; if (flag) { ws.WebSocket = Fake; } new Socket("wss://example.test/owned");',
    'const ws = require("ws"); const Socket = ws.WebSocket; try { ws.WebSocket = Fake; } finally {} new Socket("wss://example.test/owned");',
    'const ws = require("ws"); const Socket = ws.WebSocket; for (const value of items) { ws.WebSocket = Fake; } new Socket("wss://example.test/owned");',
    'const ws = require("ws"); const Socket = ws.WebSocket.WebSocket; new Socket("wss://example.test/owned");',
    'const Socket = require("ws").WebSocket.WebSocket.WebSocket; new Socket("wss://example.test/owned");',
    'import ws = require("ws"); const Socket = ws.WebSocket.WebSocket; new Socket("wss://example.test/owned");',
    'const ws = require("ws"); new ws.WebSocket.WebSocket("wss://example.test/owned");',
    '(async () => { const pending = (async () => { await ready; new Socket("wss://example.test/owned"); })(); if (condition) await pending; const Socket = globalThis.WebSocket; })();',
  ])(
    "retains a proven endpoint through shared producing facts: %s",
    (source) => {
      expect(
        socketEndpoints(source).map((items) => items.map((item) => item.value)),
      ).toEqual([["wss://example.test/owned"], ["wss://example.test/owned"]]);
    },
  );

  it.each([
    '(async () => { try { throw 0; await 0; } finally { new Socket("wss://example.test/invalid"); } })(); const Socket = globalThis.WebSocket;',
    '(async () => { try { fail(); await 0; } finally { new Socket("wss://example.test/invalid"); } })(); const Socket = globalThis.WebSocket;',
    '(async () => { try { await missing; } finally { new Socket("wss://example.test/invalid"); } })(); const Socket = globalThis.WebSocket;',
    'const [Socket] = (items += [globalThis.WebSocket]); new Socket("wss://example.test/invalid");',
    'const values = [globalThis.WebSocket]; const [Socket] = (0, values); new Socket("wss://example.test/invalid");',
    'const [Socket] = (0, [...items, globalThis.WebSocket]); new Socket("wss://example.test/invalid");',
    'let holder; const ws = (holder = require("ws")); ws.WebSocket = Fake; new ws.WebSocket("wss://example.test/invalid");',
    'const ws = (0, require("ws")); ws.WebSocket = Fake; new ws.WebSocket("wss://example.test/invalid");',
    'let holder; const root = (holder = globalThis); root.WebSocket = Fake; new globalThis.WebSocket("wss://example.test/invalid");',
    '(async () => { if (condition) await (async () => { await ready; new Socket("wss://example.test/invalid"); })(); const Socket = globalThis.WebSocket; })();',
    '(async () => { condition && await (async () => { await ready; new Socket("wss://example.test/invalid"); })(); const Socket = globalThis.WebSocket; })();',
    '(async () => { condition ? await (async () => { await ready; new Socket("wss://example.test/invalid"); })() : 0; const Socket = globalThis.WebSocket; })();',
    '(async () => { switch (condition) { case 1: await ready; } new Socket("wss://example.test/invalid"); })(); const Socket = globalThis.WebSocket;',
    '(async () => { maybe?.(await ready); new Socket("wss://example.test/invalid"); })(); const Socket = globalThis.WebSocket;',
    '(async () => { maybe?.[(await ready).count++]; new Socket("wss://example.test/invalid"); })(); const Socket = globalThis.WebSocket;',
    'const ws = require("ws"); if (flag) { ws.WebSocket = Fake; } const Socket = ws.WebSocket; new Socket("wss://example.test/invalid");',
    'const ws = require("ws"); ws.WebSocket.WebSocket = Fake; new ws.WebSocket.WebSocket("wss://example.test/invalid");',
    'const ws = require("ws"); new ws.WebSocket.Other("wss://example.test/invalid");',
  ])(
    "does not turn skipped waits or modified identities into proof: %s",
    (source) => {
      expect(socketEndpoints(source)).toEqual([[], []]);
    },
  );
});

describe("web bundle binding events and structured continuations", () => {
  it.each([
    'const { WebSocket: Socket, unused = new Socket("wss://example.test/event") } = globalThis;',
    'const [Socket, unused = new Socket("wss://example.test/event")] = [globalThis.WebSocket];',
    'const { WebSocket: Socket, [new Socket("wss://example.test/event")]: unused } = globalThis;',
    'const { nested: [Socket], unused = new Socket("wss://example.test/event") } = { nested: [globalThis.WebSocket] };',
  ])(
    "orders binding initialization before later pattern evaluation: %s",
    (source) => {
      const expected = [
        { value: "wss://example.test/event", mechanism: "call:Socket" },
      ];
      expect(socketEndpoints(source)).toEqual([expected, expected]);
    },
  );

  it.each([
    'const { unused = new Socket("wss://example.test/invalid"), WebSocket: Socket } = globalThis;',
    'const [unused = new Socket("wss://example.test/invalid"), Socket] = [undefined, globalThis.WebSocket];',
    'const { [new Socket("wss://example.test/invalid")]: unused, WebSocket: Socket } = globalThis;',
  ])("keeps earlier pattern reads before initialization: %s", (source) => {
    expect(socketEndpoints(source)).toEqual([[], []]);
  });

  it.each([
    'for await (const item of [1]) { new Socket("wss://example.test/structured"); }',
    'for await (const item of []) {} new Socket("wss://example.test/structured");',
    'do { await ready; } while (false); new Socket("wss://example.test/structured");',
    'try { await ready; } finally {} new Socket("wss://example.test/structured");',
    'try {} catch {} finally { await ready; } new Socket("wss://example.test/structured");',
    'for (let i = 0; i < 1; new Socket("wss://example.test/structured"), i++) { await ready; }',
    'const {[await 0]: value} = {}; new Socket("wss://example.test/structured");',
    'const {outer: {[await 0]: value}} = { outer: {} }; new Socket("wss://example.test/structured");',
    'let value; ({[await 0]: value} = {}); new Socket("wss://example.test/structured");',
  ])(
    "carries mandatory structured evaluation into a later read: %s",
    (body) => {
      const expected = [
        { value: "wss://example.test/structured", mechanism: "call:Socket" },
      ];
      expect(
        socketEndpoints(
          `(async () => { ${body} })(); const Socket = globalThis.WebSocket;`,
        ),
      ).toEqual([expected, expected]);
    },
  );

  it.each([
    'for await (const item of [new Socket("wss://example.test/invalid")]) {}',
    'do { break; await ready; } while (false); new Socket("wss://example.test/invalid");',
    'do { if (condition) break; await ready; } while (false); new Socket("wss://example.test/invalid");',
    'for (let i = 0; i < 1; new Socket("wss://example.test/invalid"), i++) { if (condition) continue; await ready; }',
    'try { throw 0; await ready; } finally { new Socket("wss://example.test/invalid"); }',
    'try { if (condition) throw 0; await ready; } catch {} new Socket("wss://example.test/invalid");',
    'const { value = await ready } = { value: 1 }; new Socket("wss://example.test/invalid");',
    'let value; ({[await 0]: value} = { value: new Socket("wss://example.test/invalid") });',
  ])("does not promote skipped/abrupt structured paths: %s", (body) => {
    expect(
      socketEndpoints(
        `(async () => { ${body} })(); const Socket = globalThis.WebSocket;`,
      ),
    ).toEqual([[], []]);
  });

  it.each([
    'const ws = require("ws"); const { WebSocket: Socket } = { WebSocket: ws.WebSocket, later: (ws.WebSocket = class {}) };',
    'const ws = require("ws"); const [Socket] = [ws.WebSocket, (ws.WebSocket = class {})];',
    'const ws = require("ws"); const Saved = ws.WebSocket; ws.WebSocket = class {}; const { copy: Socket } = { copy: Saved };',
  ])(
    "retains a constructor copied before a later export write: %s",
    (capture) => {
      const expected = [
        { value: "wss://example.test/copy", mechanism: "call:Socket" },
      ];
      expect(
        socketEndpoints(`${capture} new Socket("wss://example.test/copy");`),
      ).toEqual([expected, expected]);
    },
  );

  it.each([
    'const ws = require("ws"); const { WebSocket: Socket } = { later: (ws.WebSocket = class {}), WebSocket: ws.WebSocket };',
    'const ws = require("ws"); const { nested: { WebSocket: Socket } } = { nested: ws, later: (ws.WebSocket = class {}) };',
  ])(
    "does not confuse a namespace copy with a constructor copy: %s",
    (capture) => {
      expect(
        socketEndpoints(`${capture} new Socket("wss://example.test/invalid");`),
      ).toEqual([[], []]);
    },
  );
});

describe("web bundle projection kinds, tags and result operands", () => {
  it.each([
    "const [Socket] = { 0: globalThis.WebSocket };",
    "const [[Socket]] = [{ 0: globalThis.WebSocket }];",
    "const { nested: [Socket] } = { nested: { 0: globalThis.WebSocket } };",
  ])("does not substitute object properties for iteration: %s", (capture) => {
    expect(
      socketEndpoints(`${capture} new Socket("wss://example.test/invalid");`),
    ).toEqual([[], []]);
  });

  it.each([
    "const { 0: Socket } = { 0: globalThis.WebSocket };",
    'const { "0": Socket } = [globalThis.WebSocket];',
    "let holder; const Socket = (holder = globalThis.WebSocket);",
    "let holder; const Socket = ((holder = globalThis.WebSocket) as any);",
    'let holder; const Socket = (holder = require("ws").WebSocket);',
    "let holder; const { WebSocket: Socket } = (holder = globalThis);",
  ])("retains exact property and assignment-result captures: %s", (capture) => {
    const expected = [
      { value: "wss://example.test/exact", mechanism: "call:Socket" },
    ];
    expect(
      socketEndpoints(`${capture} new Socket("wss://example.test/exact");`),
    ).toEqual([expected, expected]);
  });

  it.each([
    '(function () { new Socket("wss://example.test/invalid"); })``; const Socket = globalThis.WebSocket;',
    '(() => new Socket("wss://example.test/invalid"))``; const Socket = globalThis.WebSocket;',
    '(function () { new Socket("wss://example.test/invalid"); }).call``; const Socket = globalThis.WebSocket;',
    '(function () { new Socket("wss://example.test/invalid"); }).bind(null)``; const Socket = globalThis.WebSocket;',
    '((function () { new Socket("wss://example.test/invalid"); }) as any)``; const Socket = globalThis.WebSocket;',
    '(function* (strings, x = new Socket("wss://example.test/invalid")) {})``; const Socket = globalThis.WebSocket;',
    '(function* () { new Socket("wss://example.test/invalid"); })``.next(); const Socket = globalThis.WebSocket;',
    'let holder = 0; const Socket = (holder += globalThis.WebSocket); new Socket("wss://example.test/invalid");',
    'let holder = class {}; const Socket = (holder ||= globalThis.WebSocket); new Socket("wss://example.test/invalid");',
  ])("retains eager tag and non-exact assignment boundaries: %s", (source) => {
    expect(socketEndpoints(source)).toEqual([[], []]);
  });

  it.each([
    "`${await ready}`;",
    "`${await ready}${0}`;",
    "(function () {})`${await ready}`;",
    "for (const item of await ready) {}",
    "for (const key in await ready) {}",
  ])(
    "carries mandatory substitutions and iterable evaluation: %s",
    (prefix) => {
      const expected = [
        { value: "wss://example.test/continuation", mechanism: "call:Socket" },
      ];
      expect(
        socketEndpoints(
          `(async () => { ${prefix} new Socket("wss://example.test/continuation"); })(); const Socket = globalThis.WebSocket;`,
        ),
      ).toEqual([expected, expected]);
    },
  );

  it.each([
    'for (const item of await ready) { new Socket("wss://example.test/body"); }',
    'for (const key in await ready) { new Socket("wss://example.test/body"); }',
  ])("carries an awaited iterable into the selected body: %s", (body) => {
    const expected = [
      { value: "wss://example.test/body", mechanism: "call:Socket" },
    ];
    expect(
      socketEndpoints(
        `(async () => { ${body} })(); const Socket = globalThis.WebSocket;`,
      ),
    ).toEqual([expected, expected]);
  });

  it("keeps generator tag bodies deferred until resumption", () => {
    const expected = [
      { value: "wss://example.test/generator", mechanism: "call:Socket" },
    ];
    expect(
      socketEndpoints(
        '(function* () { new Socket("wss://example.test/generator"); })``; const Socket = globalThis.WebSocket;',
      ),
    ).toEqual([expected, expected]);
  });

  it.each([
    "for (const item of []) { await ready; }",
    "for (const key in {}) { await ready; }",
    "`${condition && (await ready)}`;",
  ])("does not promote skipped loop/substitution bodies: %s", (prefix) => {
    expect(
      socketEndpoints(
        `(async () => { ${prefix} new Socket("wss://example.test/invalid"); })(); const Socket = globalThis.WebSocket;`,
      ),
    ).toEqual([[], []]);
  });
});

describe("web bundle mandatory operands and literal projections", () => {
  it.each(["+=", "**=", "<<="])(
    "retains mandatory waits in %s assignments",
    (operator) => {
      expect(
        socketEndpoints(
          `const pending = (async () => { await 0; new Socket("wss://example.test/invalid"); })(); let count = 0; count ${operator} await pending; const Socket = globalThis.WebSocket;`,
        ),
      ).toEqual([[], []]);
    },
  );

  it.each([
    "let count = 0; count += await ready;",
    "let count = 1; count **= await ready;",
    "let count = 0; count <<= await ready;",
    "if (true) await ready;",
    "if (false) {} else await ready;",
    "true ? await ready : 0;",
    "false ? 0 : await ready;",
    "true && (await ready);",
    "false || (await ready);",
    "null ?? (await ready);",
    "(await ready)?.();",
    "(await ready)?.(await other);",
  ])(
    "carries mandatory selected operands into the continuation: %s",
    (prefix) => {
      const expected = [
        { value: "wss://example.test/selected", mechanism: "call:Socket" },
      ];
      expect(
        socketEndpoints(
          `(async () => { ${prefix} new Socket("wss://example.test/selected"); })(); const Socket = globalThis.WebSocket;`,
        ),
      ).toEqual([expected, expected]);
    },
  );

  it.each([
    "if (false) await ready;",
    "unknown ? await ready : 0;",
    "unknown && (await ready);",
    "let value = false; value &&= await ready;",
    "let value = true; value ||= await ready;",
    "let value = 0; value ??= await ready;",
    "null?.(await ready);",
  ])(
    "does not promote unproven branch/assignment/call operands: %s",
    (prefix) => {
      expect(
        socketEndpoints(
          `(async () => { ${prefix} new Socket("wss://example.test/invalid"); })(); const Socket = globalThis.WebSocket;`,
        ),
      ).toEqual([[], []]);
    },
  );

  it.each([
    'import ws = require("ws"); const Socket = ws.WebSocket;',
    'import ws = require("ws"); const { WebSocket: Socket } = ws;',
    'import ws = require("ws"); const alias = ws; const Socket = alias[`WebSocket`];',
    "const [Socket] = [globalThis.WebSocket];",
    "const [, Socket] = [0, globalThis.WebSocket];",
    "const [[Socket]] = [[globalThis.WebSocket]];",
    "const { nested: [Socket] } = { nested: [globalThis.WebSocket] };",
    'const [Socket] = [require("ws").WebSocket];',
  ])(
    "retains exact import-equals members and literal projections: %s",
    (capture) => {
      const expected = [
        { value: "wss://example.test/projected", mechanism: "call:Socket" },
      ];
      expect(
        socketEndpoints(
          `${capture} new Socket("wss://example.test/projected");`,
        ),
      ).toEqual([expected, expected]);
    },
  );

  it.each([
    'import ws = require("other"); const Socket = ws.WebSocket;',
    'import type ws = require("ws"); const Socket = ws.WebSocket;',
    'const Socket = ws.WebSocket; import ws = require("ws");',
    'import ws = require("ws"); ws.WebSocket = class {}; const Socket = ws.WebSocket;',
    'import ws = require("ws"); const alias = ws; alias.WebSocket = class {}; const Socket = ws.WebSocket;',
    // This mutation executes in CommonJS; an unbound ESM require is not a loader.
    'export = {}; import ws = require("ws"); require("ws").WebSocket = class {}; const Socket = ws.WebSocket;',
    "const [Socket] = [...items, globalThis.WebSocket];",
    "const [Socket = globalThis.WebSocket] = [];",
    "const [Socket] = [class {}];",
    "const box = [globalThis.WebSocket]; box[0] = class {}; const [Socket] = box;",
  ])(
    "leaves overwritten and non-exact constructor projections unresolved: %s",
    (capture) => {
      expect(
        socketEndpoints(`${capture} new Socket("wss://example.test/invalid");`),
      ).toEqual([[], []]);
    },
  );

  it("keeps a constructor captured before an import-equals export write", () => {
    const expected = [
      { value: "wss://example.test/prior", mechanism: "call:Socket" },
    ];
    expect(
      socketEndpoints(
        'import ws = require("ws"); const Socket = ws.WebSocket; ws.WebSocket = class {}; new Socket("wss://example.test/prior");',
      ),
    ).toEqual([expected, expected]);
  });
});

describe("web bundle reached waits and exact expression results", () => {
  it.each([
    "if (false) await pending;",
    "false && (await pending);",
    "true || (await pending);",
    "while (false) await pending;",
    "for (; false;) await pending;",
    "if (unknown) await pending;",
  ])(
    "does not let a skipped or unproven wait constrain initialization: %s",
    (wait) => {
      const expected = [
        { value: "wss://example.test/reached", mechanism: "call:Socket" },
      ];
      expect(
        socketEndpoints(
          `const pending = (async () => { await 0; new Socket("wss://example.test/reached"); })(); ${wait} const Socket = globalThis.WebSocket;`,
        ),
      ).toEqual([expected, expected]);
    },
  );

  it.each([
    "if (true) await pending;",
    "if (false) {} else await pending;",
    "false || (await pending);",
    "null ?? (await pending);",
    "if (false) await pending; await pending;",
  ])("retains a proven wait constraint: %s", (wait) => {
    expect(
      socketEndpoints(
        `const pending = (async () => { await 0; new Socket("wss://example.test/invalid"); })(); ${wait} const Socket = globalThis.WebSocket;`,
      ),
    ).toEqual([[], []]);
  });

  it.each([
    "const value = (await ready).value;",
    "const value = object[await ready];",
    "const value = (await ready)?.value;",
  ])("carries completed member operands into a later read: %s", (prefix) => {
    const expected = [
      { value: "wss://example.test/member", mechanism: "call:Socket" },
    ];
    expect(
      socketEndpoints(
        `(async () => { ${prefix} new Socket("wss://example.test/member"); })(); const Socket = globalThis.WebSocket;`,
      ),
    ).toEqual([expected, expected]);
  });

  it.each([
    "null?.[await ready];",
    "null?.value[await ready];",
    "null?.method(await ready);",
  ])("does not promote a skipped optional operand: %s", (prefix) => {
    expect(
      socketEndpoints(
        `(async () => { ${prefix} new Socket("wss://example.test/invalid"); })(); const Socket = globalThis.WebSocket;`,
      ),
    ).toEqual([[], []]);
  });

  it.each(["globalThis?.WebSocket", "globalThis?.[`WebSocket`]"])(
    "retains a non-null ambient capture: %s",
    (capture) => {
      const expected = [
        { value: "wss://example.test/optional", mechanism: "call:Socket" },
      ];
      expect(
        socketEndpoints(
          `const Socket = ${capture}; new Socket("wss://example.test/optional");`,
        ),
      ).toEqual([expected, expected]);
    },
  );

  it.each([
    'const globalThis = {}; const Socket = globalThis?.WebSocket; new Socket("wss://example.test/invalid");',
    'globalThis.WebSocket = class {}; const Socket = globalThis?.WebSocket; new Socket("wss://example.test/invalid");',
    'let connect; (connect = () => new Socket("wss://example.test/invalid"))(); const Socket = globalThis.WebSocket;',
    'let connect; ((connect = function () { new Socket("wss://example.test/invalid"); }) as any).call(null); const Socket = globalThis.WebSocket;',
    'let Client; new (Client = class { socket = new Socket("wss://example.test/invalid"); })(); const Socket = globalThis.WebSocket;',
  ])(
    "rejects overwritten identities and eager assignment results: %s",
    (source) => {
      expect(socketEndpoints(source)).toEqual([[], []]);
    },
  );

  it("retains a stored assignment result as deferred", () => {
    const expected = [
      {
        value: "wss://example.test/stored-assignment",
        mechanism: "call:Socket",
      },
    ];
    expect(
      socketEndpoints(
        'let connect; connect = () => new Socket("wss://example.test/stored-assignment"); const Socket = globalThis.WebSocket; connect();',
      ),
    ).toEqual([expected, expected]);
  });
});

describe("web bundle constructor captures before repeating writes", () => {
  it.each([
    "for (const item of items) { ws.WebSocket = class {}; }",
    "for (const item in items) { ws.WebSocket = class {}; }",
    "while (condition) { ws.WebSocket = class {}; }",
    "do { ws.WebSocket = class {}; } while (condition);",
    "for (const item of items) { for (const child of item) { ws.WebSocket = class {}; } }",
  ])(
    "retains a constructor already captured before the whole loop: %s",
    (loop) => {
      const expected = [
        { value: "wss://example.test/captured-loop", mechanism: "call:Socket" },
      ];
      expect(
        socketEndpoints(
          `const ws = require("ws"); const Socket = ws.WebSocket; ${loop} new Socket("wss://example.test/captured-loop");`,
        ),
      ).toEqual([expected, expected]);
    },
  );

  it.each([
    'const ws = require("ws"); for (const item of items) { const Socket = ws.WebSocket; ws.WebSocket = class {}; new Socket("wss://example.test/local"); }',
    'const ws = require("ws"); for (const item of items) { ws.WebSocket = class {}; } const Socket = ws.WebSocket; new Socket("wss://example.test/local");',
    'const ws = require("ws"); const alias = ws; for (const item of items) { ws.WebSocket = class {}; } new alias.WebSocket("wss://example.test/local");',
  ])(
    "keeps repeated captures and later namespace selections unresolved: %s",
    (source) => {
      expect(socketEndpoints(source)).toEqual([[], []]);
    },
  );
});

describe("web bundle API classification parity", () => {
  it("reads storage open versions as storage rather than endpoints in both analyzers", () => {
    const source = `
      indexedDB.open(databaseName, "2");
      window.indexedDB.open(databaseName, "/v3");
      indexedDB.open("APP", "4");
      indexedDB.open("GET", "/storage-named-xhr");
    `;
    expect(
      analyzeWebBundleFixture(inspection(source)).observations.endpoints.map(
        ({ value }) => value,
      ),
    ).toEqual(["/storage-named-xhr"]);
    const analysis = analyzeJavaScriptStaticSource(source);
    expect(analysis.endpoints.map(({ value }) => value)).toEqual([
      "/storage-named-xhr",
    ]);
    expect(analysis.storage.map(({ kind }) => kind)).toEqual([
      "indexed-db",
      "indexed-db",
      "indexed-db",
      "indexed-db",
    ]);
  });

  it("uses lexical receiver facts for overloaded open calls", () => {
    const result = analyzeWebBundleFixture(
      inspection(`
        const popup = window;
        popup.open(url, "/preview");
        {
          const indexedDB = { open() {} };
          indexedDB.open("PROPFIND", "/dav");
          indexedDB.open(databaseName, "2");
        }
        const xhr = new XMLHttpRequest();
        xhr.open(method, "/api");
      `),
    );
    expect(
      result.observations.endpoints.map(({ value }) => value).sort(),
    ).toEqual(["/api", "/dav"]);
  });

  it("classifies optional and one-hop aliased open calls", () => {
    const source = `
      const popup = window;
      popup?.open(url, "/preview");
      const idb = indexedDB;
      idb.open(databaseName, "2");
      const xhr = new XMLHttpRequest();
      xhr?.open(method, "/api");
    `;
    const bundle = analyzeWebBundleFixture(inspection(source));
    expect(bundle.observations.endpoints.map(({ value }) => value)).toEqual([
      "/api",
    ]);
    const staticAnalysis = analyzeJavaScriptStaticSource(source);
    expect(staticAnalysis.endpoints.map(({ value }) => value)).toEqual([
      "/api",
    ]);
    expect(staticAnalysis.storage.map(({ kind }) => kind)).toEqual([
      "indexed-db",
    ]);
  });

  it("keeps HTTP-method-named reads of provable keyed collections out of endpoints", () => {
    const result = analyzeWebBundleFixture(
      inspection(`
        axios.get("https://api.example.test/users");
        api.get("users");
        client.delete("cache-key");
        new Map().get("map-key");
        new URLSearchParams(location.search).get("q");
        new Headers(init).delete("x-trace");
        new FormData(form).get("file");
        response.headers.get("content-type");
        request?.headers.delete("cookie");
        new URL(location.href).searchParams.get("page");
        api.headers.post("/v1/headers");
        api.searchParams.request("/search");
        new Headers().get("/users");
        api.headers.get("https://api.example.test/headers");
        api.searchParams.delete("../search");
      `),
    );
    expect(
      result.observations.endpoints.map(({ value }) => value).sort(),
    ).toEqual(["/search", "/v1/headers"]);
    expect(
      result.inferences
        .filter(({ kind }) => kind === "endpoint_candidate")
        .map(({ value }) => value)
        .sort(),
    ).toEqual([
      "../search",
      "/users",
      "cache-key",
      "https://api.example.test/headers",
      "https://api.example.test/users",
      "users",
    ]);
  });

  it("keeps undici header-store reads out of endpoint observations", () => {
    const result = analyzeWebBundleFixture(
      inspection(`
        response.headersList.get("location", true);
        request.headersList.delete("authorization");
        request.headersList.get("/header-list");
        api.get("/api/users");
      `),
    );
    expect(result.observations.endpoints).toEqual([]);
    expect(
      result.inferences
        .filter(({ kind }) => kind === "endpoint_candidate")
        .map(({ value }) => value),
    ).toEqual(["/header-list", "/api/users"]);
  });
});

describe("web bundle explicit request reference forms", () => {
  it("recognizes URL, path, query and fragment forms after excluding lookup receivers", () => {
    const references = [
      "http://api.example.test/users",
      "https://api.example.test/users?q=1#part",
      "ws://api.example.test/events",
      "wss://api.example.test/events",
      "http:api.example.test/users",
      "https:api.example.test/users?q=1&tag=a&tag=b#part",
      "https:api.example.test:443/a/../b?x=a+b&x=two#part",
      "ws:api.example.test/events",
      "wss:api.example.test/events",
      "HtTpS:/api.example.test/users",
      String.raw`https:\api.example.test\users`,
      "https://[invalid",
      "//api.example.test/users",
      "/api/users",
      "./users",
      "../users",
      "?",
      "?page=2&tag=a&tag=b#section",
      "#",
      "#section",
      "#frag?tag=a&tag=b",
    ];
    const ambiguous = [
      "",
      ".",
      "..",
      "users",
      "%23section",
      "%3Fpage=2",
      " #section",
      " https:api.example.test/users",
      "https:",
      "http:?page=2",
      "ws:#section",
      "https:[invalid",
      "https:api.example.test:99999",
      "ftp:api.example.test/users",
      "file:/users",
      "data:text/plain,users",
    ];
    const source = `
      ${references.map((value) => `api.get(${JSON.stringify(value)});`).join("\n")}
      ${ambiguous.map((value) => `api.get(${JSON.stringify(value)});`).join("\n")}
      xhr.open(method, "?view=1");
      xhr.open(method, "#view=1");
      xhr.open("GET", "#literal=1");
      xhr.open(method, "https:api.example.test/xhr");
      request("POST", target);
      snackBar.open(message, "X");
      new Map().get("?map-key");
      new Map().get("#map-key");
      new Map().get("https:api.example.test/map-key");
      new Headers().delete("?header-key");
      new Headers().delete("#header-key");
      new URLSearchParams().get("?parameter-key");
      new URLSearchParams().get("#parameter-key");
      response.headers.get("?response-key");
      response.headers.get("#response-key");
      const config = vscode.workspace.getConfiguration("git");
      config.get("?setting");
      config.get("#setting");
      config.get("https:api.example.test/setting");
      window.open(url, "?window-target");
      window.open(url, "#window-target");
      indexedDB.open(name, "?database-version");
      indexedDB.open(name, "#database-version");
      caches.open(name, "#cache-name");
      fs.open(path, "r");
    `;
    const expected = [
      "?view=1",
      "#view=1",
      "#literal=1",
      "https:api.example.test/xhr",
    ].sort();
    const expectedCandidates = [
      ...references,
      ...ambiguous,
      "POST",
      "X",
    ].sort();
    const web = analyzeWebBundleFixture(inspection(source));
    expect(web.observations.endpoints.map(({ value }) => value).sort()).toEqual(
      expected,
    );
    expect(
      web.inferences
        .filter(({ kind }) => kind === "endpoint_candidate")
        .map(({ value }) => value)
        .sort(),
    ).toEqual(expectedCandidates);
    const analyzed = analyzeJavaScriptStaticSource(source);
    expect(
      analyzed.endpoints
        .filter(({ interpretation }) => interpretation === undefined)
        .map(({ value }) => value)
        .sort(),
    ).toEqual(expected);
    expect(
      analyzed.endpoints
        .filter(({ interpretation }) => interpretation === "candidate")
        .map(({ value }) => value)
        .sort(),
    ).toEqual(expectedCandidates);
  });
});

describe("web bundle endpoint candidate classification", () => {
  it("keeps ambiguous HTTP-method arguments as candidates instead of endpoint observations", () => {
    const source = `
      fetch("login");
      api.get("/api/users");
      api.get("users");
      form.get("passwordControl");
      translate.get("ADDRESS_ADDED");
      cookieService.put("token", value);
      http.request("POST", target);
      snackBar.open(message, "X");
      xhr.open(method, "login");
      xhr.open("GET", "ping");
    `;
    const result = analyzeWebBundleFixture(inspection(source));
    expect(
      result.observations.endpoints.map(({ value }) => value).sort(),
    ).toEqual(["login", "ping"]);
    const candidates = result.inferences.filter(
      ({ kind }) => kind === "endpoint_candidate",
    );
    expect(candidates.map(({ value }) => value).sort()).toEqual([
      "/api/users",
      "ADDRESS_ADDED",
      "POST",
      "X",
      "login",
      "passwordControl",
      "token",
      "users",
    ]);
    expect(
      candidates.every(
        ({ confidence, basis }) =>
          confidence === "low" &&
          basis.length === 1 &&
          basis[0]?.artifact_sha256 ===
            createWebTextArtifact(source, "text/javascript").sha256 &&
          basis[0]?.line !== null &&
          basis[0]?.detector.startsWith("call:"),
      ),
    ).toBe(true);
    const staticEndpoints = analyzeJavaScriptStaticSource(source).endpoints;
    expect(
      staticEndpoints
        .filter(({ interpretation }) => interpretation === "candidate")
        .map(({ value }) => value)
        .sort(),
    ).toEqual(candidates.map(({ value }) => value).sort());
    expect(
      staticEndpoints
        .filter(({ interpretation }) => interpretation === undefined)
        .map(({ value }) => value)
        .sort(),
    ).toEqual(result.observations.endpoints.map(({ value }) => value).sort());
    expect(webBundleAnalysisSchema.parse(result)).toEqual(result);
  });

  it("deduplicates repeated candidate sites while keeping script, value and detector identity", () => {
    const source = `${'form.get("name");\n'.repeat(5_000)}translate.get("name");\nform.get("other");`;
    const captured = inspection(source);
    const first = captured.scripts.items[0];
    if (first === undefined) throw new Error("Missing captured script fixture");
    const secondKey = `scr_${"2".repeat(64)}`;
    const result = analyzeWebBundleFixture({
      ...captured,
      scripts: {
        total: 2,
        items: [
          first,
          {
            ...first,
            script_key: secondKey,
            url: `${origin}/assets/second.js`,
          },
        ],
      },
    });
    const candidates = result.inferences.filter(
      ({ kind }) => kind === "endpoint_candidate",
    );
    expect(candidates).toHaveLength(6);
    for (const scriptKey of [first.script_key, secondKey]) {
      const local = candidates.filter(
        ({ basis }) => basis[0]?.script_key === scriptKey,
      );
      expect(
        local.map(({ value, basis }) => [value, basis[0]?.detector]),
      ).toEqual([
        ["name", "call:form.get:unverified-network-receiver"],
        ["name", "call:translate.get:unverified-network-receiver"],
        ["other", "call:form.get:unverified-network-receiver"],
      ]);
      expect(local[0]?.basis[0]).toMatchObject({
        line: 1,
        column: 0,
        artifact_sha256: createWebTextArtifact(source, "text/javascript")
          .sha256,
      });
    }
    expect(result.observations.endpoints).toEqual([]);
    expect(result.capture.source_artifacts).toHaveLength(2);
    expect(result.completeness).toMatchObject({
      status: "complete",
      parsed_scripts: 2,
    });
    expect(result.limitations).toContain(
      'Endpoint candidates are deduplicated by script, value and detector; basis retains only the first matching source coordinate. They are not a complete call-site inventory or a runtime occurrence count. completeness.status="complete" describes examination of captured source, not a call-site census.',
    );
  });
});

describe("web bundle configuration and navigation parity", () => {
  it("keeps configuration setting reads out of endpoints in both analyzers", () => {
    const source = `
      import vscodeDefault from "vscode";
      vscodeDefault.workspace.getConfiguration("git").get("default-setting");
      vscode.workspace.getConfiguration("git").get("autofetch");
      workspace.getConfiguration("git").get("enabled", true);
      const config = vscode.workspace.getConfiguration("git");
      config.get("autofetchPeriod", 180);
      config.get("/v1/settings");
      let c = Mt.workspace.getConfiguration("git", uri), l = c.get("timeline.date");
      let changed = vscode.workspace.getConfiguration("git");
      changed = api;
      changed.get("reassigned");
      const maybe = flag ? vscode.workspace.getConfiguration("git") : api;
      maybe.get("conditional");
      {
        const config = api;
        config.get("shadowed");
      }
      api.get("users");
      const client = getConfiguration("/api/v1");
      client.get("accounts");
      http.getConfiguration(baseUrl).get("orders");
      {
        const workspace = { getConfiguration: () => api };
        workspace.getConfiguration("/api").get("local-users");
      }
      {
        const vscode = { workspace: { getConfiguration: () => api } };
        vscode.workspace.getConfiguration("/api").get("local-orders");
      }
    `;
    const expected = [
      "/v1/settings",
      "accounts",
      "conditional",
      "local-orders",
      "local-users",
      "orders",
      "reassigned",
      "shadowed",
      "users",
    ];
    const web = analyzeWebBundleFixture(inspection(source));
    expect(web.observations.endpoints).toEqual([]);
    expect(
      web.inferences
        .filter(({ kind }) => kind === "endpoint_candidate")
        .map(({ value }) => value)
        .sort(),
    ).toEqual(expected);
    expect(
      analyzeJavaScriptStaticSource(source)
        .endpoints.map(({ value }) => value)
        .sort(),
    ).toEqual(expected);
  });

  it("classifies proven VS Code extension state reads as non-endpoints", () => {
    const reads = `
      context.globalState.get("lastVersion");
      this.workspaceState.get("closedRepositories", []);
      context?.globalState.get("onboarded");
      context.globalState.get("/v1/state");
      context.secrets.get("token");
      api.get("users");
    `;
    const analyze = (source: string) => {
      const web = analyzeWebBundleFixture(inspection(source));
      const staticAnalysis = analyzeJavaScriptStaticSource(source);
      return {
        web: {
          endpoints: web.observations.endpoints
            .map(({ value }) => value)
            .sort(),
          candidates: web.inferences
            .filter(({ kind }) => kind === "endpoint_candidate")
            .map(({ value }) => value)
            .sort(),
        },
        application: {
          endpoints: staticAnalysis.endpoints
            .filter(({ interpretation }) => interpretation === undefined)
            .map(({ value }) => value)
            .sort(),
          candidates: staticAnalysis.endpoints
            .filter(({ interpretation }) => interpretation === "candidate")
            .map(({ value }) => value)
            .sort(),
        },
      };
    };
    const proven = {
      endpoints: [],
      candidates: ["/v1/state", "token", "users"],
    };
    expect(analyze(`const vscode = require("vscode");${reads}`)).toEqual({
      web: proven,
      application: proven,
    });
    expect(analyze(`import * as vscode from "vscode";${reads}`)).toEqual({
      web: proven,
      application: proven,
    });
    const unproven = {
      endpoints: [],
      candidates: [
        "/v1/state",
        "closedRepositories",
        "lastVersion",
        "onboarded",
        "token",
        "users",
      ],
    };
    expect(analyze(`const vscode = require("./vscode");${reads}`)).toEqual({
      web: unproven,
      application: unproven,
    });
  });

  it("recognizes loadURL endpoints like static analysis", () => {
    const result = analyzeWebBundleFixture(
      inspection('window.win.loadURL("https://embedded.test/app");'),
    );
    expect(result.observations.endpoints).toContainEqual(
      expect.objectContaining({ value: "https://embedded.test/app" }),
    );
  });
});

describe("web bundle artifact metadata", () => {
  it("retains only a validated HTTP target origin", () => {
    expect(
      analyzeWebBundleFixture(inspection("export {};")).capture.target_origin,
    ).toBe(origin);

    const nonHttp = inspection("export {};");
    nonHttp.target.url = "ftp://host/app";
    nonHttp.target.origin = "ftp://host";
    expect(analyzeWebBundleFixture(nonHttp).capture.target_origin).toBeNull();
  });

  it("preserves long provider media types in artifact summaries", () => {
    const result = analyzeWebBundleFixture(inspection("export {};"));
    const mediaType = `application/${"x".repeat(300)}`;
    const artifact = result.capture.source_artifacts[0] ?? {
      sha256: "0".repeat(64),
      bytes: 0,
      media_type: "application/javascript",
      charset: "utf-8" as const,
      text_available: true as const,
    };

    expect(
      webBundleAnalysisSchema.parse({
        ...result,
        capture: {
          ...result.capture,
          source_artifacts: [{ ...artifact, media_type: mediaType }],
        },
      }).capture.source_artifacts[0]?.media_type,
    ).toBe(mediaType);
  });
});

describe("deep captured web bundle syntax", () => {
  it("retains evidence after a parser-admitted deep property chain", () => {
    const source = `const value = root${".next".repeat(12_000)};\nimport "./last.js";\nfetch("/after");`;
    const result = analyzeWebBundleFixture(inspection(source));
    expect(result.completeness).toMatchObject({
      status: "complete",
      parsed_scripts: 1,
      parse_failures: 0,
    });
    expect(result.observations.chunks.edges).toContainEqual(
      expect.objectContaining({
        kind: "static_import",
        specifier: "./last.js",
        resolved_url: `${origin}/assets/last.js`,
        location: expect.objectContaining({ line: 2, column: 0 }),
      }),
    );
    expect(result.observations.endpoints).toContainEqual(
      expect.objectContaining({
        value: "/after",
        location: expect.objectContaining({ line: 3, column: 0 }),
      }),
    );
  });
});

const inspection = (source: string) =>
  createWebPageInspection([
    {
      source,
      scriptKey: `scr_${"1".repeat(64)}`,
      url: `${origin}/assets/app.js`,
      origin,
      cdpHash: "hash",
    },
  ]);

describe("per-script web bundle analysis", () => {
  it("keeps parser failures as analyzed outcomes with their own coverage", () => {
    const captured = inspection("function broken( {");
    const script = captured.scripts.items.find(isIncludedScript);
    if (script === undefined)
      throw new Error("Missing included script fixture");

    expect(analyzeCapturedWebScript(script)).toMatchObject({
      status: "analyzed",
      script_key: script.script_key,
      parse_status: "failed",
      visited_ast_nodes: 0,
      observations: {
        edges: [],
        routes: [],
        endpoints: [],
        webmcp_declarations: [],
      },
    });
  });

  it("merges out-of-order worker outcomes in capture order and preserves exact unavailable keys", () => {
    const firstCapture = inspection("import './first.js'; fetch('/first');");
    const secondCapture = inspection("import './second.js'; fetch('/second');");
    const first = firstCapture.scripts.items.find(isIncludedScript);
    const second = secondCapture.scripts.items.find(isIncludedScript);
    if (first === undefined || second === undefined)
      throw new Error("Missing included script fixtures");
    const captured = firstCapture;
    captured.scripts.items.push({ ...second, script_key: "second-script" });
    captured.scripts.total += 1;

    const result = buildCapturedWebBundleAnalysis(
      captured,
      {
        status: "not_requested",
        requested: 0,
        processed: 0,
        items: [],
      },
      [
        {
          status: "unavailable",
          script_key: "second-script",
          reason: "deadline",
          detail: "Worker deadline expired.",
        },
        analyzeCapturedWebScript(first),
      ],
    );

    expect(
      result.observations.chunks.edges.map(({ specifier }) => specifier),
    ).toEqual(["./first.js"]);
    expect(result.observations.endpoints.map(({ value }) => value)).toEqual([
      "/first",
    ]);
    expect(result.unknowns).toContainEqual({
      dimension: "javascript_analysis",
      reason: expect.stringContaining("deadline"),
      affected_script_keys: ["second-script"],
    });
    expect(result.completeness).toMatchObject({
      status: "partial",
      parsed_scripts: 1,
      parse_failures: 0,
    });
  });

  it("does not count explicitly unstarted scripts as submitted and reports source budget omissions", () => {
    const captured = inspection("fetch('/started');");
    const script = captured.scripts.items.find(isIncludedScript);
    if (script === undefined)
      throw new Error("Missing included script fixture");
    const later = { ...script, script_key: "not-started-script" };
    captured.scripts.items.push(later);
    captured.scripts.total += 1;
    captured.completeness.excluded.push({
      section: "script_sources",
      reason: "resource_budget_exhausted",
      count: 2,
    });

    const result = buildCapturedWebBundleAnalysis(
      captured,
      {
        status: "not_requested",
        requested: 0,
        processed: 0,
        items: [],
      },
      [
        analyzeCapturedWebScript(script),
        {
          status: "unavailable",
          script_key: "not-started-script",
          reason: "not_started",
        },
      ],
    );

    expect(result.capture.scripts_analyzed).toBe(1);
    expect(result.completeness.status).toBe("partial");
    expect(result.unknowns).toContainEqual({
      dimension: "script_source",
      reason: expect.stringContaining("omitted 2 script source artifacts"),
      affected_script_keys: [],
    });
    expect(result.unknowns).toContainEqual({
      dimension: "javascript_analysis",
      reason: expect.stringContaining("not_started"),
      affected_script_keys: ["not-started-script"],
    });
  });
});

describe("unavailable web bundle analysis outcomes", () => {
  it("preserves distinct unavailable reasons and details with their exact script keys", () => {
    const captured = inspection("fetch('/started');");
    const first = captured.scripts.items.find(isIncludedScript);
    if (first === undefined) throw new Error("Missing included script fixture");
    const keys = ["deadline-second", "deadline-different", "resource-failure"];
    for (const script_key of keys)
      captured.scripts.items.push({ ...first, script_key });
    captured.scripts.total += keys.length;

    const result = buildCapturedWebBundleAnalysis(
      captured,
      {
        status: "not_requested",
        requested: 0,
        processed: 0,
        items: [],
      },
      [
        {
          status: "unavailable",
          script_key: first.script_key,
          reason: "not_started",
          detail: "Total analysis deadline expired after 50 ms.",
        },
        {
          status: "unavailable",
          script_key: "deadline-second",
          reason: "not_started",
          detail: "Total analysis deadline expired after 50 ms.",
        },
        {
          status: "unavailable",
          script_key: "deadline-different",
          reason: "deadline",
          detail: "Per-script deadline expired after 10 ms.",
        },
        {
          status: "unavailable",
          script_key: "resource-failure",
          reason: "resource_constraint",
          detail: "Worker result exceeded its byte budget.",
        },
      ],
    );

    expect(
      result.unknowns.filter(
        ({ dimension }) => dimension === "javascript_analysis",
      ),
    ).toEqual([
      {
        dimension: "javascript_analysis",
        reason:
          'Analysis was unavailable for captured scripts (not_started); findings from those scripts are unknown. Worker detail: "Total analysis deadline expired after 50 ms."',
        affected_script_keys: [first.script_key, "deadline-second"],
      },
      {
        dimension: "javascript_analysis",
        reason:
          'Analysis was unavailable for captured scripts (deadline); findings from those scripts are unknown. Worker detail: "Per-script deadline expired after 10 ms."',
        affected_script_keys: ["deadline-different"],
      },
      {
        dimension: "javascript_analysis",
        reason:
          'Analysis was unavailable for captured scripts (resource_constraint); findings from those scripts are unknown. Worker detail: "Worker result exceeded its byte budget."',
        affected_script_keys: ["resource-failure"],
      },
    ]);
  });
});

it("requires every result reference to belong to its script key", () => {
  const captured = inspection(
    "import './module.js'; const routes = [{ path: '/known' }]; fetch('/api'); form.get('candidate'); document.modelContext.registerTool({ name: 'lookup' });",
  );
  const script = captured.scripts.items.find(isIncludedScript);
  if (script === undefined) throw new Error("Missing included script fixture");
  const outcome = analyzeCapturedWebScript(script);
  if (outcome.status !== "analyzed")
    throw new Error("Expected a completed script analysis fixture");
  const result = outcome;
  expect(webBundleScriptAnalysisSchema.parse(result)).toEqual(result);
  expect(result.observations.edges.length).toBeGreaterThan(0);
  expect(result.observations.routes.length).toBeGreaterThan(0);
  expect(result.observations.endpoints.length).toBeGreaterThan(0);
  expect(result.observations.webmcp_declarations.length).toBeGreaterThan(0);
  expect(result.inferences.length).toBeGreaterThan(0);

  const wrongEdgeSource = {
    ...result,
    observations: {
      ...result.observations,
      edges: result.observations.edges.map((edge, index) =>
        index === 0 ? { ...edge, from_script_key: "another-script" } : edge,
      ),
    },
  };
  const wrongEdgeLocation = {
    ...result,
    observations: {
      ...result.observations,
      edges: result.observations.edges.map((edge, index) =>
        index === 0
          ? {
              ...edge,
              location: { ...edge.location, script_key: "another-script" },
            }
          : edge,
      ),
    },
  };
  const wrongFindingLocation = {
    ...result,
    observations: {
      ...result.observations,
      endpoints: result.observations.endpoints.map((finding, index) =>
        index === 0
          ? {
              ...finding,
              location: {
                ...finding.location,
                script_key: "another-script",
              },
            }
          : finding,
      ),
    },
  };
  const wrongRouteLocation = {
    ...result,
    observations: {
      ...result.observations,
      routes: result.observations.routes.map((finding, index) =>
        index === 0
          ? {
              ...finding,
              location: {
                ...finding.location,
                script_key: "another-script",
              },
            }
          : finding,
      ),
    },
  };
  const wrongWebMcpLocation = {
    ...result,
    observations: {
      ...result.observations,
      webmcp_declarations: result.observations.webmcp_declarations.map(
        (declaration, index) =>
          index === 0
            ? {
                ...declaration,
                location: {
                  ...declaration.location,
                  script_key: "another-script",
                },
              }
            : declaration,
      ),
    },
  };
  const wrongInferenceBasis = {
    ...result,
    inferences: result.inferences.map((inference, inferenceIndex) =>
      inferenceIndex === 0
        ? {
            ...inference,
            basis: inference.basis.map((basis, basisIndex) =>
              basisIndex === 0
                ? { ...basis, script_key: "another-script" }
                : basis,
            ),
          }
        : inference,
    ),
  };

  expect(webBundleScriptAnalysisSchema.safeParse(wrongEdgeSource).success).toBe(
    false,
  );
  expect(
    webBundleScriptAnalysisSchema.safeParse(wrongEdgeLocation).success,
  ).toBe(false);
  expect(
    webBundleScriptAnalysisSchema.safeParse(wrongFindingLocation).success,
  ).toBe(false);
  expect(
    webBundleScriptAnalysisSchema.safeParse(wrongRouteLocation).success,
  ).toBe(false);
  expect(
    webBundleScriptAnalysisSchema.safeParse(wrongWebMcpLocation).success,
  ).toBe(false);
  expect(
    webBundleScriptAnalysisSchema.safeParse(wrongInferenceBasis).success,
  ).toBe(false);
});

it("rejects a failed parse that claims visited nodes or derived facts", () => {
  const malformed =
    inspection("function broken( {").scripts.items.find(isIncludedScript);
  const valid =
    inspection("fetch('/api');").scripts.items.find(isIncludedScript);
  if (malformed === undefined || valid === undefined)
    throw new Error("Missing parse result fixtures");
  const failedOutcome = analyzeCapturedWebScript(malformed);
  const parsedOutcome = analyzeCapturedWebScript(valid);
  if (
    failedOutcome.status !== "analyzed" ||
    parsedOutcome.status !== "analyzed"
  )
    throw new Error("Expected completed script analysis fixtures");
  const failed = failedOutcome;
  const parsed = parsedOutcome;

  expect(webBundleScriptAnalysisSchema.parse(failed)).toEqual(failed);
  expect(
    webBundleScriptAnalysisSchema.safeParse({
      ...failed,
      visited_ast_nodes: 1,
    }).success,
  ).toBe(false);
  expect(
    webBundleScriptAnalysisSchema.safeParse({
      ...failed,
      widened_return_references: true,
    }).success,
  ).toBe(false);
  expect(
    webBundleScriptAnalysisSchema.safeParse({
      ...failed,
      observations: {
        ...failed.observations,
        endpoints: parsed.observations.endpoints,
      },
    }).success,
  ).toBe(false);
});

it("recognizes expression-free template literals as route properties", () => {
  const result = analyzeWebBundleFixture(
    inspection(`
      const routes = [
        { path: \`score-board\`, component: ScoreBoard },
        { route: \`administration\`, component: Admin },
        { path: \`/user/\${name}\`, component: Dynamic },
      ];
    `),
  );

  expect(result.observations.routes.map(({ value }) => value)).toEqual([
    "score-board",
    "administration",
  ]);
});

it("uses the shared parser for decorated captured scripts", () => {
  const result = analyzeWebBundleFixture(
    inspection(`@sealed class Widget {} fetch('/decorated');`),
  );

  expect(result.completeness).toMatchObject({
    status: "complete",
    parsed_scripts: 1,
    parse_failures: 0,
  });
  expect(result.observations.endpoints).toEqual([
    expect.objectContaining({ value: "/decorated" }),
  ]);
});

it("keeps bare module locations unresolved without inventing URL-relative paths", () => {
  const result = analyzeWebBundleFixture(
    inspection(`
    import "package-name";
    import("@scope/package");
    require("package-name");
    import "./actual.js";
    importScripts("worker.js");
  `),
  );
  for (const specifier of ["package-name", "@scope/package"])
    expect(
      result.observations.chunks.edges
        .filter((edge) => edge.specifier === specifier)
        .every((edge) => edge.resolved_url === null),
    ).toBe(true);
  expect(
    result.observations.chunks.edges.find(
      (edge) => edge.specifier === "./actual.js",
    )?.resolved_url,
  ).toBe(`${origin}/assets/actual.js`);
  expect(
    result.observations.chunks.edges.find(
      (edge) => edge.specifier === "worker.js",
    )?.resolved_url,
  ).toBe(`${origin}/assets/worker.js`);
});

it("retains each literal importScripts argument in source order", () => {
  const result = analyzeWebBundleFixture(
    inspection(
      'importScripts("first.js", dynamicValue, "second.js", "first.js");',
    ),
  );
  expect(
    result.observations.chunks.edges
      .filter(({ kind }) => kind === "worker_import")
      .map(({ specifier }) => specifier),
  ).toEqual(["first.js", "second.js"]);
});

describe("web metadata key semantics", () => {
  it("keeps computed metadata keys and overwrite order conservative", () => {
    const result = analyzeWebBundleFixture(
      inspection(`
      const path = "description";
      const routes = [{ [path]: "/not-a-route" }, { ["path"]: "/real" }];
      document.modelContext.registerTool({
        name: "old", name: "new",
        inputSchema: { properties: { [name]: {}, literal: {} } }
      });
      document.modelContext.registerTool({ name: "old", ...dynamic });
      document.modelContext.registerTool({ name: "old", [name]: "dynamic" });
      document.modelContext.registerTool({ name: "old", get name() {} });
      document.modelContext.registerTool({ ...dynamic, ["name"]: "restored" });
      document.modelContext.registerTool({ name: "valid", [""]: 0 });
    `),
    );

    expect(result.observations.routes.map(({ value }) => value)).toEqual([
      "/real",
    ]);
    expect(result.observations.webmcp_declarations).toEqual([
      expect.objectContaining({
        name: "new",
        schema_property_names: ["literal"],
        schema_property_names_coverage: "partial",
      }),
      expect.objectContaining({
        name: null,
        schema_property_names_coverage: "unknown",
      }),
      expect.objectContaining({
        name: null,
        schema_property_names_coverage: "not_present",
      }),
      expect.objectContaining({
        name: "restored",
        schema_property_names_coverage: "unknown",
      }),
      expect.objectContaining({
        name: "valid",
        schema_property_names_coverage: "not_present",
      }),
    ]);
  });

  it("projects only exact input schema property names", () => {
    const result = analyzeWebBundleFixture(
      inspection(`
      document.modelContext.registerTool({
        name: "literal",
        inputSchema: {
          type: "object",
          properties: { type: {}, properties: {}, "": {}, [dynamicKey]: {}, ...dynamicProperties }
        }
      });
      document.modelContext.registerTool({ name: "missing properties", inputSchema: { type: "object" } });
      document.modelContext.registerTool({ name: "dynamic properties", inputSchema: { properties: dynamicProperties } });
      document.modelContext.registerTool({ name: "null properties", inputSchema: { properties: null } });
      document.modelContext.registerTool({ name: "missing schema" });
      document.modelContext.registerTool({ name: "dynamic schema", inputSchema: schema });
      document.modelContext.registerTool({ name: "null schema", inputSchema: null });
      document.modelContext.registerTool({ name: "spread schema", inputSchema: { ...schema } });
      document.modelContext.registerTool({
        name: "computed literal keys",
        ["inputSchema"]: { ["properties"]: { [""]: {}, ["literal"]: {}, [dynamicKey]: {} } }
      });
    `),
    );

    expect(
      result.observations.webmcp_declarations.map(
        ({ name, schema_property_names, schema_property_names_coverage }) => ({
          name,
          schema_property_names,
          schema_property_names_coverage,
        }),
      ),
    ).toEqual([
      {
        name: "literal",
        schema_property_names: ["", "properties", "type"],
        schema_property_names_coverage: "partial",
      },
      {
        name: "missing properties",
        schema_property_names: [],
        schema_property_names_coverage: "not_present",
      },
      {
        name: "dynamic properties",
        schema_property_names: [],
        schema_property_names_coverage: "unknown",
      },
      {
        name: "null properties",
        schema_property_names: [],
        schema_property_names_coverage: "unknown",
      },
      {
        name: "missing schema",
        schema_property_names: [],
        schema_property_names_coverage: "not_present",
      },
      {
        name: "dynamic schema",
        schema_property_names: [],
        schema_property_names_coverage: "unknown",
      },
      {
        name: "null schema",
        schema_property_names: [],
        schema_property_names_coverage: "not_present",
      },
      {
        name: "spread schema",
        schema_property_names: [],
        schema_property_names_coverage: "unknown",
      },
      {
        name: "computed literal keys",
        schema_property_names: ["", "literal"],
        schema_property_names_coverage: "partial",
      },
    ]);
  });

  it("keeps missing coverage absent when parsing historical observations", () => {
    const analyzed = analyzeWebBundleFixture(
      inspection(
        `document.modelContext.registerTool({ name: "legacy", inputSchema: { properties: {} } });`,
      ),
    );
    const declaration = analyzed.observations.webmcp_declarations[0];
    expect(declaration).toBeDefined();
    if (declaration === undefined) throw new Error("Expected declaration");
    const { schema_property_names_coverage: _coverage, ...legacyDeclaration } =
      declaration;
    const parsed = webBundleAnalysisSchema.parse({
      ...analyzed,
      observations: {
        ...analyzed.observations,
        webmcp_declarations: [legacyDeclaration],
      },
    });
    expect(
      Object.hasOwn(
        parsed.observations.webmcp_declarations[0] ?? {},
        "schema_property_names_coverage",
      ),
    ).toBe(false);
  });
});

it("retains WebMCP declarations through optional member and call chaining", () => {
  const result = analyzeWebBundleFixture(
    inspection(`
      document.modelContext?.registerTool({ name: "optional member" });
      document.modelContext.registerTool?.({ name: "optional call" });
    `),
  );

  expect(result.observations.webmcp_declarations).toEqual([
    expect.objectContaining({
      name: "optional member",
      trust: "page-declared-untrusted",
    }),
    expect.objectContaining({
      name: "optional call",
      trust: "page-declared-untrusted",
    }),
  ]);
});

it("reads expression-free template dynamic imports as chunk edges", () => {
  const result = analyzeWebBundleFixture(
    inspection(`
        import(\`./lazy.js\`);
        import("./quoted.js");
        import(\`./\${name}.js\`);
      `),
  );

  expect(result.observations.chunks.edges).toEqual([
    expect.objectContaining({
      kind: "dynamic_import",
      specifier: "./lazy.js",
      resolved_url: `${origin}/assets/lazy.js`,
    }),
    expect.objectContaining({
      kind: "dynamic_import",
      specifier: "./quoted.js",
    }),
  ]);
});

it("does not infer call names from dynamic computed identifiers", () => {
  const result = analyzeWebBundleFixture(
    inspection(`
        const fetch = "render";
        const require = "render";
        const registerTool = "render";
        window[fetch]("/render-only");
        window[require]("./not-a-module.js");
        document.modelContext[registerTool]({ name: "not-a-tool" });
      `),
  );

  expect(result.observations.endpoints).toEqual([]);
  expect(result.observations.chunks.edges).toEqual([]);
  expect(result.observations.webmcp_declarations).toEqual([]);
});

it("retains direct and literal computed call names", () => {
  const result = analyzeWebBundleFixture(
    inspection(`
        window.fetch("/direct");
        window["fetch"]("/literal");
    window[receiver].fetch("/nested-receiver");
        window.require("./direct.js");
        window["require"]("./literal.js");
        document.modelContext["registerTool"]({ name: "literal-tool" });
      `),
  );

  expect(result.observations.endpoints.map(({ value }) => value)).toEqual([
    "/direct",
    "/literal",
    "/nested-receiver",
  ]);
  expect(
    result.observations.chunks.edges.map(({ specifier }) => specifier),
  ).toEqual(["./direct.js", "./literal.js"]);
  expect(result.observations.webmcp_declarations).toEqual([
    expect.objectContaining({ name: "literal-tool" }),
  ]);
});

it("requires WebMCP receiver and method names to occupy exact member segments", () => {
  const result = analyzeWebBundleFixture(
    inspection(`
      navigator.modelContext.registerTool({ name: "navigator" });
      local.modelContext.registerTool({ name: "exact nested" });
      const appmodelContext = { registerTool() {} };
      appmodelContext.registerTool({ name: "receiver suffix" });
      const app = { analyticsmodelContext: { registerTool() {} } };
      app.analyticsmodelContext.registerTool({ name: "nested suffix" });
      window["modelContext.registerTool"]({ name: "dotted property" });
      window["modelContext"].registerTool({ name: "computed receiver" });
    `),
  );

  expect(result.observations.webmcp_declarations).toEqual([
    expect.objectContaining({ name: "navigator" }),
    expect.objectContaining({ name: "exact nested" }),
    expect.objectContaining({ name: "computed receiver" }),
  ]);
});

it("recognizes tRPC procedures and named GraphQL operations in captured scripts", () => {
  const result = analyzeWebBundleFixture(
    inspection(`
      const n = createTRPCClient({ links: [httpBatchLink({ url: "/api/trpc" })] });
      e.invoice.list.useQuery({ competencia: "2026-09" });
      n.empresa.byCnpj.query("00000000000191");
      const q = "query ListarNotas($competencia: String!) { notas { id } }";
      this.client.query({ query: q });
    `),
  );
  expect(
    result.observations.endpoints.map(({ value, mechanism }) => ({
      value,
      mechanism,
    })),
  ).toEqual([
    { value: "/api/trpc", mechanism: "trpc:link:httpBatchLink" },
    { value: "invoice.list", mechanism: "trpc:procedure:useQuery" },
    { value: "empresa.byCnpj", mechanism: "trpc:procedure:query" },
    { value: "ListarNotas", mechanism: "graphql:query" },
  ]);
});

it("keeps RPC lexical identity and bundled factory recognition in captured scripts", () => {
  const longOperation = "Operation" + "x".repeat(512);
  const document =
    "#" +
    "comment".repeat(700) +
    "\nquery " +
    longOperation +
    " { users { id } }";
  const result = analyzeWebBundleFixture(
    inspection(`
    function first() { const c = createTRPCClient({}); }
    function unrelated(c) { c.users.query("select 1"); }
    const c = (0, t.createTRPCClient)({ links: [(0, t.httpBatchLink)({ url: "/api/rpc" })] });
    c.posts.query();
    const doc = ${JSON.stringify(document)};
  `),
  );
  expect(
    result.observations.endpoints.map(({ value, mechanism }) => ({
      value,
      mechanism,
    })),
  ).toEqual([
    { value: "/api/rpc", mechanism: "trpc:link:httpBatchLink" },
    { value: "posts", mechanism: "trpc:procedure:query" },
    { value: longOperation, mechanism: "graphql:query" },
  ]);
  expect(result.completeness.status).toBe("complete");
});

it("retains distinct WebMCP descriptions and names while deduplicating equivalent properties", () => {
  const result = analyzeWebBundleFixture(
    inspection(`
      document.modelContext.registerTool({ name: "lookup", description: "first", inputSchema: { properties: { alpha: {} } } });
      document.modelContext.registerTool({ name: "lookup", description: "second", inputSchema: { properties: { alpha: {} } } });
      document.modelContext.registerTool({ name: "equivalent", inputSchema: { properties: { alpha: {}, beta: {} } } });
      document.modelContext.registerTool({ name: "equivalent", inputSchema: { properties: { beta: {}, alpha: {}, alpha: {} } } });
      document.modelContext.registerTool({ name: "empty-status", inputSchema: { properties: {} } });
      document.modelContext.registerTool({ name: "empty-status", inputSchema: { properties: dynamicProperties } });
      document.modelContext.registerTool({ description: "unnamed" });
      document.modelContext.registerTool({ name: "", description: "unnamed" });
    `),
  );

  expect(
    result.observations.webmcp_declarations.map(
      ({
        name,
        description,
        schema_property_names,
        schema_property_names_coverage,
      }) => ({
        name,
        description,
        schema_property_names,
        schema_property_names_coverage,
      }),
    ),
  ).toEqual([
    {
      name: "lookup",
      description: "first",
      schema_property_names: ["alpha"],
      schema_property_names_coverage: "complete",
    },
    {
      name: "lookup",
      description: "second",
      schema_property_names: ["alpha"],
      schema_property_names_coverage: "complete",
    },
    {
      name: "equivalent",
      description: null,
      schema_property_names: ["alpha", "beta"],
      schema_property_names_coverage: "complete",
    },
    {
      name: "empty-status",
      description: null,
      schema_property_names: [],
      schema_property_names_coverage: "complete",
    },
    {
      name: "empty-status",
      description: null,
      schema_property_names: [],
      schema_property_names_coverage: "unknown",
    },
    {
      name: null,
      description: "unnamed",
      schema_property_names: [],
      schema_property_names_coverage: "not_present",
    },
    {
      name: "",
      description: "unnamed",
      schema_property_names: [],
      schema_property_names_coverage: "not_present",
    },
  ]);
  expect(result.observations.webmcp_declarations[2]?.location).toEqual({
    script_key: `scr_${"1".repeat(64)}`,
    line: 4,
    column: 6,
  });
  expect(
    result.observations.webmcp_declarations.every(
      ({ trust }) => trust === "page-declared-untrusted",
    ),
  ).toBe(true);
});

const exactReturnedPromiseAndClassPhaseCases = [
  {
    name: "fresh static class method",
    source:
      "(class { static run() { new Socket('wss://example.test/review-phase') } }).run(); const Socket = globalThis.WebSocket;",
    present: false,
  },
  {
    name: "literal wrapper returned promise",
    source:
      "(async () => { const pending = (async () => { await 0; new Socket('wss://example.test/review-phase') })(); await (() => pending)(); const Socket = globalThis.WebSocket; })();",
    present: false,
  },
  {
    name: "labeled suspension",
    source:
      "(async () => { label: { await 0; } new Socket('wss://example.test/review-phase') })(); const Socket = globalThis.WebSocket;",
    present: true,
  },
  {
    name: "awaited abrupt finally entry",
    source:
      "(async () => { try { throw await 0; } finally { new Socket('wss://example.test/review-phase') } })(); const Socket = globalThis.WebSocket;",
    present: true,
  },
  {
    name: "destructured promise identity",
    source:
      "export {}; const { pending } = { pending: import('ws') }; const { WebSocket: Socket } = await pending; new Socket('wss://example.test/review-phase');",
    present: true,
  },
  {
    name: "instance auto accessor",
    source:
      "const Client = class { accessor socket = new Socket('wss://example.test/review-phase') }; const Socket = globalThis.WebSocket; new Client();",
    present: true,
  },
  {
    name: "JSX child suspension",
    source:
      "(async () => { <div>{await ready}</div>; new Socket('wss://example.test/review-phase'); })(); const Socket = globalThis.WebSocket;",
    present: true,
  },
  {
    name: "computed static method",
    source:
      "(class { static [`run`]() { new Socket('wss://example.test/review-phase') } })[`run`](); const Socket = globalThis.WebSocket;",
    present: false,
  },
  {
    name: "static method call wrapper",
    source:
      "(class { static run() { new Socket('wss://example.test/review-phase') } }).run.call(null); const Socket = globalThis.WebSocket;",
    present: false,
  },
  {
    name: "async static continuation",
    source:
      "(class { static async run() { await 0; new Socket('wss://example.test/review-phase') } }).run(); const Socket = globalThis.WebSocket;",
    present: true,
  },
  {
    name: "unresumed generator method",
    source:
      "(class { static *run() { new Socket('wss://example.test/review-phase') } }).run(); const Socket = globalThis.WebSocket;",
    present: true,
  },
  {
    name: "stored class method",
    source:
      "const run = (class { static run() { new Socket('wss://example.test/review-phase') } }).run; const Socket = globalThis.WebSocket; run();",
    present: true,
  },
  {
    name: "field initialization after methods",
    source:
      "(class { static run = () => new Socket('wss://example.test/review-phase'); static run() {} }).run(); const Socket = globalThis.WebSocket;",
    present: false,
  },
  {
    name: "overridden method remains deferred",
    source:
      "(class { static run = () => {}; static run() { new Socket('wss://example.test/review-phase') } }).run(); const Socket = globalThis.WebSocket;",
    present: true,
  },
  {
    name: "label breaks before suspension",
    source:
      "(async () => { label: { break label; await 0; } new Socket('wss://example.test/review-phase'); })(); const Socket = globalThis.WebSocket;",
    present: false,
  },
  {
    name: "label suspends before break",
    source:
      "(async () => { label: { await 0; break label; } new Socket('wss://example.test/review-phase'); })(); const Socket = globalThis.WebSocket;",
    present: true,
  },
  {
    name: "labeled stored function does not suspend",
    source:
      "(async () => { label: { const run = async () => await 0; } new Socket('wss://example.test/review-phase'); })(); const Socket = globalThis.WebSocket;",
    present: false,
  },
  {
    name: "awaited return enters finally",
    source:
      "(async () => { try { return await 0; } finally { new Socket('wss://example.test/review-phase'); } })(); const Socket = globalThis.WebSocket;",
    present: true,
  },
  {
    name: "throw before unreachable await",
    source:
      "(async () => { try { throw 0; await 0; } finally { new Socket('wss://example.test/review-phase'); } })(); const Socket = globalThis.WebSocket;",
    present: false,
  },
  {
    name: "throwing operand before await",
    source:
      "(async () => { try { throw (missing(), await 0); } finally { new Socket('wss://example.test/review-phase'); } })(); const Socket = globalThis.WebSocket;",
    present: false,
  },
  {
    name: "await before throwing operand",
    source:
      "(async () => { try { throw (await 0, missing()); } finally { new Socket('wss://example.test/review-phase'); } })(); const Socket = globalThis.WebSocket;",
    present: true,
  },
  {
    name: "nested promise projection",
    source:
      "export {}; const { box: { pending } } = { box: { pending: import('ws') } }; const { WebSocket: Socket } = await pending; new Socket('wss://example.test/review-phase');",
    present: true,
  },
  {
    name: "array promise projection",
    source:
      "export {}; const [pending] = [import('ws')]; const { WebSocket: Socket } = await pending; new Socket('wss://example.test/review-phase');",
    present: true,
  },
  {
    name: "getter promise stays unknown",
    source:
      "export {}; const { pending } = { get pending() { return import('ws') } }; const { WebSocket: Socket } = await pending; new Socket('wss://example.test/review-phase');",
    present: false,
  },
  {
    name: "changed iteration stays unknown",
    source:
      "export {}; Array.prototype[Symbol.iterator] = function* () { yield Promise.resolve({ WebSocket: class {} }); }; const [pending] = [import('ws')]; const { WebSocket: Socket } = await pending; new Socket('wss://example.test/review-phase');",
    present: false,
  },
  {
    name: "ordinary wrapper return",
    source:
      "(async () => { const pending = (async () => { await 0; new Socket('wss://example.test/review-phase'); })(); await (function () { return pending; })(); const Socket = globalThis.WebSocket; })();",
    present: false,
  },
  {
    name: "nested literal wrapper returns",
    source:
      "(async () => { const pending = (async () => { await 0; new Socket('wss://example.test/review-phase'); })(); await (() => (() => pending)())(); const Socket = globalThis.WebSocket; })();",
    present: false,
  },
  {
    name: "forward wrapper alias is not initialized",
    source:
      "(async () => { try { await (() => pending)(); } catch {} const pending = (async () => { await 0; new Socket('wss://example.test/review-phase'); })(); const Socket = globalThis.WebSocket; })();",
    present: true,
  },
  {
    name: "JSX attribute suspension",
    source:
      "(async () => { <div value={await ready} />; new Socket('wss://example.test/review-phase'); })(); const Socket = globalThis.WebSocket;",
    present: true,
  },
  {
    name: "JSX fragment suspension",
    source:
      "(async () => { <><div />{await ready}</>; new Socket('wss://example.test/review-phase'); })(); const Socket = globalThis.WebSocket;",
    present: true,
  },
  {
    name: "JSX spread suspension",
    source:
      "(async () => { <div {...await ready} />; new Socket('wss://example.test/review-phase'); })(); const Socket = globalThis.WebSocket;",
    present: true,
  },
  {
    name: "JSX stored function does not suspend",
    source:
      "(async () => { <div>{async () => await ready}</div>; new Socket('wss://example.test/review-phase'); })(); const Socket = globalThis.WebSocket;",
    present: false,
  },
  {
    name: "static auto accessor is eager",
    source:
      "const Client = class { static accessor socket = new Socket('wss://example.test/review-phase') }; const Socket = globalThis.WebSocket;",
    present: false,
  },
  {
    name: "immediate auto accessor construction",
    source:
      "new (class { accessor socket = new Socket('wss://example.test/review-phase') })(); const Socket = globalThis.WebSocket;",
    present: false,
  },
  {
    name: "private auto accessor is deferred",
    source:
      "const Client = class { accessor #socket = new Socket('wss://example.test/review-phase') }; const Socket = globalThis.WebSocket; new Client();",
    present: true,
  },
];

describe("web bundle exact returned promises and class phases", () => {
  it.each(exactReturnedPromiseAndClassPhaseCases)(
    "preserves $name in both source consumers",
    ({ source, present }) => {
      const values = socketEndpoints(source).map((items) =>
        items.map((item) => item.value),
      );
      const expected = present ? ["wss://example.test/review-phase"] : [];
      expect(values).toEqual([expected, expected]);
    },
  );
});

const freshReadAndIterationCases = [
  [
    "object getter call",
    '({ get run() { new Socket("wss://example.test/fresh-read"); return () => {}; } }).run();',
    false,
  ],
  [
    "object getter read",
    'void ({ get run() { new Socket("wss://example.test/fresh-read"); return () => {}; } }).run;',
    false,
  ],
  [
    "paired getter and setter",
    'void ({ get run() { new Socket("wss://example.test/fresh-read"); }, set run(value) {} }).run;',
    false,
  ],
  [
    "static getter read",
    'void (class { static get run() { new Socket("wss://example.test/fresh-read"); } }).run;',
    false,
  ],
  [
    "fresh instance method",
    '(new (class { run() { new Socket("wss://example.test/fresh-read"); } })()).run();',
    false,
  ],
  [
    "fresh instance getter",
    'void (new (class { get run() { new Socket("wss://example.test/fresh-read"); } })()).run;',
    false,
  ],
  [
    "fresh instance function field",
    '(new (class { run = () => new Socket("wss://example.test/fresh-read"); })()).run();',
    false,
  ],
  [
    "instance method shadowed by field",
    '(new (class { run() { new Socket("wss://example.test/fresh-read"); } run = () => {}; })()).run();',
    true,
  ],
  [
    "stored instance method",
    'const run = (new (class { run() { new Socket("wss://example.test/fresh-read"); } })()).run;',
    true,
  ],
  [
    "synchronous generator for-of",
    'for (const ignored of (function* () { new Socket("wss://example.test/fresh-read"); yield 0; })()) {}',
    false,
  ],
  [
    "synchronous generator after yield",
    'for (const ignored of (function* () { yield 0; new Socket("wss://example.test/fresh-read"); })()) {}',
    false,
  ],
  [
    "getter precedes awaited call argument",
    '(async () => { ({ get run() { new Socket("wss://example.test/fresh-read"); return () => {}; } }).run(await 0); })();',
    false,
  ],
  [
    "method follows awaited call argument",
    '(async () => { (new (class { run() { new Socket("wss://example.test/fresh-read"); } })()).run(await 0); })();',
    true,
  ],
  [
    "generator consumer awaits between steps",
    '(async () => { for (const ignored of (function* () { yield 0; new Socket("wss://example.test/fresh-read"); })()) { await 0; } })();',
    true,
  ],
  [
    "generator consumer conditionally awaits",
    '(async () => { for (const ignored of (function* () { yield 0; new Socket("wss://example.test/fresh-read"); })()) { if (condition) await 0; } })();',
    false,
  ],
  [
    "async generator first step",
    '(async () => { for await (const ignored of (async function* () { new Socket("wss://example.test/fresh-read"); yield 0; })()) {} })();',
    false,
  ],
  [
    "generator consumer yields between steps",
    '(function* () { for (const ignored of (function* () { yield 0; new Socket("wss://example.test/fresh-read"); })()) { yield 0; } })().next();',
    true,
  ],
  [
    "generator consumer pattern awaits",
    '(async () => { for (const [value = await 0] of (function* () { yield []; new Socket("wss://example.test/fresh-read"); })()) {} })();',
    true,
  ],
  [
    "getter returned callable",
    '({ get run() { return () => new Socket("wss://example.test/fresh-read"); } }).run();',
    false,
  ],
  [
    "stored getter returned callable",
    'const run = ({ get run() { return () => new Socket("wss://example.test/fresh-read"); } }).run;',
    true,
  ],
  [
    "getter returned callable follows awaited argument",
    '(async () => { ({ get run() { return () => new Socket("wss://example.test/fresh-read"); } }).run(await 0); })();',
    true,
  ],
  [
    "unresumed generator",
    '(function* () { new Socket("wss://example.test/fresh-read"); yield 0; })();',
    true,
  ],
] as const;

describe("fresh member reads and synchronous generator consumption", () => {
  it.each(freshReadAndIterationCases)(
    "preserves %s in both source consumers",
    (_name, prefix, present) => {
      const source = `${prefix} const Socket = globalThis.WebSocket;`;
      const expected = present ? ["wss://example.test/fresh-read"] : [];
      expect(
        socketEndpoints(source).map((items) => items.map(({ value }) => value)),
      ).toEqual([expected, expected]);
    },
  );
});

const completionReviewCases = [
  {
    name: "immutable assignment",
    source:
      'const holder = 0; new (holder = globalThis.WebSocket)("wss://example.test/review-latest");',
    present: false,
  },
  {
    name: "spread generator",
    source:
      '[...(function* () { new Socket("wss://example.test/review-latest"); yield 0; })()]; const Socket = globalThis.WebSocket;',
    present: false,
  },
  {
    name: "caught prefix skips wait",
    source:
      '(async () => { const pending = (async () => { await ready; new Socket("wss://example.test/review-latest"); })(); try { null.value; await pending; } catch {} const Socket = globalThis.WebSocket; })();',
    present: true,
  },
  {
    name: "with body suspension",
    source:
      '(async () => { with ({}) { await ready; } new Socket("wss://example.test/review-latest"); })(); const Socket = globalThis.WebSocket;',
    present: true,
  },
  {
    name: "global self member",
    source:
      'new globalThis.globalThis.WebSocket("wss://example.test/review-latest");',
    present: true,
  },
  {
    name: "computed expression key before value write",
    source:
      'const ws = require("ws"); const object = { [new ws.WebSocket("wss://example.test/review-latest")]: (ws.WebSocket = class {}) };',
    present: true,
  },
  {
    name: "async disposal between yields",
    source:
      '(async () => { for (const item of (function* () { yield 0; new Socket("wss://example.test/review-latest"); })()) { await using resource = null; } })(); const Socket = globalThis.WebSocket;',
    present: true,
  },
  {
    name: "mutable let assignment",
    source:
      'let holder; new (holder = globalThis.WebSocket)("wss://example.test/review-latest");',
    present: true,
  },
  {
    name: "hoisted var assignment",
    source:
      'new (holder = globalThis.WebSocket)("wss://example.test/review-latest"); var holder;',
    present: true,
  },
  {
    name: "lexical assignment before initialization",
    source:
      'new (holder = globalThis.WebSocket)("wss://example.test/review-latest"); let holder;',
    present: false,
  },
  {
    name: "readonly selected object assignment",
    source:
      'const holder = 0; const { WebSocket: Socket } = (holder = globalThis); new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    name: "mutable selected object assignment",
    source:
      'let holder; const { WebSocket: Socket } = (holder = globalThis); new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    name: "unproven setter assignment",
    source:
      'const holder = { set socket(value) { throw 0; } }; new (holder.socket = globalThis.WebSocket)("wss://example.test/review-latest");',
    present: false,
  },
  {
    name: "spread generator after yield",
    source:
      '[...(function* () { yield 0; new Socket("wss://example.test/review-latest"); })()]; const Socket = globalThis.WebSocket;',
    present: false,
  },
  {
    name: "call spread generator",
    source:
      'consume(...(function* () { yield 0; new Socket("wss://example.test/review-latest"); })()); const Socket = globalThis.WebSocket;',
    present: false,
  },
  {
    name: "construct spread generator",
    source:
      'new Target(...(function* () { new Socket("wss://example.test/review-latest"); yield 0; })()); const Socket = globalThis.WebSocket;',
    present: false,
  },
  {
    name: "object spread does not iterate",
    source:
      '({...(function* () { new Socket("wss://example.test/review-latest"); yield 0; })()}); const Socket = globalThis.WebSocket;',
    present: true,
  },
  {
    name: "stored generator after initialization",
    source:
      'const iterator = (function* () { yield 0; new Socket("wss://example.test/review-latest"); })(); const Socket = globalThis.WebSocket; [...iterator];',
    present: true,
  },
  {
    name: "sync disposal does not suspend",
    source:
      '(async () => { for (const item of (function* () { yield 0; new Socket("wss://example.test/review-latest"); })()) { using resource = null; } })(); const Socket = globalThis.WebSocket;',
    present: false,
  },
  {
    name: "async disposal cannot delay first yield",
    source:
      '(async () => { for (const item of (function* () { new Socket("wss://example.test/review-latest"); yield 0; })()) { await using resource = null; } })(); const Socket = globalThis.WebSocket;',
    present: false,
  },
  {
    name: "stored async disposal does not suspend",
    source:
      '(async () => { for (const item of (function* () { yield 0; new Socket("wss://example.test/review-latest"); })()) { const later = async () => { await using resource = null; }; } })(); const Socket = globalThis.WebSocket;',
    present: false,
  },
  {
    name: "with no suspension",
    source:
      '(async () => { with ({}) { 0; } new Socket("wss://example.test/review-latest"); })(); const Socket = globalThis.WebSocket;',
    present: false,
  },
  {
    name: "with stored async function",
    source:
      '(async () => { with ({}) { const later = async () => await ready; } new Socket("wss://example.test/review-latest"); })(); const Socket = globalThis.WebSocket;',
    present: false,
  },
  {
    name: "repeated global self path",
    source:
      'new globalThis.globalThis.globalThis.WebSocket("wss://example.test/review-latest");',
    present: true,
  },
  {
    name: "self path constructor capture",
    source:
      'const Socket = globalThis.self.globalThis.WebSocket; new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    name: "shadowed global self path",
    source:
      'const globalThis = {globalThis: {WebSocket: class {}}}; new globalThis.globalThis.WebSocket("wss://example.test/review-latest");',
    present: false,
  },
  {
    name: "overwritten global self path",
    source:
      'globalThis.globalThis.WebSocket = class {}; new globalThis.globalThis.WebSocket("wss://example.test/review-latest");',
    present: false,
  },
  {
    name: "overwritten self reference",
    source:
      'globalThis.self = {WebSocket: class {}}; new globalThis.self.WebSocket("wss://example.test/review-latest");',
    present: false,
  },
  {
    name: "arbitrary global property",
    source:
      'new globalThis.custom.WebSocket("wss://example.test/review-latest");',
    present: false,
  },
  {
    name: "computed key after earlier write",
    source:
      'const ws = require("ws"); const object = { [(ws.WebSocket = class {})]: new ws.WebSocket("wss://example.test/review-latest") };',
    present: false,
  },
  {
    name: "computed key keeps earlier capture",
    source:
      'const ws = require("ws"); const Socket = ws.WebSocket; const object = { [new Socket("wss://example.test/review-latest")]: (ws.WebSocket = class {}) };',
    present: true,
  },
  {
    name: "nonthrowing caught prefix still waits",
    source:
      '(async () => { const pending = (async () => { await ready; new Socket("wss://example.test/review-latest"); })(); try { 0; await pending; } catch {} const Socket = globalThis.WebSocket; })();',
    present: false,
  },
  {
    name: "caught sequence prefix skips wait",
    source:
      '(async () => { const pending = (async () => { await ready; new Socket("wss://example.test/review-latest"); })(); try { (null.value, await pending); } catch {} const Socket = globalThis.WebSocket; })();',
    present: true,
  },
  {
    name: "caught await operand skips wait",
    source:
      '(async () => { const pending = (async () => { await ready; new Socket("wss://example.test/review-latest"); })(); try { await (null.value, pending); } catch {} const Socket = globalThis.WebSocket; })();',
    present: true,
  },
  {
    name: "stored function prefix cannot throw",
    source:
      '(async () => { const pending = (async () => { await ready; new Socket("wss://example.test/review-latest"); })(); try { const later = () => null.value; await pending; } catch {} const Socket = globalThis.WebSocket; })();',
    present: false,
  },
];

describe("web bundle completed writes and consumer suspension", () => {
  it.each(completionReviewCases)(
    "preserves $name in both consumers",
    ({ source, present }) => {
      const expected = present ? ["wss://example.test/review-latest"] : [];
      expect(
        socketEndpoints(source).map((items) => items.map((item) => item.value)),
      ).toEqual([expected, expected]);
    },
  );
});

const scopeExitReviewCases = [
  {
    name: "block disposal",
    source:
      '(async () => { { await using resource = null; } new Socket("wss://example.test/review-scope"); })(); const Socket = globalThis.WebSocket;',
    present: true,
  },
  {
    name: "producer created in caught block",
    source:
      'export {}; try { const pending = (async () => { await 0; new Socket("wss://example.test/review-scope"); })(); await pending; const Socket = globalThis.WebSocket; } catch {}',
    present: false,
  },
  {
    name: "outer mutable assignment invocation",
    source:
      'let connect; (() => { (connect = () => new Socket("wss://example.test/review-scope"))(); })(); const Socket = globalThis.WebSocket;',
    present: false,
  },
  {
    name: "loop head assignment",
    source:
      'for (let holder of [new (holder = globalThis.WebSocket)("wss://example.test/review-scope")]) {}',
    present: false,
  },
  {
    name: "destructuring generator",
    source:
      'const [ignored] = (function* () { new Socket("wss://example.test/review-scope"); yield 0; })(); const Socket = globalThis.WebSocket;',
    present: false,
  },
  {
    name: "selected switch test suspension",
    source:
      '(async () => { switch (kind) { case await ready: new Socket("wss://example.test/review-scope"); } })(); const Socket = globalThis.WebSocket;',
    present: true,
  },
  {
    name: "optional literal arguments",
    source:
      '(async () => { (async (_x) => { new Socket("wss://example.test/review-scope"); })?.(await ready); })(); const Socket = globalThis.WebSocket;',
    present: true,
  },
  {
    name: "disposal has not exited",
    source:
      '(async()=>{await using resource=null;new Socket("wss://example.test/review-scope")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "synchronous block disposal",
    source:
      '(async()=>{{using resource=null;}new Socket("wss://example.test/review-scope")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "stored disposal scope",
    source:
      '(async()=>{const later=async()=>{await using resource=null;};new Socket("wss://example.test/review-scope")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "skipped disposal block",
    source:
      '(async()=>{if(false){await using resource=null;}new Socket("wss://example.test/review-scope")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "taken disposal block",
    source:
      '(async()=>{if(true){await using resource=null;}new Socket("wss://example.test/review-scope")})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "throw before same-block producer",
    source:
      'export {};try{null.value;const pending=(async()=>{await 0;new Socket("wss://example.test/review-scope")})();await pending;const Socket=globalThis.WebSocket;}catch{}',
    present: false,
  },
  {
    name: "throw after same-block producer",
    source:
      'export {};try{const pending=(async()=>{await 0;new Socket("wss://example.test/review-scope")})();null.value;await pending;}catch{}const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "throw after producer in same declaration",
    source:
      'export {};try{const pending=(async()=>{await 0;new Socket("wss://example.test/review-scope")})(), tail=null.value;await pending;}catch{}const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "safe prefix before same-block producer",
    source:
      'export {};try{0;const pending=(async()=>{await 0;new Socket("wss://example.test/review-scope")})();await pending;const Socket=globalThis.WebSocket;}catch{}',
    present: false,
  },
  {
    name: "outer var assignment invocation",
    source:
      'var connect;(()=>{(connect=()=>new Socket("wss://example.test/review-scope"))()})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "outer let assignment after alias initialization",
    source:
      'const Socket=globalThis.WebSocket;let connect;(()=>{(connect=()=>new Socket("wss://example.test/review-scope"))()})();',
    present: true,
  },
  {
    name: "for-in loop head assignment",
    source:
      'for(let holder in { [new(holder=globalThis.WebSocket)("wss://example.test/review-scope")]:0}){}',
    present: false,
  },
  {
    name: "var loop head assignment",
    source:
      'for(var holder of [new(holder=globalThis.WebSocket)("wss://example.test/review-scope")]){}',
    present: true,
  },
  {
    name: "initialized loop body assignment",
    source:
      'for(let holder of [0]){new(holder=globalThis.WebSocket)("wss://example.test/review-scope")}',
    present: true,
  },
  {
    name: "array hole consumes first resume",
    source:
      'const [,ignored]=(function*(){new Socket("wss://example.test/review-scope");yield 0})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "assignment pattern consumes generator",
    source:
      'let ignored;[ignored]=(function*(){new Socket("wss://example.test/review-scope");yield 0})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "rest pattern drains generator",
    source:
      'const [...ignored]=(function*(){yield 0;new Socket("wss://example.test/review-scope")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "two pattern elements resume in same turn",
    source:
      'const [a,b]=(function*(){yield 0;new Socket("wss://example.test/review-scope");yield 1})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "empty array pattern only closes iterator",
    source:
      'const []=(function*(){new Socket("wss://example.test/review-scope");yield 0})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "object pattern does not iterate",
    source:
      'const {}=(function*(){new Socket("wss://example.test/review-scope");yield 0})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "stored generator consumed after alias",
    source:
      'const iterator=(function*(){new Socket("wss://example.test/review-scope");yield 0})();const Socket=globalThis.WebSocket;const [ignored]=iterator;',
    present: true,
  },
  {
    name: "pattern default can suspend before next resume",
    source:
      '(async()=>{const [a=await ready,b]=(function*(){yield undefined;new Socket("wss://example.test/review-scope");yield 1})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "switch fallthrough skips selected test",
    source:
      '(async()=>{switch(kind){case 0:case await ready:new Socket("wss://example.test/review-scope")}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "switch predecessor break prevents fallthrough",
    source:
      '(async()=>{switch(kind){case 0:break;case await ready:new Socket("wss://example.test/review-scope")}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "optional literal call without argument wait",
    source:
      '(async()=>{(async x=>{new Socket("wss://example.test/review-scope")})?.(0)})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "optional argument stores an async function",
    source:
      '(async()=>{(async x=>{new Socket("wss://example.test/review-scope")})?.(async()=>await ready)})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "skipped optional arguments do not suspend siblings",
    source:
      '(async()=>{null?.(await ready);new Socket("wss://example.test/review-scope")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
];
describe("web bundle scope exit and relative producer order", () => {
  it.each(scopeExitReviewCases)(
    "preserves $name in both consumers",
    ({ source, present }) => {
      const expected = present ? ["wss://example.test/review-scope"] : [];
      expect(
        socketEndpoints(source).map((items) => items.map((item) => item.value)),
      ).toEqual([expected, expected]);
    },
  );
});

const consumptionReviewCases = [
  {
    name: "later pattern default",
    source:
      '(async()=>{const [a,b=await 0,c]=(function*(){yield 0;new Socket("wss://example.test/review-consumption");yield undefined;yield 2})()})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "getter write target",
    source:
      '({get run(){new Socket("wss://example.test/review-consumption")}}).run=0;const Socket=globalThis.WebSocket;',
    present: true,
    runtimePresent: false,
  },
  {
    name: "throwing sequence prefix",
    source:
      'new(null.value,globalThis.WebSocket)("wss://example.test/review-consumption");',
    present: false,
  },
  {
    name: "optional call sibling",
    source:
      '(async()=>{(()=>{})?.(await ready);new Socket("wss://example.test/review-consumption")})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "conditional break bypass",
    source:
      '(async()=>{const pending=(async()=>{await ready;new Socket("wss://example.test/review-consumption")})();while(true){if(skip)break;await pending;break;}const Socket=globalThis.WebSocket;})();',
    present: true,
  },
  {
    name: "async wrapper adoption",
    source:
      '(async()=>{const pending=(async()=>{await ready;new Socket("wss://example.test/review-consumption")})();await(async()=>pending)();const Socket=globalThis.WebSocket;})();',
    present: false,
  },
  {
    name: "resumed generator delegate",
    source:
      '(function*(){yield*(function*(){new Socket("wss://example.test/review-consumption");yield 0})()})().next();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "earlier selected default",
    source:
      '(async()=>{const [a=await 0,b]=(function*(){yield undefined;new Socket("wss://example.test/review-consumption");yield 1})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "unselected earlier default",
    source:
      '(async()=>{const [a=await 0,b]=(function*(){yield 0;new Socket("wss://example.test/review-consumption");yield 1})()})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "first resume before default",
    source:
      '(async()=>{const [a=await 0]=(function*(){new Socket("wss://example.test/review-consumption");yield undefined})()})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "stored async default does not suspend",
    source:
      '(async()=>{const [a=async()=>await 0,b]=(function*(){yield undefined;new Socket("wss://example.test/review-consumption");yield 1})()})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "argumentless yield selects default",
    source:
      '(async()=>{const [a=await 0,b]=(function*(){yield;new Socket("wss://example.test/review-consumption");yield 1})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "selected default before rest drain",
    source:
      '(async()=>{const [a=await 0,...rest]=(function*(){yield undefined;yield 0;new Socket("wss://example.test/review-consumption")})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "getter direct read",
    source:
      '({get run(){new Socket("wss://example.test/review-consumption")}}).run;const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "getter compound write reads first",
    source:
      '({get run(){new Socket("wss://example.test/review-consumption")}}).run+=0;const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "getter delete target",
    source:
      'delete({get run(){new Socket("wss://example.test/review-consumption")}}).run;const Socket=globalThis.WebSocket;',
    present: true,
    runtimePresent: false,
  },
  {
    name: "getter destructuring write",
    source:
      '[({get run(){new Socket("wss://example.test/review-consumption")}}).run]=[0];const Socket=globalThis.WebSocket;',
    present: true,
    runtimePresent: false,
  },
  {
    name: "getter nested receiver is read",
    source:
      '({get run(){new Socket("wss://example.test/review-consumption")}}).run.value=0;const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "getter optional delete target",
    source:
      'delete({get run(){new Socket("wss://example.test/review-consumption")}})?.run;const Socket=globalThis.WebSocket;',
    present: true,
    runtimePresent: false,
  },
  {
    name: "literal sequence prefix",
    source:
      'new(0,globalThis.WebSocket)("wss://example.test/review-consumption");',
    present: true,
  },
  {
    name: "inert function sequence prefix",
    source:
      'new(()=>0,globalThis.WebSocket)("wss://example.test/review-consumption");',
    present: true,
  },
  {
    name: "nested throwing sequence",
    source:
      'const Socket=(0,(null.value,globalThis.WebSocket));new Socket("wss://example.test/review-consumption");',
    present: false,
  },
  {
    name: "projected throwing sequence",
    source:
      'const {WebSocket:Socket}=(null.value,globalThis);new Socket("wss://example.test/review-consumption");',
    present: false,
  },
  {
    name: "void literal sequence prefix",
    source:
      'new(void 0,globalThis.WebSocket)("wss://example.test/review-consumption");',
    present: true,
  },
  {
    name: "null optional sibling skips arguments",
    source:
      '(async()=>{null?.(await ready);new Socket("wss://example.test/review-consumption")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "stored optional async argument",
    source:
      '(async()=>{(()=>{})?.(async()=>await ready);new Socket("wss://example.test/review-consumption")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "ordinary literal awaited argument",
    source:
      '(async()=>{(()=>{})(await ready);new Socket("wss://example.test/review-consumption")})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "conditional labeled break bypass",
    source:
      '(async()=>{const pending=(async()=>{await ready;new Socket("wss://example.test/review-consumption")})();outer:{if(skip)break outer;await pending;}const Socket=globalThis.WebSocket;})();',
    present: true,
  },
  {
    name: "break before producer does not bypass its wait",
    source:
      '(async()=>{while(true){if(skip)break;const pending=(async()=>{await ready;new Socket("wss://example.test/review-consumption")})();await pending;const Socket=globalThis.WebSocket;break;}})();',
    present: false,
  },
  {
    name: "literal false break retains mandatory wait",
    source:
      '(async()=>{const pending=(async()=>{await ready;new Socket("wss://example.test/review-consumption")})();while(true){if(false)break;await pending;break;}const Socket=globalThis.WebSocket;})();',
    present: false,
  },
  {
    name: "nested loop owns its break",
    source:
      '(async()=>{const pending=(async()=>{await ready;new Socket("wss://example.test/review-consumption")})();while(true){break;}await pending;const Socket=globalThis.WebSocket;})();',
    present: false,
  },
  {
    name: "async block wrapper adoption",
    source:
      '(async()=>{const pending=(async()=>{await ready;new Socket("wss://example.test/review-consumption")})();await(async()=>{return pending})();const Socket=globalThis.WebSocket;})();',
    present: false,
  },
  {
    name: "async return await adoption",
    source:
      '(async()=>{const pending=(async()=>{await ready;new Socket("wss://example.test/review-consumption")})();await(async()=>await pending)();const Socket=globalThis.WebSocket;})();',
    present: false,
  },
  {
    name: "nested async wrapper adoption",
    source:
      '(async()=>{const pending=(async()=>{await ready;new Socket("wss://example.test/review-consumption")})();await(async()=>(async()=>pending)())();const Socket=globalThis.WebSocket;})();',
    present: false,
  },
  {
    name: "unawaited wrapper does not block",
    source:
      '(async()=>{const pending=(async()=>{await ready;new Socket("wss://example.test/review-consumption")})();(async()=>pending)();const Socket=globalThis.WebSocket;})();',
    present: true,
  },
  {
    name: "unrelated wrapper does not adopt producer",
    source:
      '(async()=>{const pending=(async()=>{await ready;new Socket("wss://example.test/review-consumption")})();await(async()=>0)();const Socket=globalThis.WebSocket;})();',
    present: true,
  },
  {
    name: "async generator wrapper is not a promise adoption",
    source:
      '(async()=>{const pending=(async()=>{await ready;new Socket("wss://example.test/review-consumption")})();await(async function*(){return pending})();const Socket=globalThis.WebSocket;})();',
    present: true,
  },
  {
    name: "delegate consumed by spread",
    source:
      '[...(function*(){yield*(function*(){new Socket("wss://example.test/review-consumption");yield 0})()})()];const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "delegate drain after inner yield",
    source:
      '[...(function*(){yield*(function*(){yield 0;new Socket("wss://example.test/review-consumption")})()})()];const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "stored delegate after alias initialization",
    source:
      'const iterator=(function*(){yield*(function*(){new Socket("wss://example.test/review-consumption");yield 0})()})();const Socket=globalThis.WebSocket;iterator.next();',
    present: true,
  },
  {
    name: "async delegate first step",
    source:
      '(async function*(){yield*(function*(){new Socket("wss://example.test/review-consumption");yield 0})()})().next();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "async delegate later step",
    source:
      '(async function*(){yield*(function*(){yield 0;new Socket("wss://example.test/review-consumption");yield 1})()})().next();const Socket=globalThis.WebSocket;',
    present: true,
    runtimePresent: false,
  },
  {
    name: "initialized prefix read",
    source:
      'const value=0;new(value,globalThis.WebSocket)("wss://example.test/review-consumption");',
    present: true,
  },
  {
    name: "mutable prefix assignment",
    source:
      'let value;new(value=0,globalThis.WebSocket)("wss://example.test/review-consumption");',
    present: true,
  },
  {
    name: "immutable prefix assignment",
    source:
      'const value=0;new(value=1,globalThis.WebSocket)("wss://example.test/review-consumption");',
    present: false,
  },
] as const;
describe("web bundle consumed prefixes and settlement dependencies", () => {
  it.each(consumptionReviewCases)(
    "preserves $name in both consumers",
    ({ source, present }) => {
      const expected = present ? ["wss://example.test/review-consumption"] : [];
      expect(
        socketEndpoints(source).map((items) => items.map((item) => item.value)),
      ).toEqual([expected, expected]);
    },
  );
});

const phaseReviewCases = [
  {
    name: "inherited object value does not select a default",
    source:
      'Object.prototype.x=1;(async()=>{const [{x=await 0},next]=(function*(){yield {};new Socket("wss://example.test/review-phases");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "inherited array hole value does not select a default",
    source:
      'Array.prototype[0]=1;(async()=>{const [[x=await 0],next]=(function*(){yield [,];new Socket("wss://example.test/review-phases");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "setter for-of target",
    source:
      'for(({set run(value){new Socket("wss://example.test/review-phases");}}).run of [0]){}const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "setter for-await target",
    source:
      '(async()=>{for await(({set run(value){new Socket("wss://example.test/review-phases");}}).run of [0]){}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "shadowed class setter metadata",
    source:
      '(class{static set run(value){new Socket("wss://example.test/review-phases");}static run=0;}).run=1;const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "immediate sequence with a call prefix",
    source:
      '((()=>0)(),()=>new Socket("wss://example.test/review-phases"))();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "nested computed pattern wait",
    source:
      '(async()=>{const [{[await 0]:value},next]=(function*(){yield {};new Socket("wss://example.test/review-phases");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "fresh setter write",
    source:
      '({set run(value){new Socket("wss://example.test/review-phases");}}).run=0;const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "disposal before finalizer",
    source:
      '(async()=>{try{await using resource=null;}finally{new Socket("wss://example.test/review-phases");}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "hoisted function prefix",
    source:
      'function marker(){};new(marker,globalThis.WebSocket)("wss://example.test/review-phases");',
    present: true,
  },
  {
    name: "safe try await before catch completion",
    source:
      '(async()=>{try{await 0;}catch{}new Socket("wss://example.test/review-phases");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "do await before break",
    source:
      '(async()=>{do{await 0;break;}while(false);new Socket("wss://example.test/review-phases");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "disposal before consumed label break",
    source:
      '(async()=>{exit:{await using r=null;break exit;}new Socket("wss://example.test/review-phases");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "computed setter write",
    source:
      '({set ["run"](value){new Socket("wss://example.test/review-phases");}})["run"]=0;const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "paired setter after getter",
    source:
      '({get run(){return 0;},set run(value){new Socket("wss://example.test/review-phases");}}).run=0;const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "paired setter before getter",
    source:
      '({set run(value){new Socket("wss://example.test/review-phases");},get run(){return 0;}}).run=0;const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "static class setter",
    source:
      '(class{static set run(value){new Socket("wss://example.test/review-phases");}}).run=0;const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "instance class setter",
    source:
      '(new(class{set run(value){new Socket("wss://example.test/review-phases");}})).run=0;const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "class paired setter",
    source:
      '(class{static set run(value){new Socket("wss://example.test/review-phases");}static get run(){return 0;}}).run=0;const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "compound setter write",
    source:
      '({get run(){return 0;},set run(value){new Socket("wss://example.test/review-phases");}}).run+=1;const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "update setter write",
    source:
      '({get run(){return 0;},set run(value){new Socket("wss://example.test/review-phases");}}).run++;const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "destructuring setter write",
    source:
      '[({set run(value){new Socket("wss://example.test/review-phases");}}).run]=[0];const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "setter after awaited RHS",
    source:
      '(async()=>{({set run(value){new Socket("wss://example.test/review-phases");}}).run=await 0;})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "setter before later pattern wait",
    source:
      '(async()=>{let b;[({set run(value){new Socket("wss://example.test/review-phases");}}).run,b=await 0]=[0,undefined];})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "setter after earlier pattern wait",
    source:
      '(async()=>{let a;[a=await 0,({set run(value){new Socket("wss://example.test/review-phases");}}).run]=[undefined,0];})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "setter-only read metadata",
    source:
      '({set run(value){new Socket("wss://example.test/review-phases");}}).run;const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "setter delete metadata",
    source:
      'delete({set run(value){new Socket("wss://example.test/review-phases");}}).run;const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "selected nested property default",
    source:
      '(async()=>{const [{x=await 0},next]=(function*(){yield {x:undefined};new Socket("wss://example.test/review-phases");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "unselected nested property default",
    source:
      '(async()=>{const [{x=await 0},next]=(function*(){yield {x:1};new Socket("wss://example.test/review-phases");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "selected nested array default",
    source:
      '(async()=>{const [[x=await 0],next]=(function*(){yield [undefined];new Socket("wss://example.test/review-phases");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "unselected nested array default",
    source:
      '(async()=>{const [[x=await 0],next]=(function*(){yield [1];new Socket("wss://example.test/review-phases");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "nested computed key after selected default",
    source:
      '(async()=>{const [{[await 0]:x}={},next]=(function*(){yield;new Socket("wss://example.test/review-phases");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "pattern wait after first generator read",
    source:
      '(async()=>{const [{[await 0]:x},next]=(function*(){new Socket("wss://example.test/review-phases");yield {};yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "later nested pattern does not defer earlier resume",
    source:
      '(async()=>{const [a,{[await 0]:x}]=(function*(){yield 0;new Socket("wss://example.test/review-phases");yield {};})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "nested computed wait in inner pattern",
    source:
      '(async()=>{const [{a:{[await 0]:x}},next]=(function*(){yield {a:{}};new Socket("wss://example.test/review-phases");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "forward hoisted function prefix",
    source:
      'new(marker,globalThis.WebSocket)("wss://example.test/review-phases");function marker(){}',
    present: true,
  },
  {
    name: "lexical function expression prefix TDZ",
    source:
      'new(marker,globalThis.WebSocket)("wss://example.test/review-phases");const marker=()=>0;',
    present: false,
  },
  {
    name: "hoisted function prefix in invocation",
    source:
      '(()=>{new(marker,globalThis.WebSocket)("wss://example.test/review-phases");function marker(){}})();',
    present: true,
  },
  {
    name: "immediate call prefix followed by await",
    source:
      '(async()=>{((()=>0)(),()=>new Socket("wss://example.test/review-phases"))(await 0);})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "immediate call prefix with bind",
    source:
      '((()=>0)(),()=>new Socket("wss://example.test/review-phases")).bind(null)();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "safe try await before caught throw",
    source:
      '(async()=>{try{await 0;throw 1;}catch{}new Socket("wss://example.test/review-phases");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "throw before caught dead await",
    source:
      '(async()=>{try{throw 1;await 0;}catch{}new Socket("wss://example.test/review-phases");})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "throwing operand before caught await",
    source:
      '(async()=>{try{null.value;await 0;}catch{}new Socket("wss://example.test/review-phases");})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "safe declaration before try await",
    source:
      '(async()=>{try{const value=0;await 0;}catch{}new Socket("wss://example.test/review-phases");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "do break skips test wait",
    source:
      '(async()=>{do{break;}while(await 0);new Socket("wss://example.test/review-phases");})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "do break before dead await",
    source:
      '(async()=>{do{break;await 0;}while(false);new Socket("wss://example.test/review-phases");})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "do conditional break before await",
    source:
      '(async()=>{do{if(skip)break;await 0;}while(false);new Socket("wss://example.test/review-phases");})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "do await before continue",
    source:
      '(async()=>{do{await 0;continue;}while(false);new Socket("wss://example.test/review-phases");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "disposal before do break",
    source:
      '(async()=>{do{await using r=null;break;}while(false);new Socket("wss://example.test/review-phases");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "label break before disposal",
    source:
      '(async()=>{exit:{break exit;await using r=null;}new Socket("wss://example.test/review-phases");})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "synchronous disposal before label break",
    source:
      '(async()=>{exit:{using r=null;break exit;}new Socket("wss://example.test/review-phases");})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "nested disposal before label break",
    source:
      '(async()=>{exit:{{await using r=null;}break exit;}new Socket("wss://example.test/review-phases");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "throwing prefix before finalizer disposal",
    source:
      '(async()=>{try{null.value;await using r=null;}finally{new Socket("wss://example.test/review-phases");}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "throwing acquisition before finalizer",
    source:
      '(async()=>{try{await using r=null.value;}finally{new Socket("wss://example.test/review-phases");}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "synchronous disposal before finalizer",
    source:
      '(async()=>{try{using r=null;}finally{new Socket("wss://example.test/review-phases");}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "nested asynchronous disposal before finalizer",
    source:
      '(async()=>{try{{await using r=null;}}finally{new Socket("wss://example.test/review-phases");}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "disposal before catch completion",
    source:
      '(async()=>{try{await using r=null;}catch{}new Socket("wss://example.test/review-phases");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
] as const;
describe("web bundle executed phases and scope exits", () => {
  it.each(phaseReviewCases)(
    "preserves $name in both consumers",
    ({ source, present }) => {
      const expected = present ? ["wss://example.test/review-phases"] : [];
      expect(
        socketEndpoints(source).map((items) => items.map((item) => item.value)),
      ).toEqual([expected, expected]);
    },
  );
});

const iterationReviewCases = [
  {
    name: "identifier assignment immediate call",
    source:
      'let target;(target=()=>new Socket("wss://example.test/review-iteration"))();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "member assignment bound call",
    source:
      'const holder={};(holder.run=()=>new Socket("wss://example.test/review-iteration")).bind(null)();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "member assignment call member",
    source:
      'const holder={};(holder.run=()=>new Socket("wss://example.test/review-iteration")).call(null);const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "assignment constructor call",
    source:
      'const holder={};new(holder.run=function(){new Socket("wss://example.test/review-iteration");})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "assignment after awaited target key",
    source:
      'const holder={};(async()=>{(holder[await ready]=()=>new Socket("wss://example.test/review-iteration"))();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "stored assignment callable metadata",
    source:
      'const holder={};holder.run=()=>new Socket("wss://example.test/review-iteration");const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "aliased prototype iterator skips default",
    source:
      'const proto=Array.prototype;proto[Symbol.iterator]=function*(){yield 1;};(async()=>{const [[x=await 0],next]=(function*(){yield [undefined];new Socket("wss://example.test/review-iteration");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "defined prototype iterator skips default",
    source:
      'Object.defineProperty(Array.prototype,Symbol.iterator,{value:function*(){yield 1;}});(async()=>{const [[x=await 0],next]=(function*(){yield [undefined];new Socket("wss://example.test/review-iteration");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "local Array lookalike does not taint iteration",
    source:
      'const Array={prototype:{}};Array.prototype[Symbol.iterator]=function*(){yield 1;};(async()=>{const [[x=await 0],next]=(function*(){yield [undefined];new Socket("wss://example.test/review-iteration");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "custom own iterator remains unknown",
    source:
      '(async()=>{const [[x=await 0],next]=(function*(){yield Object.assign([undefined],{[Symbol.iterator]:function*(){yield 1;}});new Socket("wss://example.test/review-iteration");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "mutated nested array remains unknown",
    source:
      '(async()=>{const [[x=await 0],next]=(function*(){yield ((a)=>{a[0]=1;return a;})([undefined]);new Socket("wss://example.test/review-iteration");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "exhausted second nested slot",
    source:
      '(async()=>{const [[x,y=await 0],next]=(function*(){yield [0];new Socket("wss://example.test/review-iteration");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "exhausted default after own undefined",
    source:
      '(async()=>{const [[x,y=await 0],next]=(function*(){yield [undefined];new Socket("wss://example.test/review-iteration");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "selected explicit nested default",
    source:
      '(async()=>{const [[x=await 0],next]=(function*(){yield [undefined];new Socket("wss://example.test/review-iteration");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "unselected explicit nested default",
    source:
      '(async()=>{const [[x=await 0],next]=(function*(){yield [1];new Socket("wss://example.test/review-iteration");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "rest default skipped",
    source:
      '(async()=>{let x;[...[x=await 0,({set run(v){new Socket("wss://example.test/review-iteration");}}).run]]=[1,0];})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "rest suffix preserves source offset",
    source:
      '(async()=>{let x,y;[y,...[x=await 0,({set run(v){new Socket("wss://example.test/review-iteration");}}).run]]=[99,undefined,0];})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "rest suffix does not use earlier slot",
    source:
      '(async()=>{let x,y;[y,...[x=await 0,({set run(v){new Socket("wss://example.test/review-iteration");}}).run]]=[undefined,99,0];})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "exhausted rest default before setter",
    source:
      '(async()=>{let x;[...[x=await 0,({set run(v){new Socket("wss://example.test/review-iteration");}}).run]]=[];})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "rest setter precedes later wait",
    source:
      '(async()=>{let x;[...[({set run(v){new Socket("wss://example.test/review-iteration");}}).run,x=await 0]]=[0,undefined];})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "nested rest pattern before setter",
    source:
      '(async()=>{let x;[...[[x=await 0],({set run(v){new Socket("wss://example.test/review-iteration");}}).run]]=[[undefined],0];})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "custom iterator skips rest default",
    source:
      'Array.prototype[Symbol.iterator]=function*(){yield 1;yield 0;};(async()=>{let x;[...[x=await 0,({set run(v){new Socket("wss://example.test/review-iteration");}}).run]]=[undefined,0];})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "rest drain precedes nested pattern wait",
    source:
      '(async()=>{const [...[x=await 0]]=(function*(){yield undefined;new Socket("wss://example.test/review-iteration");})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "arrow parameter consumes generator",
    source:
      '(([x])=>{})((function*(){new Socket("wss://example.test/review-iteration");yield 0;})());const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "constructor parameter consumes generator",
    source:
      'new(function([x]){})((function*(){new Socket("wss://example.test/review-iteration");yield 0;})());const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "async parameter consumes generator eagerly",
    source:
      '(async function([x]){})((function*(){new Socket("wss://example.test/review-iteration");yield 0;})());const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "generator parameter initializes on call",
    source:
      '(function*([x]){})((function*(){new Socket("wss://example.test/review-iteration");yield 0;})());const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "default parameter consumes supplied generator",
    source:
      '(function([x]=[]){} )((function*(){new Socket("wss://example.test/review-iteration");yield 0;})());const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "second positional parameter consumes generator",
    source:
      '(function(ignore,[x]){})(0,(function*(){new Socket("wss://example.test/review-iteration");yield 0;})());const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "later awaited argument precedes parameter consumption",
    source:
      '(async()=>{(function([x],ignored){} )((function*(){new Socket("wss://example.test/review-iteration");yield 0;})(),await ready);})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "parameter call member consumes generator",
    source:
      '(function([x]){}).call(null,(function*(){new Socket("wss://example.test/review-iteration");yield 0;})());const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "parameter apply member consumes generator",
    source:
      '(function([x]){}).apply(null,[(function*(){new Socket("wss://example.test/review-iteration");yield 0;})()]);const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "erased receiver annotation does not shift parameter",
    source:
      '(function(this:void,[x]){} )((function*(){new Socket("wss://example.test/review-iteration");yield 0;})());const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "optional literal call consumes parameter",
    source:
      '(function([x]){} )?.((function*(){new Socket("wss://example.test/review-iteration");yield 0;})());const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "non-consuming parameter retains metadata",
    source:
      '(function(x){} )((function*(){new Socket("wss://example.test/review-iteration");yield 0;})());const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "empty parameter pattern does not resume generator",
    source:
      '(function([]){} )((function*(){new Socket("wss://example.test/review-iteration");yield 0;})());const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "rest parameter alone does not resume generator",
    source:
      '(function(...[x]){} )((function*(){new Socket("wss://example.test/review-iteration");yield 0;})());const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "array optional receiver evaluates key",
    source:
      '(async()=>{[]?.[await ready];new Socket("wss://example.test/review-iteration");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "number optional receiver evaluates key",
    source:
      '(async()=>{(0)?.[await ready];new Socket("wss://example.test/review-iteration");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "function optional receiver evaluates key",
    source:
      '(async()=>{(function(){})?.[await ready];new Socket("wss://example.test/review-iteration");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "null optional receiver skips key",
    source:
      '(async()=>{null?.[await ready];new Socket("wss://example.test/review-iteration");})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "void optional receiver skips key",
    source:
      '(async()=>{(void 0)?.[await ready];new Socket("wss://example.test/review-iteration");})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "nested optional chain retains mandatory first key",
    source:
      '(async()=>{({})?.[await ready]?.x;new Socket("wss://example.test/review-iteration");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "constructed optional receiver evaluates key",
    source:
      '(async()=>{(new(class{}))?.[await ready];new Socket("wss://example.test/review-iteration");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "member assignment immediate call",
    source:
      'const holder={};(holder.run=()=>new Socket("wss://example.test/review-iteration"))();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "custom nested array iterator skips default",
    source:
      'Array.prototype[Symbol.iterator]=function*(){yield 1;};(async()=>{const [[x=await 0],next]=(function*(){yield [undefined];new Socket("wss://example.test/review-iteration");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    name: "non-null optional member key",
    source:
      '(async()=>{({})?.[await ready];new Socket("wss://example.test/review-iteration");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "exhausted nested array default",
    source:
      '(async()=>{const [[x=await 0],next]=(function*(){yield [];new Socket("wss://example.test/review-iteration");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "nested array rest setter target",
    source:
      '(async()=>{let x;[...[x=await 0,({set run(v){new Socket("wss://example.test/review-iteration");}}).run]]=[undefined,0];})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    name: "literal parameter consumes generator",
    source:
      '(function([x]){})((function*(){new Socket("wss://example.test/review-iteration");yield 0;})());const Socket=globalThis.WebSocket;',
    present: false,
  },
] as const;
const consumerRouteReviewCases = [
  [
    "arrow cannot be constructed",
    "const connect=()=>new Socket(URL);try{new connect()}catch{}const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "async function cannot be constructed",
    "async function connect(){new Socket(URL)}try{new connect()}catch{}const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "generator cannot be constructed",
    "function* connect(){new Socket(URL)}try{new connect()}catch{}const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "ordinary function construction enters body",
    "function connect(){new Socket(URL)}try{new connect()}catch{}const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "bound arrow cannot be constructed",
    "const connect=(()=>new Socket(URL)).bind(null);try{new connect()}catch{}const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "bound ordinary function construction enters body",
    "const connect=(function(){new Socket(URL)}).bind(null);try{new connect()}catch{}const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "call helper cannot be constructed",
    "function connect(){new Socket(URL)}try{new connect.call(null)}catch{}const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "apply helper cannot be constructed",
    "function connect(){new Socket(URL)}try{new connect.apply(null,[])}catch{}const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "literal arrow cannot be constructed",
    "try{new (()=>new Socket(URL))()}catch{}const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "literal call helper cannot be constructed",
    "try{new (function(){new Socket(URL)}).call(null)}catch{}const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "callback parameter arrow cannot be constructed",
    "const invoke=run=>{try{new run()}catch{}};invoke(()=>new Socket(URL));const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "setter-only import option shadows inherited value",
    "export {};Object.prototype.with=null;const{WebSocket:Socket}=await import('ws',{set with(value){}});new Socket(URL);",
    true,
  ],
  [
    "setter-only alias import option shadows inherited value",
    "export {};Object.prototype.with=null;const options={with:null,set with(value){}};const{WebSocket:Socket}=await import('ws',options);new Socket(URL);",
    true,
  ],
  [
    "paired getter remains effective",
    "export {};const{WebSocket:Socket}=await import('ws',{get with(){return null},set with(value){}});new Socket(URL);",
    false,
  ],
  [
    "later data replaces setter-only option",
    "export {};const{WebSocket:Socket}=await import('ws',{set with(value){},with:null});new Socket(URL);",
    false,
  ],
  [
    "failed argument spread does not activate stored body",
    "const connect=()=>new Socket(URL);try{connect(...null)}catch{}const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "stored class remains dormant without construction",
    "const Client=class{socket=new Socket(URL)};const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "multiple stored class constructions precede initialization",
    "const Client=class{socket=new Socket(URL)};try{new Client()}catch{}try{new Client()}catch{}const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "multiple initialized stored class constructions",
    "const Client=class{socket=new Socket(URL)};const Socket=globalThis.WebSocket;new Client();new Client();",
    true,
  ],
  [
    "caught class construction preserves later initialized instance",
    "const Client=class{socket=new Socket(URL)};try{new Client()}catch{}const Socket=globalThis.WebSocket;new Client();",
    true,
  ],
  [
    "stored caller apply preserves callback offset",
    "const invoke=run=>run();invoke.apply(null,[()=>new Socket(URL)]);const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "replaced call helper cannot activate callback",
    "const invoke=run=>run();invoke.call=()=>{};invoke.call(null,()=>new Socket(URL));const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "bound caller argument offset stays unresolved",
    "const invoke=(ignored,run)=>run();invoke.bind(null,0)(()=>new Socket(URL));const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "prototype setter invalidates function import options",
    "export{};Object.setPrototypeOf(Function.prototype,{with:null});const{WebSocket:Socket}=await import('ws',()=>{});new Socket(URL);",
    false,
  ],
  [
    "caught early failure with inert finally permits later call",
    "const connect=()=>new Socket(URL);try{connect()}catch{}finally{0}const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "throwing finally prevents later call",
    "const connect=()=>new Socket(URL);try{connect()}catch{}finally{throw 0}const Socket=globalThis.WebSocket;connect();",
    false,
  ],
  [
    "intervening abrupt statement prevents later call",
    "const connect=()=>new Socket(URL);try{connect()}catch{}throw 0;const Socket=globalThis.WebSocket;connect();",
    false,
  ],
  [
    "uncaught activation alongside caught activation blocks later call",
    "const connect=()=>new Socket(URL);try{connect()}catch{}connect();const Socket=globalThis.WebSocket;connect();",
    false,
  ],
  [
    "captured constructor in normal catch resumes later call",
    "const connect=()=>new Socket(URL);try{connect()}catch{const ignored=0}const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "blocked earlier iteration binding cannot borrow later wait",
    "(async()=>{for(const[x=await 0]of(function*(){yield null;yield[];new Socket(URL)})()){}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "later blocked binding stops already deferred generator",
    "(async()=>{for(const[x=await 0]of(function*(){yield[];yield null;new Socket(URL)})()){}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "failed call argument does not activate stored body",
    "const connect=()=>new Socket(URL);try{connect(null.value)}catch{}const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "failed new argument does not activate stored constructor",
    "function connect(){new Socket(URL)}try{new connect(null.value)}catch{}const Socket=globalThis.WebSocket;new connect();",
    true,
  ],
  [
    "failed tag substitution does not activate stored tag",
    "const connect=()=>new Socket(URL);try{connect`${null.value}`}catch{}const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "replacement static field leaves instance method dormant",
    "(new(class{static effect=(this.prototype.run=()=>{});run(){new Socket(URL)}})()).run();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "unchanged instance method runs before initialization",
    "(new(class{run(){new Socket(URL)}})()).run();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "inert static field preserves instance selection",
    "(new(class{static effect=1;run(){new Socket(URL)}})()).run();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "earlier iteration binding wait persists",
    "(async()=>{for(const[x=await 0]of(function*(){yield[];yield[1];new Socket(URL)})()){}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "later iteration binding wait resumes generator",
    "(async()=>{for(const[x=await 0]of(function*(){yield[1];yield[];new Socket(URL)})()){}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "defined iteration bindings never wait",
    "(async()=>{for(const[x=await 0]of(function*(){yield[1];yield[2];new Socket(URL)})()){}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "function prototype chain replacement invalidates import options",
    "export{};Function.prototype.__proto__={with:null};const options=()=>{};const{WebSocket:Socket}=await import('ws',options);new Socket(URL);",
    false,
  ],
  [
    "array prototype chain replacement invalidates import options",
    "export{};Array.prototype.__proto__={with:null};const{WebSocket:Socket}=await import('ws',[]);new Socket(URL);",
    false,
  ],
  [
    "prototype change after fulfilled import keeps captured origin",
    "export{};const{WebSocket:Socket}=await import('ws',()=>{});Function.prototype.__proto__={with:null};new Socket(URL);",
    true,
  ],
  [
    "unrelated prototype change keeps function import options",
    "export{};Array.prototype.__proto__={with:null};const{WebSocket:Socket}=await import('ws',()=>{});new Socket(URL);",
    true,
  ],
  [
    "stored class field construction precedes initialization",
    "const Client=class{socket=new Socket(URL)};new Client();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "stored class field construction follows initialization",
    "const Client=class{socket=new Socket(URL)};const Socket=globalThis.WebSocket;new Client();",
    true,
  ],
  [
    "class declaration field construction precedes initialization",
    "class Client{socket=new Socket(URL)}new Client();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "stored class constructor precedes initialization",
    "const Client=class{constructor(){new Socket(URL)}};new Client();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "aliased stored class construction precedes initialization",
    "const Client=class{socket=new Socket(URL)};const Alias=Client;new Alias();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "stored caller maps callback before initialization",
    "const invoke=run=>run();invoke(()=>new Socket(URL));const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "stored caller maps callback after initialization",
    "const invoke=run=>run();const Socket=globalThis.WebSocket;invoke(()=>new Socket(URL));",
    true,
  ],
  [
    "stored caller helper preserves callback offset",
    "const invoke=run=>run();invoke.call(null,()=>new Socket(URL));const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "aliased stored caller maps callback before initialization",
    "const invoke=run=>run();const alias=invoke;alias(()=>new Socket(URL));const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "caught early body failure retains later successful activation",
    "const connect=()=>new Socket(URL);try{connect()}catch{}const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "uncaught early body failure cannot prove later activation",
    "const connect=()=>new Socket(URL);connect();const Socket=globalThis.WebSocket;connect();",
    false,
  ],
  [
    "single caught preinitialization body remains invalid",
    "const connect=()=>new Socket(URL);try{connect()}catch{}const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "all stored activations precede initialization",
    "const connect=()=>new Socket(URL);try{connect()}catch{}try{connect()}catch{}const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "catch does not initialize later binding on throw",
    "const connect=()=>new Socket(URL);try{connect()}catch{throw 0}const Socket=globalThis.WebSocket;connect();",
    false,
  ],
  [
    "throwing array async iterator cannot prove wait",
    "const values=[];values[Symbol.asyncIterator]=()=>{throw 0};(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{for await(const y of values){}}catch{}}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throwing array async iterator getter cannot prove wait",
    "const values=[];Object.defineProperty(values,Symbol.asyncIterator,{get(){throw 0}});(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{for await(const y of values){}}catch{}}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throwing numeric iterator cannot prove later default wait",
    "Number.prototype[Symbol.iterator]=function*(){throw 0};(async()=>{const[[x],y=await 0]=(function*(){try{yield 1;yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "empty nested async iteration waits",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){for await(const y of[]){}}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "nonempty nested async iteration waits",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){for await(const y of[1]){}}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "caught null async iterable cannot prove wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{for await(const y of null){}}catch{}}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throwing async iterator acquisition cannot prove wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{for await(const y of{[Symbol.asyncIterator](){throw 0}}){}}catch{}}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throwing async iterable expression precedes wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{for await(const y of null.x){}}catch{}}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "unselected async loop cannot prove wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){if(false){for await(const y of[]){}}}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "explicit iterable wait survives acquisition failure",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{for await(const y of(await 0,null)){}}catch{}}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "empty rest array property default waits",
    "(async()=>{const[[...{0:x=await 0}],next]=(function*(){yield[];new Socket(URL);yield 1})();})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "suffix rest array property default waits",
    "(async()=>{const[[first,...{0:x=await 0}],next]=(function*(){yield[1];new Socket(URL);yield 1})();})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "defined suffix property skips default wait",
    "(async()=>{const[[first,...{0:x=await 0}],next]=(function*(){yield[1,2];new Socket(URL);yield 1})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "second rest array property selects suffix position",
    "(async()=>{const[[...{1:x=await 0}],next]=(function*(){yield[2];new Socket(URL);yield 1})();})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "rest array length skips default wait",
    "(async()=>{const[[...{length:x=await 0}],next]=(function*(){yield[];new Socket(URL);yield 1})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "inherited rest array index skips default wait",
    "Array.prototype[0]=7;(async()=>{const[[...{0:x=await 0}],next]=(function*(){yield[];new Socket(URL);yield 1})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "function options prototype invalidates import",
    "export{};const options=()=>{};options.__proto__={with:null};const{WebSocket:Socket}=await import('ws',options);new Socket(URL);",
    false,
  ],
  [
    "aliased function options prototype invalidates import",
    "export{};const options=()=>{};const alias=options;alias.__proto__={with:null};const{WebSocket:Socket}=await import('ws',options);new Socket(URL);",
    false,
  ],
  [
    "hoisted function options prototype invalidates import",
    "export{};function options(){}options.__proto__={with:null};const{WebSocket:Socket}=await import('ws',options);new Socket(URL);",
    false,
  ],
  [
    "later options prototype write preserves prior capture",
    "export{};const options=()=>{};const{WebSocket:Socket}=await import('ws',options);options.__proto__={with:null};new Socket(URL);",
    true,
  ],
  [
    "unrelated function option write preserves capture",
    "export{};const options=()=>{};options.extra=null;const{WebSocket:Socket}=await import('ws',options);new Socket(URL);",
    true,
  ],
  [
    "function construction prototype is not option prototype",
    "export{};function options(){}options.prototype={with:null};const{WebSocket:Socket}=await import('ws',options);new Socket(URL);",
    true,
  ],
  [
    "own null import attributes stay invalid",
    "export{};const options=()=>{};options.with=null;const{WebSocket:Socket}=await import('ws',options);new Socket(URL);",
    false,
  ],
  [
    "stored tag before constructor initialization",
    "const connect=()=>new Socket(URL);connect``;const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "stored tag after constructor initialization",
    "const connect=()=>new Socket(URL);const Socket=globalThis.WebSocket;connect``;",
    true,
  ],
  [
    "immutable alias tag before initialization",
    "const connect=()=>new Socket(URL);const tag=connect;tag``;const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "bound tag before initialization",
    "const connect=()=>new Socket(URL);const tag=connect.bind(null);tag``;const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "nested tag before initialization",
    "const connect=()=>new Socket(URL);function run(){connect``}run();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "async stored tag waits before constructor read",
    "const connect=async()=>{await 0;new Socket(URL)};connect``;const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "caught uninitialized tag does not activate callback",
    "const connect=()=>new Socket(URL);try{tag``}catch{}const tag=connect;const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "tag interpolation waits before body activation",
    "(async()=>{const connect=()=>new Socket(URL);connect`${await 0}`;})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "nested while test waits before generator resumes",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){while(await 0){}}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "nested for test waits before generator resumes",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){for(;await 0;){}}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "nested for initializer waits before false test",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){for(await 0;false;){}}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "false nested while skips body wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){while(false){await 0}}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "false nested for skips update wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){for(;false;await 0){}}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throwing nested for initializer precedes test wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{for(null.x;await 0;){}}catch{}}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "uncertain nested branch cannot guarantee test wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){if(globalThis.flag){while(await 0){}}}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "do continue reaches required test wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){do{continue}while(await 0)}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "do break skips test wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){do{break}while(await 0)}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "caught uninitialized var alias does not activate callback",
    "const connect=()=>new Socket(URL);try{alias()}catch{}var alias=connect;const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "undefined getter rest copy permits later default wait",
    "(async()=>{const[{...copy},next=await 0,last]=(function*(){yield{get x(){return undefined}};yield undefined;new Socket(URL);yield 1;})();})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "caught uninitialized alias does not activate callback",
    "const connect=()=>new Socket(URL);try{alias()}catch{}const alias=connect;const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "caught uninitialized chain alias does not activate callback",
    "const connect=()=>new Socket(URL);const first=connect;try{alias()}catch{}const alias=first;const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "caught uninitialized call receiver does not activate callback",
    "const connect=()=>new Socket(URL);try{alias.call(null)}catch{}const alias=connect;const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "caught uninitialized bind receiver does not activate callback",
    "const connect=()=>new Socket(URL);try{alias.bind(null)()}catch{}const alias=connect;const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "initialized alias still owns early activation",
    "const connect=()=>new Socket(URL);const alias=connect;try{alias()}catch{}const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "hoisted function still owns early activation",
    "try{connect()}catch{}function connect(){new Socket(URL)}const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "nested caller cannot activate uninitialized alias",
    "const connect=()=>new Socket(URL);function run(){try{alias()}catch{}}run();const alias=connect;const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "nested caller preserves initialized alias activation",
    "const connect=()=>new Socket(URL);const alias=connect;function run(){alias()}try{run()}catch{}const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "getter undefined selects mandatory default wait",
    "(async()=>{const [{x=await 0},next]=(function*(){yield {get x(){return undefined;}};new Socket(URL);yield 1;})();})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "getter void result selects mandatory default wait",
    "(async()=>{const [{x=await 0},next]=(function*(){yield {get x(){return void 0;}};new Socket(URL);yield 1;})();})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "getter nonundefined result skips default wait",
    "(async()=>{const [{x=await 0},next]=(function*(){yield {get x(){return 0;}};new Socket(URL);yield 1;})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "shadowed undefined getter does not select wait",
    "((undefined)=>{(async()=>{const [{x=await 0},next]=(function*(){yield {get x(){return undefined;}};new Socket(URL);yield 1;})();})();})(0);const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throwing getter cannot complete default selection",
    "(async()=>{const [{x=await 0},next]=(function*(){yield {get x(){throw 0;}};new Socket(URL);yield 1;})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throwing undefined prefix cannot select wait",
    "(async()=>{const [{x=await 0},next]=(function*(){yield {get x(){return (null.value,undefined);}};new Socket(URL);yield 1;})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "bare getter return selects mandatory default wait",
    "(async()=>{const [{x=await 0},next]=(function*(){yield {get x(){return;}};new Socket(URL);yield 1;})();})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "selected if wait precedes finalizer",
    "(async()=>{try{if(true){await 0}}finally{new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "selected else wait precedes finalizer",
    "(async()=>{try{if(false){}else{await 0}}finally{new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "unselected wait cannot defer finalizer",
    "(async()=>{try{if(false){await 0}}finally{new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "uncertain branch cannot prove finalizer wait",
    "(async()=>{try{if(globalThis.flag){await 0}}finally{new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "selected throw cannot credit unreachable wait",
    "(async()=>{try{if(true){null.value;await 0}}finally{new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "nested selected branch wait precedes finalizer",
    "(async()=>{try{if(true){if(false){}else{await 0}}}finally{new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "selected conditional wait precedes finalizer",
    "(async()=>{try{true?await 0:0}finally{new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "selected logical wait precedes finalizer",
    "(async()=>{try{true&&await 0}finally{new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "replaced call leaves parameter generator dormant",
    "Function.prototype.call=()=>{};(function([x]){}).call(null,(function*(){new Socket(URL);yield 0;})());const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "replaced apply leaves parameter generator dormant",
    "Function.prototype.apply=()=>{};(function([x]){}).apply(null,[(function*(){new Socket(URL);yield 0;})()]);const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "native call still consumes parameter generator",
    "(function([x]){}).call(null,(function*(){new Socket(URL);yield 0;})());const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "native apply still consumes parameter generator",
    "(function([x]){}).apply(null,[(function*(){new Socket(URL);yield 0;})()]);const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "later helper replacement preserves earlier parameter consumption",
    "try{(function([x]){}).call(null,(function*(){new Socket(URL);yield 0;})())}catch{}Function.prototype.call=()=>{};const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "unrelated helper replacement preserves parameter consumption",
    "Function.prototype.apply=()=>{};(function([x]){}).call(null,(function*(){new Socket(URL);yield 0;})());const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "replaced call does not hide later generator resume",
    "Function.prototype.call=()=>{};const values=(function*(){new Socket(URL);yield 0;})();(function([x]){}).call(null,values);const Socket=globalThis.WebSocket;values.next();",
    true,
  ],
  [
    "class key replaced helper leaves generator dormant",
    "Function.prototype.call=()=>{};class C{[(function([x]){}).call(null,(function*(){new Socket(URL);yield 0;})())](){}}const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "class key native helper consumes generator",
    "class C{[(function([x]){}).call(null,(function*(){new Socket(URL);yield 0;})())](){}}const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "bound helper overwrite belongs to bound allocation",
    "const connect=()=>new Socket(URL);const bound=connect.bind(null);bound.call=()=>{};bound.call(null);const Socket=globalThis.WebSocket;bound();",
    true,
  ],
  [
    "target own helper does not replace bound helper",
    "const connect=()=>new Socket(URL);connect.call=()=>{};const bound=connect.bind(null);bound.call(null);const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "prototype replacement leaves literal call dormant",
    "Function.prototype.call=()=>{};(()=>new Socket(URL)).call(null);const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "prototype replacement leaves literal bind dormant",
    "Function.prototype.bind=()=>()=>{};(()=>new Socket(URL)).bind(null)();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "replaced call does not activate original callback",
    "const connect=()=>new Socket(URL);connect.call=()=>{};connect.call(null);const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "replaced apply does not activate original callback",
    "const connect=()=>new Socket(URL);connect.apply=()=>{};connect.apply(null,[]);const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "replaced bind does not bind original callback",
    "const connect=()=>new Socket(URL);connect.bind=()=>()=>{};connect.bind(null)();const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "alias helper write reaches original allocation",
    "const connect=()=>new Socket(URL);const alias=connect;alias.call=()=>{};connect.call(null);const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "unrelated helper write preserves native call",
    "const connect=()=>new Socket(URL);connect.apply=()=>{};connect.call(null);const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "unrelated function property preserves native call",
    "const connect=()=>new Socket(URL);connect.label=0;connect.call(null);const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "later helper write does not erase earlier call",
    "const connect=()=>new Socket(URL);try{connect.call(null)}catch{}connect.call=()=>{};const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "prototype call replacement does not activate original",
    "const connect=()=>new Socket(URL);Function.prototype.call=()=>{};connect.call(null);const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "prototype apply replacement does not activate original",
    "const connect=()=>new Socket(URL);Function.prototype.apply=()=>{};connect.apply(null,[]);const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "prototype bind replacement does not bind original",
    "const connect=()=>new Socket(URL);Function.prototype.bind=()=>()=>{};connect.bind(null)();const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "captured bound function survives later helper replacement",
    "const connect=()=>new Socket(URL);const bound=connect.bind(null);connect.bind=()=>()=>{};bound();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "parameter helper replacement does not activate original",
    "const connect=()=>new Socket(URL);connect.call=()=>{};((run)=>run.call(null))(connect);const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "parameter helper after later write remains early call",
    "const connect=()=>new Socket(URL);try{((run)=>run.call(null))(connect)}catch{}connect.call=()=>{};const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "escaped callback helper remains unproven",
    "const connect=()=>new Socket(URL);const alias=connect;function change(value){value.call=()=>{}}change(alias);connect.call(null);const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "stored call runs before constructor binding",
    "const connect=()=>new Socket(URL);connect.call(null);const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "stored apply runs before constructor binding",
    "const connect=()=>new Socket(URL);connect.apply(null,[]);const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "stored call runs after constructor binding",
    "const connect=()=>new Socket(URL);const Socket=globalThis.WebSocket;connect.call(null);",
    true,
  ],
  [
    "stored apply runs after constructor binding",
    "const connect=()=>new Socket(URL);const Socket=globalThis.WebSocket;connect.apply(null,[]);",
    true,
  ],
  [
    "stored sequence alias call runs before binding",
    'const connect=(0,()=>new Socket(URL));const alias=connect;alias["call"](null);const Socket=globalThis.WebSocket;',
    false,
  ],
  [
    "parameter call runs before constructor binding",
    "((run)=>run.call(null))(()=>new Socket(URL));const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "parameter apply runs before constructor binding",
    "((run)=>run.apply(null,[]))(()=>new Socket(URL));const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "parameter call after mandatory wait observes binding",
    "(async(run)=>{await 0;run.call(null)})(()=>new Socket(URL));const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "bound callback creation is not invocation",
    "const connect=()=>new Socket(URL);connect.bind(null);const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "bound result invokes before constructor binding",
    "const connect=()=>new Socket(URL);connect.bind(null)();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "stored bound result invokes before constructor binding",
    "const connect=()=>new Socket(URL);const bound=connect.bind(null);bound();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "stored bound result invokes after constructor binding",
    "const connect=()=>new Socket(URL);const bound=connect.bind(null);const Socket=globalThis.WebSocket;bound();",
    true,
  ],
  [
    "parameter bound result invokes before constructor binding",
    "((run)=>run.bind(null)())(()=>new Socket(URL));const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "parameter bound creation is not invocation",
    "((run)=>run.bind(null))(()=>new Socket(URL));const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "sequence stored callback runs before binding",
    "const connect=(0,()=>new Socket(URL));connect();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "sequence stored callback runs after binding",
    "const connect=(0,()=>new Socket(URL));const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "conditional stored callback runs before binding",
    "const connect=true?()=>new Socket(URL):()=>{};connect();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "changed async wrapper loses native promise identity",
    'export {};const wrapped=(async()=>import("ws"))();wrapped.constructor={};wrapped.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await wrapped;new Socket(URL);',
    false,
  ],
  [
    "wrapper copy shares constructor changes",
    'export {};const wrapped=(async()=>import("ws"))();const alias=wrapped;wrapped.constructor={};wrapped.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await alias;new Socket(URL);',
    false,
  ],
  [
    "native wrapper bypasses own then",
    'export {};const wrapped=(async()=>import("ws"))();wrapped.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await wrapped;new Socket(URL);',
    true,
  ],
  [
    "wrapper captured constructor survives later changes",
    'export {};const wrapped=(async()=>import("ws"))();const{WebSocket:Socket}=await wrapped;wrapped.constructor={};wrapped.then=resolve=>resolve({WebSocket:class{}});new Socket(URL);',
    true,
  ],
  [
    "completed adoption precedes ambient then write",
    'export {};const{WebSocket:Socket}=await(async()=>import("ws"))();Promise.prototype.then=resolve=>resolve({WebSocket:class{}});new Socket(URL);',
    true,
  ],
  [
    "ambient then write precedes adoption",
    'export {};Promise.prototype.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await(async()=>import("ws"))();new Socket(URL);',
    false,
  ],
  [
    "stored wrapper adopts before inner then write",
    'export {};const pending=import("ws");const wrapped=(async()=>pending)();pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await wrapped;new Socket(URL);',
    true,
  ],
  [
    "inner then write precedes stored wrapper adoption",
    'export {};const pending=import("ws");pending.then=resolve=>resolve({WebSocket:class{}});const wrapped=(async()=>pending)();const{WebSocket:Socket}=await wrapped;new Socket(URL);',
    false,
  ],
  [
    "stored wrapper adoption precedes ambient then write",
    'export {};const pending=import("ws");const wrapped=(async()=>pending)();Promise.prototype.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await wrapped;new Socket(URL);',
    true,
  ],
  [
    "synchronous callback parameter runs before binding",
    "((run)=>run())(()=>new Socket(URL));const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "synchronous callback parameter runs after binding",
    "const Socket=globalThis.WebSocket;((run)=>run())(()=>new Socket(URL));",
    true,
  ],
  [
    "synchronous callback call parameter runs before binding",
    "((run)=>run()).call(null,()=>new Socket(URL));const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "synchronous callback apply parameter runs before binding",
    "((run)=>run()).apply(null,[()=>new Socket(URL)]);const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "callback after mandatory await observes binding",
    "(async(run)=>{await 0;run()})(()=>new Socket(URL));const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "callback before optional await remains synchronous",
    "(async(run)=>{if(false)await 0;run()})(()=>new Socket(URL));const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "completed async adoption preserves captured constructor",
    'export {};const pending=import("ws");const{WebSocket:Socket}=await(async()=>pending)();pending.then=resolve=>resolve({WebSocket:class{}});new Socket(URL);',
    true,
  ],
  [
    "completed async adoption ignores later alias then write",
    'export {};const pending=import("ws");const alias=pending;const{WebSocket:Socket}=await(async()=>alias)();pending.then=resolve=>resolve({WebSocket:class{}});new Socket(URL);',
    true,
  ],
  [
    "async adoption rejects earlier then substitution",
    'export {};const pending=import("ws");pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await(async()=>pending)();new Socket(URL);',
    false,
  ],
  [
    "completed async adoption ignores later prototype replacement",
    'export {};const pending=import("ws");const{WebSocket:Socket}=await(async()=>pending)();pending.__proto__={then(resolve){resolve({WebSocket:class{}})}};new Socket(URL);',
    true,
  ],
  [
    "async adoption rejects earlier prototype substitution",
    'export {};const pending=import("ws");pending.__proto__={then(resolve){resolve({WebSocket:class{}})}};const{WebSocket:Socket}=await(async()=>pending)();new Socket(URL);',
    false,
  ],
  [
    "import equals initializes before earlier declared caller",
    'function connect(){new ws.WebSocket(URL)}import ws=require("ws");connect();',
    true,
  ],
  [
    "import equals rejects caller before initialization",
    'function connect(){new ws.WebSocket(URL)}connect();import ws=require("ws");',
    false,
  ],
  [
    "import equals initializes before nested caller",
    'function connect(){new ws.WebSocket(URL)}function outer(){connect()}import ws=require("ws");outer();',
    true,
  ],
  [
    "import equals rejects nested caller before initialization",
    'function connect(){new ws.WebSocket(URL)}function outer(){connect()}outer();import ws=require("ws");',
    false,
  ],
  [
    "import equals retains dormant declaration metadata",
    'function connect(){new ws.WebSocket(URL)}import ws=require("ws");',
    true,
  ],
  [
    "fallible computed method key cannot prove acquisition",
    "function mayThrow(){throw 0}(async()=>{try{await using r={[void mayThrow()](){},[Symbol.asyncDispose](){}}}finally{new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "inert computed method key proves acquisition",
    "(async()=>{try{await using r={[void 0](){},[Symbol.asyncDispose](){}}}finally{new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "fallible computed value key cannot prove acquisition",
    "function mayThrow(){throw 0}(async()=>{try{await using r={[void mayThrow()]:0,[Symbol.asyncDispose](){}}}finally{new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "earlier acquisition survives later fallible computed key",
    "function mayThrow(){throw 0}(async()=>{try{await using first=null;await using r={[void mayThrow()](){},[Symbol.asyncDispose](){}}}finally{new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "copied promise observes later constructor and then writes",
    'export {};const pending=import("ws");const alias=pending;pending.constructor={};pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await alias;new Socket(URL);',
    false,
  ],
  [
    "nested promise copies share later constructor changes",
    'export {};const pending=import("ws");const alias=pending;const copied=alias;pending.constructor={};pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await copied;new Socket(URL);',
    false,
  ],
  [
    "promise copy observes writes through a sibling alias",
    'export {};const pending=import("ws");const alias=pending;const writer=pending;writer.constructor={};writer.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await alias;new Socket(URL);',
    false,
  ],
  [
    "promise copy observes later prototype replacement",
    'export {};const pending=import("ws");const alias=pending;pending.__proto__={constructor:{},then(resolve){resolve({WebSocket:class{}})}};const{WebSocket:Socket}=await alias;new Socket(URL);',
    false,
  ],
  [
    "promise copy observes escaped reference changes",
    'export {};const pending=import("ws");const alias=pending;function change(value){value.constructor={};value.then=resolve=>resolve({WebSocket:class{}})}change(pending);const{WebSocket:Socket}=await alias;new Socket(URL);',
    false,
  ],
  [
    "copied native promise still bypasses own then",
    'export {};const pending=import("ws");const alias=pending;pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await alias;new Socket(URL);',
    true,
  ],
  [
    "promise copy ignores unrelated promise constructor changes",
    'export {};const pending=import("ws");const alias=pending;const other=import("ws");other.constructor={};other.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await alias;new Socket(URL);',
    true,
  ],
  [
    "completed copy wait preserves captured constructor",
    'export {};const pending=import("ws");const alias=pending;const{WebSocket:Socket}=await alias;pending.constructor={};pending.then=resolve=>resolve({WebSocket:class{}});new Socket(URL);',
    true,
  ],
  [
    "setter-only rest read reaches default wait",
    "(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {set run(value){}};yield undefined;}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "setter body is not invoked by rest read",
    "(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {set run(value){throw 0}};yield undefined;}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "computed setter-only rest read reaches wait",
    "(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {set ['run'](value){}};yield undefined;}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "data replaced by setter has undefined read",
    "(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {run:1,set run(value){}};yield undefined;}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "data reset removes earlier getter before setter",
    "(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {get run(){throw 0},run:1,set run(value){}};yield undefined;}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "getter before setter remains a throwing read",
    "(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {get run(){throw 0},set run(value){}};yield undefined;}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "getter after setter remains a throwing read",
    "(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {set run(value){},get run(){throw 0}};yield undefined;}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "own setter masks inherited getter",
    "(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {__proto__:{get run(){throw 0}},set run(value){}};yield undefined;}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "setter-only rest without wait remains eager",
    "(async()=>{const[{...rest},next=0]=(function*(){try{yield {set run(value){}};yield undefined;}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "setter-only binding selects undefined default",
    "(async()=>{const[{run=await 0}]=(function*(){try{yield {set run(value){throw 0}}}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "initialized ternary argument completes before caught wait",
    "const fail=false;const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{consume?.(fail?1:0,await 0)}catch{}}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "initialized ternary test does not require a constant",
    "let fail=true;const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{consume?.(fail?1:0,await 0)}catch{}}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "nested inert ternary argument completes before wait",
    "const fail=false;const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{consume?.(fail?(fail?1:2):(fail?3:4),await 0)}catch{}}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "throwing selected ternary branch bypasses caught wait",
    "const fail=true;const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{consume?.(fail?null.value:0,await 0)}catch{}}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "uninitialized ternary test cannot establish wait",
    "const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{consume?.(fail?1:0,await 0)}catch{}}})();const Socket=globalThis.WebSocket;const fail=false;",
    false,
  ],
  [
    "inert ternary without wait remains eager",
    "const fail=false;const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{consume?.(fail?1:0,0)}catch{}}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "with receiver throw reaches caught wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{with(null.value){}}catch{await 0;continue;}break;}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "with null coercion reaches caught wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{with(null){}}catch{await 0;continue;}break;}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "with undefined coercion reaches caught wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{with(void 0){}}catch{await 0;continue;}break;}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "with receiver wait precedes failed object coercion",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{with(void(await 0)){}}catch{continue;}break;}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "with nonnull object cannot invent caught wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{with({}){}}catch{await 0;continue;}break;}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "with primitive boxing cannot invent caught wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{with(0){}}catch{await 0;continue;}break;}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "with function receiver cannot invent caught wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{with((function(){})){}}catch{await 0;continue;}break;}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "with class receiver cannot invent caught wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{with((class{})){}}catch{await 0;continue;}break;}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "with throwing receiver cannot reach body wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{with(null.value){await 0;continue;}}catch{}break;}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "with failed coercion cannot reach body wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{with(null){await 0;continue;}}catch{}break;}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "with valid receiver reaches owned body wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{with({}){await 0;continue;}}catch{}break;}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "with caught receiver error without wait retains eager resume",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{with(null.value){}}catch{continue;}break;}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "prototype replacement invalidates native import promise",
    'export {};const pending=import("ws");pending.__proto__={constructor:{},then(resolve){resolve({WebSocket:class{}})}};const{WebSocket:Socket}=await pending;new Socket(URL);',
    false,
  ],
  [
    "aliased prototype replacement invalidates native import promise",
    'export {};const pending=import("ws");const alias=pending;alias.__proto__={constructor:{},then(resolve){resolve({WebSocket:class{}})}};const{WebSocket:Socket}=await pending;new Socket(URL);',
    false,
  ],
  [
    "setPrototypeOf invalidates native import promise",
    'export {};const pending=import("ws");Object.setPrototypeOf(pending,{constructor:{},then(resolve){resolve({WebSocket:class{}})}});const{WebSocket:Socket}=await pending;new Socket(URL);',
    false,
  ],
  [
    "prototype replacement after completed await preserves capture",
    'export {};const pending=import("ws");const{WebSocket:Socket}=await pending;pending.__proto__={constructor:{},then(resolve){resolve({WebSocket:class{}})}};new Socket(URL);',
    true,
  ],
  [
    "unrelated promise prototype replacement preserves capture",
    'export {};const pending=import("ws");const other=import("ws");other.__proto__={constructor:{},then(resolve){resolve({WebSocket:class{}})}};const{WebSocket:Socket}=await pending;new Socket(URL);',
    true,
  ],
  [
    "native await skips changed own then with intact constructor",
    'export {};const pending=import("ws");pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await pending;new Socket(URL);',
    true,
  ],
  [
    "async return cannot adopt prototype-replaced import identity",
    'export {};const pending=import("ws");pending.__proto__={constructor:{},then(resolve){resolve({WebSocket:class{}})}};const{WebSocket:Socket}=await(async()=>pending)();new Socket(URL);',
    false,
  ],
  [
    "async await cannot preserve prototype-replaced import identity",
    'export {};const pending=import("ws");pending.__proto__={constructor:{},then(resolve){resolve({WebSocket:class{}})}};const{WebSocket:Socket}=await(async()=>await pending)();new Socket(URL);',
    false,
  ],
  [
    "unmodified async return preserves adopted import identity",
    'export {};const pending=import("ws");const{WebSocket:Socket}=await(async()=>pending)();new Socket(URL);',
    true,
  ],
  [
    "inert promise member write preserves native import identity",
    'export {};const pending=import("ws");pending.note={constructor:{},then(resolve){resolve({WebSocket:class{}})}};const{WebSocket:Socket}=await pending;new Socket(URL);',
    true,
  ],
  [
    "rest copying ordinary method reaches later wait",
    "(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {run(){}};yield undefined;}finally{new Socket(URL)}})();})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "rest copying async method reaches later wait",
    "(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {async run(){}};yield undefined;}finally{new Socket(URL)}})();})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "rest copying generator method reaches later wait",
    "(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {*run(){}};yield undefined;}finally{new Socket(URL)}})();})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "rest copying throwing method does not invoke body",
    "(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {run(){throw 0}};yield undefined;}finally{new Socket(URL)}})();})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "throwing getter replacing method blocks later rest wait",
    "(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {run(){},get run(){throw 0}};yield undefined;}finally{new Socket(URL)}})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "ordinary method replacing getter is inert rest data",
    "(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {get run(){throw 0},run(){}};yield undefined;}finally{new Socket(URL)}})();})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "earlier throwing getter blocks method rest copy",
    "(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {get fail(){throw 0},run(){}};yield undefined;}finally{new Socket(URL)}})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "method rest copy without a wait retains eager cleanup",
    "(async()=>{const[{...rest},next=0]=(function*(){try{yield {run(){}};yield undefined;}finally{new Socket(URL)}})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "nested repeated activations join shared caller prefixes",
    "const connect=()=>new Socket(URL);const invoke=()=>{connect();connect()};const twice=()=>{invoke();invoke()};const Socket=globalThis.WebSocket;twice();twice();",
    true,
  ],
  [
    "nested repeated activations preserve eager failure",
    "const connect=()=>new Socket(URL);const invoke=()=>{connect();connect()};const twice=()=>{invoke();invoke()};twice();const Socket=globalThis.WebSocket;twice();",
    false,
  ],
  [
    "repeated stored calls after initialization",
    "const connect=()=>new Socket(URL);const Socket=globalThis.WebSocket;connect();connect();",
    true,
  ],
  [
    "repeated stored calls before initialization",
    "const connect=()=>new Socket(URL);connect();connect();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "mixed repeated calls preserve eager first activation",
    "const connect=()=>new Socket(URL);connect();const Socket=globalThis.WebSocket;connect();",
    false,
  ],
  [
    "repeated stored calls keep function-local bindings",
    "const connect=()=>{const Socket=globalThis.WebSocket;new Socket(URL)};connect();connect();",
    true,
  ],
  [
    "repeated aliases share initialized caller frames",
    "const connect=()=>new Socket(URL);const alias=connect;const Socket=globalThis.WebSocket;alias();connect();",
    true,
  ],
  [
    "repeated async callbacks cross their own wait",
    "const connect=async()=>{await 0;new Socket(URL)};connect();connect();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "repeated awaited callbacks cannot reach late local",
    "(async()=>{const connect=async()=>{await 0;new Socket(URL)};await connect();await connect();const Socket=globalThis.WebSocket;})();",
    false,
  ],
  [
    "repeated nested callers retain local initialization",
    "const connect=()=>{const Socket=globalThis.WebSocket;new Socket(URL)};const invoke=()=>connect();invoke();invoke();",
    true,
  ],
  [
    "caught throwing optional argument precedes later wait",
    "const fail=true;const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{consume?.(fail?null.value:0,await 0)}catch{}}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "inert optional prefix reaches required argument wait",
    "const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{consume?.(0,await 0)}catch{}}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "earlier optional wait survives later argument failure",
    "const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{consume?.(await 0,null.value)}catch{}}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "caught computed optional prefix precedes wait",
    "const fail=true;const receiver={};(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{receiver?.[(fail?null.value:0,await 0)]}catch{}}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "later registered resource waits before earlier disposer failure",
    "(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket(URL)}})()){await using first={[Symbol.asyncDispose](){throw 0}},second={[Symbol.asyncDispose](){return 0}};}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "earlier registered resource waits after later disposer failure",
    "(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket(URL)}})()){await using first={[Symbol.asyncDispose](){return 0}},second={[Symbol.asyncDispose](){throw 0}};}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "separate registrations share one disposal scope",
    "(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket(URL)}})()){await using first={[Symbol.asyncDispose](){throw 0}};await using second={[Symbol.asyncDispose](){return 0}};}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "later acquisition failure retains reached disposal wait",
    "(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket(URL)}})()){await using first={[Symbol.asyncDispose](){throw 0}},second={[Symbol.asyncDispose](){return 0}},third=null.value;}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "failed acquisition cannot register later waiting resource",
    "(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket(URL)}})()){await using first={[Symbol.asyncDispose](){throw 0}},second=null.value,third={[Symbol.asyncDispose](){return 0}};}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "failed earlier nested object binding blocks constructor",
    "const{missing:{x},WebSocket:Socket}={missing:null,WebSocket:globalThis.WebSocket};new Socket(URL);",
    false,
  ],
  [
    "completed earlier nested binding preserves constructor",
    "const{missing:{x},WebSocket:Socket}={missing:{},WebSocket:globalThis.WebSocket};new Socket(URL);",
    true,
  ],
  [
    "failed earlier array binding blocks constructor",
    "const[ [x],Socket]=[null,globalThis.WebSocket];new Socket(URL);",
    false,
  ],
  [
    "failed earlier default blocks constructor",
    "const{missing:x=(+1n),WebSocket:Socket}={missing:void 0,WebSocket:globalThis.WebSocket};new Socket(URL);",
    false,
  ],
  [
    "failed earlier computed key blocks constructor",
    "const{[(+1n)]:x,WebSocket:Socket}={WebSocket:globalThis.WebSocket};new Socket(URL);",
    false,
  ],
  [
    "inert earlier default preserves constructor",
    "const{missing:x=0,WebSocket:Socket}={missing:void 0,WebSocket:globalThis.WebSocket};new Socket(URL);",
    true,
  ],
  [
    "async generator disposer parameter failure precedes its await",
    "(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket(URL)}})()){await using resource={async *[Symbol.asyncDispose](x=null.value){}};}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "disposer parameter failure precedes its await",
    "(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket(URL)}})()){await using resource={[Symbol.asyncDispose](x=null.value){}};}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "generator disposer parameter failure precedes its await",
    "(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket(URL)}})()){await using resource={*[Symbol.asyncDispose](x=null.value){}};}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "async disposer parameter rejection still waits",
    "(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket(URL)}})()){await using resource={async [Symbol.asyncDispose](x=null.value){}};}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "inert disposer default permits its wait",
    "(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket(URL)}})()){await using resource={[Symbol.asyncDispose](x=0){return 0}};break;}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "changed import promise constructor invalidates native await",
    'export {};const pending=import("ws");pending.constructor={};pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await pending;new Socket(URL);',
    false,
  ],
  [
    "unchanged import promise bypasses replaced own then",
    'export {};const pending=import("ws");pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await pending;new Socket(URL);',
    true,
  ],
  [
    "constructor write after await preserves captured import",
    'export {};const pending=import("ws");const{WebSocket:Socket}=await pending;pending.constructor={};new Socket(URL);',
    true,
  ],
  [
    "prototype constructor replacement invalidates native await",
    'export {};Promise.prototype.constructor={};const pending=import("ws");pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await pending;new Socket(URL);',
    false,
  ],
  [
    "failed initializer cannot credit pattern wait before cleanup",
    "(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket(URL)}})()){const{[await 0]:y}=null.value;}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "completed initializer permits pattern wait before cleanup",
    "(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket(URL)}})()){const{[await 0]:y}={};break;}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "failed do body cannot credit later test wait",
    "(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket(URL)}})()){do{null.value;}while(await 0);}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "completed do body permits reached test wait",
    "(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket(URL)}})()){do{0;}while(await 0);break;}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "reached catch computed key waits before next step",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{throw{__proto__:null}}catch({[await 0]:y}){}}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "catch without wait resumes in same turn",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{throw{__proto__:null}}catch({x}){}}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "failed catch coercion cannot credit computed key",
    "(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket(URL)}})()){try{throw null}catch({[await 0]:y}){}}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "synchronous async disposer throw cannot credit cleanup",
    "(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket(URL)}})()){await using resource={[Symbol.asyncDispose](){throw 0}};}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "normal async disposer call waits before cleanup",
    "(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket(URL)}})()){await using resource={[Symbol.asyncDispose](){return 0}};break;}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "async disposer rejection still crosses wait",
    "(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket(URL)}})()){await using resource={[Symbol.asyncDispose]:async()=>{throw 0}};}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "sync disposer fallback throw crosses wrapper wait",
    "(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket(URL)}})()){await using resource={[Symbol.dispose](){throw 0}};}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "escaped ws namespace cannot prove selected member",
    'const ws=require("ws");mutate(ws);new ws.WebSocket(URL);',
    false,
  ],
  [
    "captured ws member survives later namespace escape",
    'const ws=require("ws");const Socket=ws.WebSocket;mutate(ws);new Socket(URL);',
    true,
  ],
  [
    "ws member selection before escape remains exact",
    'const ws=require("ws");new ws.WebSocket(URL);mutate(ws);',
    true,
  ],
  [
    "conditional consumer wait leaves consumer phase unresolved",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){if(flag)await 0;}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "all consumer branches wait before next step",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){if(flag)await 0;else await 0;}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "always skipped consumer wait cannot defer next step",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){if(false)await 0;}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "unconditional consumer wait permits next step",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){await 0;}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "stored callback executes before constructor initialization",
    "const connect=()=>new Socket(URL);connect();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "stored callback executes after constructor initialization",
    "const connect=()=>new Socket(URL);const Socket=globalThis.WebSocket;connect();",
    true,
  ],
  [
    "stored callback alias retains early caller ownership",
    "const connect=()=>new Socket(URL);const alias=connect;alias();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "stored async callback wait precedes late initialization",
    "const connect=async()=>{await 0;new Socket(URL)};connect();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "awaited stored callback cannot initialize later local",
    "(async()=>{const connect=async()=>{await 0;new Socket(URL)};await connect();const Socket=globalThis.WebSocket;})();",
    false,
  ],
  [
    "failed catch getter cannot credit handler wait",
    "(async()=>{try{throw{get x(){throw 0}}}catch({x}){await 0}new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "completed catch data permits handler wait",
    "(async()=>{try{throw{x:1}}catch({x}){await 0}new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "failed catch binding after key wait cannot complete handler",
    "(async()=>{try{throw{get x(){throw 0}}}catch({[await 0]:a,x}){await 0}new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "completed catch getter permits handler wait",
    "(async()=>{try{throw{get x(){return 1}}}catch({x}){await 0}new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "loop const write blocks later default wait",
    "const fixed=0;(async()=>{let x;for([fixed,x=await 0]of[[0,void 0]]){new Socket(URL);break}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "loop writable write permits later default wait",
    "let fixed=0;(async()=>{let x;for([fixed,x=await 0]of[[0,void 0]]){new Socket(URL);break}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "object loop const write blocks later default wait",
    "const fixed=0;(async()=>{let x;for({a:fixed,b:x=await 0}of[{__proto__:null,a:0}]){new Socket(URL);break}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "object loop writable write permits later default wait",
    "let fixed=0;(async()=>{let x;for({a:fixed,b:x=await 0}of[{__proto__:null,a:0}]){new Socket(URL);break}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "loop null member target blocks later default wait",
    "(async()=>{let x;for([null.x,x=await 0]of[[0,void 0]]){new Socket(URL);break}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "loop own data target permits later default wait",
    "const target={x:0};(async()=>{let x;for([target.x,x=await 0]of[[0,void 0]]){new Socket(URL);break}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "loop throwing setter cannot credit later default wait",
    "const target={set x(value){throw 0}};(async()=>{let x;for([target.x,x=await 0]of[[0,void 0]]){new Socket(URL);break}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "loop declaration initializes fresh const bindings",
    "(async()=>{for(const[fixed,x=await 0]of[[0,void 0]]){new Socket(URL);break}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "loop const write after wait cannot credit body",
    "const fixed=0;(async()=>{let x;for([x=await 0,fixed]of[[void 0,0]]){new Socket(URL);break}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "mandatory catch default shares missing slot wait",
    "(async()=>{try{throw{__proto__:null}}catch({x=await 0}){}new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "loop head default shares missing slot wait",
    "(async()=>{let x;for({x=await 0} of[{__proto__:null}]){new Socket(URL);break}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "loop head member receiver wait precedes body",
    "(async()=>{for((await 0,holder).x of[0]){new Socket(URL);break}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "throwing catch key blocks later binding wait",
    "(async()=>{try{throw{}}catch({[null.x]:x,[await 0]:y}){}new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "TypeScript wrapped numeric capture retains endpoint",
    "const box={__proto__:null};const Socket=(box[(-1 as number)]=globalThis.WebSocket);new Socket(URL);",
    true,
  ],
  [
    "TypeScript satisfies key capture retains endpoint",
    "new (({__proto__:null})[(-1 satisfies number)]=globalThis.WebSocket)(URL);",
    true,
  ],
  [
    "TypeScript wrapped throwing key cannot expose result",
    "new (({__proto__:null})[(void null.x as undefined)]=globalThis.WebSocket)(URL);",
    false,
  ],
  [
    "selected sequence null receiver stops continuation",
    "(async()=>{await 0;(0,null).x;new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "selected conditional null receiver stops continuation",
    "(async()=>{await 0;(true?null:{}).x;new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "selected sequence object receiver retains continuation",
    "(async()=>{await 0;(0,{}).x;new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "selected optional null receiver keeps continuation",
    "(async()=>{await 0;(0,null)?.x;new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "selected primitive callee stops continuation",
    "(async()=>{await 0;(0,1)();new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "absent null prototype slot triggers default wait",
    "(async()=>{const[{x=await 0},next]=(function*(){yield{__proto__:null};new Socket(URL);yield 1})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "own null prototype slot bypasses default wait",
    "(async()=>{const[{x=await 0},next]=(function*(){yield{__proto__:null,x:1};new Socket(URL);yield 1})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "spread null prototype slot cannot prove absence",
    "(async()=>{const[{x=await 0},next]=(function*(){yield{__proto__:null,...{x:1}};new Socket(URL);yield 1})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "changed null prototype cannot prove absence",
    "const item={__proto__:null};Object.setPrototypeOf(item,{x:1});(async()=>{const[{x=await 0},next]=(function*(){yield item;new Socket(URL);yield 1})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "mandatory catch computed binding precedes continuation",
    "(async()=>{try{throw{}}catch({[await 0]:x}){}new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "mandatory catch binding precedes handler body",
    "(async()=>{try{throw{}}catch({[await 0]:x}){new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "skipped catch binding cannot suspend continuation",
    "(async()=>{try{}catch({[await 0]:x}){}new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "null catch value blocks computed binding wait",
    "(async()=>{try{throw null}catch({[await 0]:x}){}new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "synchronous loop target key precedes body",
    "(async()=>{let x;for({[await 0]:x} of[{}]){new Socket(URL);break}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "for in target key precedes body",
    "(async()=>{let x;for({[await 0]:x} in{x:1}){new Socket(URL);break}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "unconsumed loop target cannot suspend continuation",
    "(async()=>{let x;for({[await 0]:x} of[]){ }new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "null loop value blocks target key wait",
    "(async()=>{let x;for({[await 0]:x} of[null]){new Socket(URL);break}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "unknown acquisition completed scope retains disposal wait",
    "(async r=>{{await using a=r;}new Socket(URL)})(null);const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "known failed acquisition cannot finish scope",
    "(async()=>{{await using a=1;}new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "unknown acquisition declaration alone cannot suspend",
    "(async r=>{await using a=r;new Socket(URL)})(null);const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "explicit body wait survives unknown resource binding",
    "(async()=>{for(await using x of(function*(){yield null;new Socket(URL)})()){await 0}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "explicit wait survives unknown resource acquisition",
    "const resource=null;(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){await 0;await using r=resource;}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "implicit for await survives unknown resource acquisition",
    "const resource=null;(async()=>{for await(const x of(function*(){yield 0;new Socket(URL)})()){await using r=resource;}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "computed member key fails before assignment result",
    "new (({__proto__:null})[void null.x]=globalThis.WebSocket)(URL);",
    false,
  ],
  [
    "completed void key permits assignment result",
    "new (({__proto__:null})[void(()=>{})]=globalThis.WebSocket)(URL);",
    true,
  ],
  [
    "computed member key fails before stored result",
    "const holder={__proto__:null};new (holder[void null.x]=globalThis.WebSocket)(URL);",
    false,
  ],
  [
    "completed void function yield triggers pattern default wait",
    "(async()=>{const[a=await 0,b]=(function*(){yield void(()=>{});new Socket(URL);yield 1;})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "completed void object yield triggers pattern default wait",
    "(async()=>{const[a=await 0,b]=(function*(){yield void({});new Socket(URL);yield 1;})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "throwing void yield cannot trigger pattern default wait",
    "(async()=>{const[a=await 0,b]=(function*(){yield void null.x;new Socket(URL);yield 1;})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "proven numeric callee stops resumed continuation",
    "(async()=>{await 0;(1)();new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "proven string callee stops resumed continuation",
    '(async()=>{await 0;("")();new Socket(URL)})();const Socket=globalThis.WebSocket;',
    false,
  ],
  [
    "proven void callee stops resumed continuation",
    "(async()=>{await 0;(void(()=>{}))();new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "optional null callee does not stop continuation",
    "(async()=>{await 0;null?.();new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "noncallable callee still evaluates constructor argument",
    "(async()=>{await 0;(1)(new Socket(URL))})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "noncallable callee argument wait precedes iterator cleanup",
    "(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket(URL)}})()){(1)(await 0)}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "import options getter returns undefined normally",
    '(async()=>{const{WebSocket:Socket}=await import("ws",{get with(){return undefined}});new Socket(URL)})();',
    true,
  ],
  [
    "empty import options getter returns undefined normally",
    '(async()=>{const{WebSocket:Socket}=await import("ws",{get with(){}});new Socket(URL)})();',
    true,
  ],
  [
    "import options getter returns completed void normally",
    '(async()=>{const{WebSocket:Socket}=await import("ws",{get with(){return void(()=>{})}});new Socket(URL)})();',
    true,
  ],
  [
    "throwing import options getter rejects import",
    '(async()=>{const{WebSocket:Socket}=await import("ws",{get with(){return void null.x}});new Socket(URL)})();',
    false,
  ],
  [
    "null import options getter rejects import",
    '(async()=>{const{WebSocket:Socket}=await import("ws",{get with(){return null}});new Socket(URL)})();',
    false,
  ],
  [
    "safe instance auto accessor cannot invent catch wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{class C{accessor x}}catch{await 0;continue}break;}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "safe static auto accessor cannot invent catch wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{class C{static accessor x=0}}catch{await 0;continue}break;}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throwing static auto accessor reaches catch wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{class C{static accessor x=null.x}}catch{await 0;continue}break;}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "switch jump skips later wait in selected case",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){switch(0){case 0:break;await 0}}}) ();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "possible early switch entry precedes later failing test",
    "const choice=0;(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){switch(0){case choice:await 0;break;case null.value:break}}}) ();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "noncallable async disposer cannot defer next step",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){await using r={__proto__:null,[Symbol.asyncDispose]:1,[Symbol.dispose](){}}}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "resource getter leaves consumer phase unresolved",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){await using r={__proto__:null,get [Symbol.asyncDispose](){return ()=>{}}}}}) ();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "replaced Symbol cannot prove resource acquisition",
    "globalThis.Symbol={asyncDispose:'x'};(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){await using r={__proto__:null,[Symbol.asyncDispose](){}}}}) ();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "failed optional receiver skips computed consumer wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){null.value?.[await 0]}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "failed optional receiver skips nested key wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){null.value?.run?.[await 0]}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "failed optional receiver still retains earlier cleanup wait",
    "(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket(URL)}})()){(await 0,null.value)?.[await 0]}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "missing null prototype disposer cannot defer next step",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){await using r={__proto__:null}}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "primitive resource cannot defer next step",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){await using r=1}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "prior acquired resource disposes after acquisition failure",
    "(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket(URL)}})()){await using first=null,second={__proto__:null}}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "own async disposer defers next step",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){await using r={__proto__:null,[Symbol.asyncDispose](){}}}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "own sync disposer fallback defers next step",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){await using r={__proto__:null,[Symbol.dispose](){}}}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "unmatched switch cannot defer next step",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){switch(0){case 1:await 0}}}) ();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "selected switch skips earlier waiting body",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){switch(0){case 1:await 0;break;case 0:break}}}) ();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "switch break excludes later waiting body",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){switch(0){case 0:break;default:await 0}}}) ();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "switch fallthrough reaches waiting body",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){switch(0){case 0:;default:await 0}}}) ();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "selected switch retains waiting test after default",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){switch(0){default:break;case (await 0,1):break}}}) ();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "failed switch discriminant skips waiting cases",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){switch(null.value){case (await 0,1):break}}}) ();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "failed class decorator stops continuation",
    "(async()=>{await 0;@(null.value) class C{};new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "failed member decorator stops continuation",
    "(async()=>{await 0;class C{@(null.value) run(){}};new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "legacy static initialization precedes failed class decorator",
    "(async()=>{await 0;@(null.value) class C{static value=new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "optional call consumer can wait",
    "const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){consume?.(await 0)}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "optional member consumer can wait",
    "const receiver={};(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){receiver?.[await 0]}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "logical assignment leaves consumer phase unresolved",
    "(async()=>{let value=0;for(const x of(function*(){yield 0;new Socket(URL)})()){value||=await 0}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "failed owning object cannot project socket alias",
    "const{WebSocket:Socket}={WebSocket:globalThis.WebSocket,broken:null.value};new Socket(URL);",
    false,
  ],
  [
    "failed owning array cannot project socket alias",
    "const[Socket]=[globalThis.WebSocket,null.value];new Socket(URL);",
    false,
  ],
  [
    "unrelated possible suffix failure retains socket metadata",
    "const{WebSocket:Socket}={WebSocket:globalThis.WebSocket,other:globalThis};new Socket(URL);",
    true,
  ],
  [
    "null array spread stops carried wait",
    "(async()=>{await 0;[...null];new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "undefined call spread stops carried wait",
    "(async()=>{await 0;(()=>{})(...void 0);new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "object spread does not require iterator acquisition",
    "(async()=>{await 0;({...null});new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "string spread preserves continuation",
    "(async()=>{await 0;[...'ok'];new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "failed await using initializer cannot defer next step",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){await using r=null.value}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "null await using resource defers next step",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){await using r=null}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "void false branch cannot reach waiting catch",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{if(void 0)throw 0}catch{await 0;continue}break}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "void false loop cannot reach waiting catch",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{while(void 0)throw 0}catch{await 0;continue}break}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "void switch mismatch cannot reach waiting catch",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{switch(void 0){case 1:throw 0}}catch{await 0;continue}break}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "undefined identifier import options preserve origin",
    "(async()=>{const{WebSocket:Socket}=await import('ws',undefined);new Socket(URL)})();",
    true,
  ],
  [
    "stable alias import options preserve origin",
    "(async()=>{const options={};const{WebSocket:Socket}=await import('ws',options);new Socket(URL)})();",
    true,
  ],
  [
    "array import options preserve origin",
    "(async()=>{const{WebSocket:Socket}=await import('ws',[]);new Socket(URL)})();",
    true,
  ],
  [
    "function import options preserve origin",
    "(async()=>{const{WebSocket:Socket}=await import('ws',()=>{});new Socket(URL)})();",
    true,
  ],
  [
    "array import attributes preserve origin",
    "(async()=>{const{WebSocket:Socket}=await import('ws',{with:[]});new Socket(URL)})();",
    true,
  ],
  [
    "shadowed undefined import options reject origin",
    "(async()=>{const undefined=null;const{WebSocket:Socket}=await import('ws',undefined);new Socket(URL)})();",
    false,
  ],
  [
    "mutated options reject origin",
    "(async()=>{const options={};options.with=null;const{WebSocket:Socket}=await import('ws',options);new Socket(URL)})();",
    false,
  ],
  [
    "late options alias rejects origin",
    "(async()=>{const{WebSocket:Socket}=await import('ws',options);new Socket(URL)})();const options={};",
    false,
  ],
  [
    "nonliteral safe await precedes continuing update",
    "(async()=>{for(let i=0;i<1;new Socket(URL),i++){await(()=>{});continue}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "failed await cannot prove continuing update",
    "(async()=>{for(let i=0;i<1;new Socket(URL),i++){await null.value;continue}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "null optional consumer cannot wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){null?.(await 0)}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "null optional member consumer cannot wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){null?.[await 0]}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "grouped null optional call still evaluates argument",
    "(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket(URL)}})()){(null?.run)(await 0)}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "prior await using resource disposes after later initializer failure",
    "(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket(URL)}})()){await using first=null,second=null.value}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "failed spread skips later optional wait",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){(()=>{})(...null,await 0)}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "replaced array import options prototype rejects origin",
    "(async()=>{Array.prototype.with=null;const{WebSocket:Socket}=await import('ws',[]);new Socket(URL)})();",
    false,
  ],
  [
    "mutated function import options reject origin",
    "(async()=>{const options=()=>{};options.with=null;const{WebSocket:Socket}=await import('ws',options);new Socket(URL)})();",
    false,
  ],
  [
    "stable undefined options alias preserves origin",
    "(async()=>{const options=undefined;const{WebSocket:Socket}=await import('ws',options);new Socket(URL)})();",
    true,
  ],
  [
    "prior wait cannot bypass failed async iterator acquisition",
    "(async()=>{await 0;for await(const x of null){}new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "rest target receiver wait cannot bypass throwing copied getter",
    "(async()=>{({...({before:await 0,set run(v){new Socket(URL)}}).run}={get x(){throw 0}})})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "own data update preserves writable slot",
    "const box={x:0};box.x++;const Socket=(box.x=globalThis.WebSocket);new Socket(URL);",
    true,
  ],
  [
    "own data compound write preserves writable slot",
    "const box={x:0};box.x+=1;const Socket=(box.x=globalThis.WebSocket);new Socket(URL);",
    true,
  ],
  [
    "structured setter receiver finishes wait",
    "(async()=>{[({before:await 0,set run(v){new Socket(URL)}}).run]=[0]})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "structured setter receiver failure blocks write",
    "(async()=>{[({before:(await 0,null.x),set run(v){new Socket(URL)}}).run]=[0]})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "structured setter computed target finishes wait",
    "(async()=>{[({set run(v){new Socket(URL)}})[(await 0,'run')]]=[0]})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "void function selects mandatory nullish wait",
    "(async()=>{(void(()=>{}))??(await 0);new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "void object selects mandatory nullish wait",
    "(async()=>{(void {})??(await 0);new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "void safe sequence selects mandatory nullish wait",
    "(async()=>{(void(1,2))??(await 0);new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "void throwing class cannot select nullish wait",
    "(async()=>{(void class{static x=null.value})??(await 0);new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "null import options reject module origin",
    "(async()=>{const{WebSocket:Socket}=await import('ws',null);new Socket(URL)})();",
    false,
  ],
  [
    "numeric import options reject module origin",
    "(async()=>{const{WebSocket:Socket}=await import('ws',1);new Socket(URL)})();",
    false,
  ],
  [
    "null import attributes reject module origin",
    "(async()=>{const{WebSocket:Socket}=await import('ws',{with:null});new Socket(URL)})();",
    false,
  ],
  [
    "throwing import attributes getter rejects module origin",
    "(async()=>{const{WebSocket:Socket}=await import('ws',{get with(){throw 0}});new Socket(URL)})();",
    false,
  ],
  [
    "empty import attributes preserve module origin",
    "(async()=>{const{WebSocket:Socket}=await import('ws',{with:{}});new Socket(URL)})();",
    true,
  ],
  [
    "undefined import options preserve module origin",
    "(async()=>{const{WebSocket:Socket}=await import('ws',void 0);new Socket(URL)})();",
    true,
  ],
  [
    "for await failed iterable cannot invent suspension",
    "(async()=>{for await(const x of null.value){}new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "for await null cannot invent suspension",
    "(async()=>{for await(const x of null){}new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "for await plain object cannot invent suspension",
    "(async()=>{for await(const x of {}){}new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "for await empty array completes asynchronous step",
    "(async()=>{for await(const x of []){}new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "false consumer branch cannot defer next step",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){if(false)await 0}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "true consumer branch defers next step",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){if(true)await 0}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "skipped logical consumer wait cannot defer next step",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){false&&(await 0)}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "skipped loop consumer wait cannot defer next step",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){while(false){await 0}}}) ();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "failed class key blocks later key wait",
    "(async()=>{class C{static [null.x];static [await 0];static x=new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "failed class key discards earlier key wait for statics",
    "(async()=>{class C{static [await 0];static [null.x];static x=new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "failed static value discards earlier key wait",
    "(async()=>{class C{[await 0](){}static a=null.x;static c=new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "completed class key retains static wait",
    "(async()=>{class C{static [await 0];static x=new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "explicit class static throw stops carried wait",
    "(async()=>{await 0;class C{static{throw 0}};new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "caught class static throw preserves carried wait",
    "(async()=>{await 0;class C{static{try{throw 0}catch{}}};new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "own data hides replacement prototype setter",
    "const box={x:0};box.__proto__={set x(v){throw 0}};const Socket=(box.x=globalThis.WebSocket);new Socket(URL);",
    true,
  ],
  [
    "deleted own data exposes replacement prototype setter",
    "const box={x:0};delete box.x;box.__proto__={set x(v){throw 0}};const Socket=(box.x=globalThis.WebSocket);new Socket(URL);",
    false,
  ],
  [
    "failed later yield retains earlier consumer wait in cleanup",
    "(async()=>{const[a=await 0,b]=(function*(){try{yield undefined;yield(null.x,undefined)}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "failed first yield has no earlier cleanup wait",
    "(async()=>{const[a=await 0,b]=(function*(){try{yield(null.x,undefined)}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "failed later yield cannot reach ordinary body",
    "(async()=>{const[a=await 0,b,c]=(function*(){yield undefined;yield(null.x,undefined);new Socket(URL)})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "array rest checks added getter with original index excluded",
    "let array,value;(async()=>{({0:value=(await 0,Object.defineProperty(array,'extra',{enumerable:true,get(){throw 0}})),...({set run(v){new Socket(URL)}}).run}=(array=[undefined]))})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "empty object rest checks added getter",
    "let object,key;(async()=>{({[(await 0,Object.defineProperty(object,'extra',{enumerable:true,get(){throw 0}}),'absent')]:key,...({set run(v){new Socket(URL)}}).run}=(object={}))})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "failed await operand cannot defer branch",
    "(async()=>{if(await null.value)new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "failed nested await operand cannot defer branch",
    "(async()=>{if(await(await 0,null.value))new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "failed await operand retains earlier wait in finally",
    "(async()=>{try{await(await 0,null.value)}finally{new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "completed await operand defers branch",
    "(async()=>{if(await 1)new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "safe class declaration cannot enter catch",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{class C{}}catch{await 0;continue}break}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "safe static class declaration cannot enter catch",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{class C{static{const x=1}}}catch{await 0;continue}break}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throwing class heritage stops carried wait",
    "(async()=>{await 0;class C extends null.value{};new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throwing class key stops carried wait",
    "(async()=>{await 0;class C{[null.value](){}};new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throwing class static field stops carried wait",
    "(async()=>{await 0;class C{static x=null.value};new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throwing class static block stops carried wait",
    "(async()=>{await 0;class C{static{null.value}};new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "dormant class instance field preserves carried wait",
    "(async()=>{await 0;class C{x=null.value};new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "void literal selects nullish wait",
    "(async()=>{(void 0)??(await 0);new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "failed void operand cannot select nullish wait",
    "(async()=>{(void null.x)??(await 0);new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "failed import options cannot supply export",
    "(async()=>{const{WebSocket:Socket}=await import('ws',null.value);new Socket(URL)})();",
    false,
  ],
  [
    "completed import options preserve export",
    "(async()=>{const{WebSocket:Socket}=await import('ws',{});new Socket(URL)})();",
    true,
  ],
  [
    "plain nested object cannot consume iterator",
    "(async()=>{const[[x],y=await 0]=(function*(){try{yield {};yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "custom nested iterator leaves consumer phase unresolved",
    "(async()=>{const[[x],y=await 0]=(function*(){try{yield {[Symbol.iterator]:function*(){}};yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "prototype setter blocks member capture",
    "const box={};box.__proto__={set x(v){throw 0}};const Socket=(box.x=globalThis.WebSocket);new Socket(URL);",
    false,
  ],
  [
    "different prototype setter permits member capture",
    "const box={};box.__proto__={set y(v){throw 0}};const Socket=(box.x=globalThis.WebSocket);new Socket(URL);",
    true,
  ],
  [
    "object rest copies array own slots",
    "(async()=>{const[{...rest},y=await 0]=(function*(){try{yield [0];yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "object rest copies array holes without inherited reads",
    "(async()=>{const[{...rest},y=await 0]=(function*(){try{yield [,0];yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "object rest copies primitive string slots",
    "(async()=>{const[{...rest},y=await 0]=(function*(){try{yield 'text';yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "object rest boxes numeric primitive",
    "(async()=>{const[{...rest},y=await 0]=(function*(){try{yield 1;yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "object rest boxes bigint primitive",
    "(async()=>{const[{...rest},y=await 0]=(function*(){try{yield 1n;yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "throwing unary receiver cannot evaluate optional key",
    "(async()=>{(-null.value)?.[await 0];new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throwing nested receiver cannot evaluate optional key",
    "(async()=>{(-(null.value,1))?.[await 0];new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "definite sequence failure discards carried wait",
    "(async()=>{(await 0,null.x,new Socket(URL))})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "nonthrowing sequence retains carried wait",
    "(async()=>{(await 0,1,new Socket(URL))})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "definite statement failure discards carried wait",
    "(async()=>{await 0;null.x;new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "empty do false cannot enter catch",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{do{}while(false)}catch{await 0;continue}break}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "inert do false cannot enter catch",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{do{1}while(false)}catch{await 0;continue}break}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throwing yield argument cannot invent default wait",
    "(async()=>{const[x=await 0,next]=(function*(){yield(null.x,undefined);new Socket(URL)})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "completed yield argument permits default wait",
    "(async()=>{const[x=await 0,next]=(function*(){yield(1,undefined);new Socket(URL)})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "empty static block is safe sequence prefix",
    "new(class{static{}},globalThis.WebSocket)(URL);",
    true,
  ],
  [
    "inert static block is safe sequence prefix",
    "new(class{static{const x=1}},globalThis.WebSocket)(URL);",
    true,
  ],
  [
    "throwing static block is not safe sequence prefix",
    "new(class{static{null.x}},globalThis.WebSocket)(URL);",
    false,
  ],
  [
    "literal false empty loop cannot enter catch",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{while(false){}}catch{await 0;continue}break}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "empty rest copy reaches setter write",
    "(async()=>{let x;({a:x=await 0,...({set run(v){new Socket(URL)}}).run}={a:undefined})})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "overwritten getter is not copied by rest",
    "(async()=>{let x;({a:x=await 0,...({set run(v){new Socket(URL)}}).run}={a:undefined,get b(){throw 0},b:1})})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "frozen constructor capture fails without unrelated indexing",
    "'use strict';const box={};Object.freeze(box);const Socket=(box.x=globalThis.WebSocket);new Socket(URL);",
    false,
  ],
  [
    "plain constructor capture requests its own effects",
    "const box={};const Socket=(box.x=globalThis.WebSocket);new Socket(URL);",
    true,
  ],
  [
    "nonextensible constructor capture fails",
    "'use strict';const box={};Object.preventExtensions(box);const Socket=(box.x=globalThis.WebSocket);new Socket(URL);",
    false,
  ],
  [
    "empty getter permits later pattern wait",
    "(async()=>{const[{x},y=await 0]=(function*(){try{yield {get x(){}};yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "bare return getter permits later pattern wait",
    "(async()=>{const[{x},y=await 0]=(function*(){try{yield {get x(){return}};yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "throwing bigint optional receiver skips unreachable key",
    "(async()=>{(+1n)?.[await 0];new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throwing negative bigint optional receiver",
    "(async()=>{(+(-1n))?.[await 0];new Socket(URL)})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "literal false loop cannot enter catch",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{while(false){throw 0}}catch{await 0;continue}break}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "literal false for cannot enter catch",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{for(let i=0;false;null.value){throw 0}}catch{await 0;continue}break}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throwing for initializer still enters catch",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{for(let i=null.value;false;){}}catch{await 0;continue}break}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "do false still executes throwing body",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{do{throw 0}while(false)}catch{await 0;continue}break}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "bitwise numeric prefix completes",
    "new(~1,globalThis.WebSocket)(URL);",
    true,
  ],
  [
    "bitwise bigint prefix completes",
    "new(~1n,globalThis.WebSocket)(URL);",
    true,
  ],
  [
    "inline null prototype assignment result",
    "new((({__proto__:null}).x=globalThis.WebSocket))(URL);",
    true,
  ],
  [
    "inline own data assignment result",
    "new((({x:0}).x=globalThis.WebSocket))(URL);",
    true,
  ],
  [
    "inline setter assignment result stays unproven",
    "'use strict';new((({set x(v){throw 0}}).x=globalThis.WebSocket))(URL);",
    false,
  ],
  [
    "throwing rest copy prevents setter write",
    "(async()=>{let x;({a:x=await 0,...({set run(v){new Socket(URL)}}).run}={a:undefined,get b(){throw 0}})})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "data rest copy reaches setter write",
    "(async()=>{let x;({a:x=await 0,...({set run(v){new Socket(URL)}}).run}={a:undefined,b:0})})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "empty rest getter reaches setter write",
    "(async()=>{let x;({a:x=await 0,...({set run(v){new Socket(URL)}}).run}={a:undefined,get b(){}})})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "nonthrowing rest getter reaches setter write",
    "(async()=>{let x,y;({a:x=await 0,b:y,...({set run(v){new Socket(URL)}}).run}={a:undefined,b:0,get c(){return 1}})})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "frozen member target blocks later wait",
    "'use strict';const box={};Object.freeze(box);(async()=>{let y;[box.x,y=await 0]=(function*(){try{yield 0;yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "parameter default cannot read later parameter",
    "(async(x=(later,globalThis.WebSocket),later)=>{new x(URL)})();",
    false,
  ],
  [
    "plain member write permits later wait",
    "const box={};(async()=>{let y;[box.x,y=await 0]=(function*(){try{yield 0;yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "null prototype member write resumes generator",
    "let next;const box={__proto__:null};(async()=>{[box.x=await 0,next]=(function*(){yield undefined;new Socket(URL)})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "parameter write permits later wait",
    "(async(x)=>{let y;[x,y=await 0]=(function*(){try{yield 0;yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "throwing member setter blocks later wait",
    "const box={set x(v){throw 0}};(async()=>{let y;[box.x,y=await 0]=(function*(){try{yield 0;yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "unbraced loop wait precedes update",
    "(async()=>{for(let i=0;i<1;new Socket(URL),i++)await 0})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "continue after wait reaches update",
    "(async()=>{for(let i=0;i<1;new Socket(URL),i++){await 0;continue}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "conditional continue after wait reaches update",
    "(async()=>{for(let i=0;i<1;new Socket(URL),i++){await 0;if(skip)continue}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "switch discriminant throw enters waiting catch",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{switch(null.value){}}catch{await 0;continue}break}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "switch test throw enters waiting catch",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{switch(0){case null.value:break}}catch{await 0;continue}break}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "unreachable switch continue cannot resume",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){switch(0){case 1:await 0;continue;default:break}break}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "matched switch continue resumes",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){switch(1){case 1:await 0;continue;default:break}break}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "switch fallthrough reaches waiting continue",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){switch(0){case 0:;case 1:await 0;continue;default:break}break}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "bigint pattern closes before later wait",
    "(async()=>{const[[x],y=await 0]=(function*(){try{yield 1n;yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "negative bigint pattern closes before later wait",
    "(async()=>{const[[x],y=await 0]=(function*(){try{yield -1n;yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throwing pattern getter blocks later wait",
    "(async()=>{const[{x},y=await 0]=(function*(){try{yield {get x(){throw 0}};yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "inert pattern getter permits later wait",
    "(async()=>{const[{x},y=await 0]=(function*(){try{yield {get x(){return 0}};yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "unary plus numeric sequence prefix",
    "new(+1,globalThis.WebSocket)(URL);",
    true,
  ],
  [
    "unary plus bigint sequence prefix throws",
    "new(+1n,globalThis.WebSocket)(URL);",
    false,
  ],
  [
    "post default case test precedes default selection",
    "(async()=>{switch(1){default:;case await 0:new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "matching case bypasses later default test",
    "(async()=>{switch(1){case 1:;default:;case await 0:new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "returned arrow is immediately invoked",
    "(()=>()=>new Socket(URL))()();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "returned ordinary function is immediately called",
    "(function(){return function(){new Socket(URL)}})().call(null);const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "stored returned arrow remains deferred",
    "const run=(()=>()=>new Socket(URL))();const Socket=globalThis.WebSocket;run();",
    true,
  ],
  [
    "async return does not synchronously invoke its value",
    "(async()=>()=>new Socket(URL))().then(run=>run());const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "returned invocation retains awaited producer arguments",
    "(async()=>{(()=>()=>new Socket(URL))(await 0)()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "nested returned calls retain eager activation",
    "(()=>()=>()=>new Socket(URL))()()();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "null nested pattern closes before unreachable wait",
    "(async()=>{const [[x],y=await 0]=(function*(){try{yield null;yield undefined;}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "undefined nested pattern closes before unreachable wait",
    "(async()=>{const [[x],y=await 0]=(function*(){try{yield undefined;yield undefined;}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "void nested pattern closes before unreachable wait",
    "(async()=>{const [[x],y=await 0]=(function*(){try{yield void 0;yield undefined;}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "empty nested pattern still requires an iterable",
    "(async()=>{const [[],y=await 0]=(function*(){try{yield null;yield undefined;}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "iterable nested pattern permits later default wait",
    "(async()=>{const [[x],y=await 0]=(function*(){try{yield [];yield undefined;}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "earlier wait precedes failing nested pattern cleanup",
    "(async()=>{const [x=await 0,[y]]=(function*(){try{yield undefined;yield null;}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "mandatory do test blocks initializer",
    "(async()=>{const pending=(async()=>{await 0;new Socket(URL)})();do{}while(await pending);const Socket=globalThis.WebSocket;})();",
    false,
  ],
  [
    "nonthrowing do body retains blocking test",
    "(async()=>{const pending=(async()=>{await 0;new Socket(URL)})();do{const x=1;}while(await pending);const Socket=globalThis.WebSocket;})();",
    false,
  ],
  [
    "do break can skip blocking test",
    "(async()=>{const pending=(async()=>{await 0;new Socket(URL)})();do{break;}while(await pending);const Socket=globalThis.WebSocket;})();",
    true,
  ],
  [
    "caught do body failure can skip blocking test",
    "(async()=>{const pending=(async()=>{await 0;new Socket(URL)})();try{do{throw 0;}while(await pending)}catch{}const Socket=globalThis.WebSocket;})();",
    true,
  ],
  [
    "optional argument follows earlier wait",
    "(async()=>{maybe?.(await 0,new Socket(URL));})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "optional member argument follows earlier wait",
    "(async()=>{holder?.run(await 0,new Socket(URL));})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "optional argument cannot use later wait",
    "(async()=>{maybe?.(new Socket(URL),await 0);})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "skippable optional arguments cannot delay following read",
    "(async()=>{maybe?.(await 0);new Socket(URL);})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "null optional arguments cannot delay following read",
    "(async()=>{null?.(await 0);new Socket(URL);})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "generator return argument follows consumed default wait",
    "(async()=>{const[a=await 0,b]=(function*(){yield undefined;return new Socket(URL);})();})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "generator throw argument follows consumed default wait",
    "(async()=>{const[a=await 0,b]=(function*(){yield undefined;throw new Socket(URL);})();})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "generator return before yield stays eager",
    "(async()=>{const[a=await 0,b]=(function*(){return new Socket(URL);yield undefined;})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "generator return without default wait stays eager",
    "const[a,b]=(function*(){yield undefined;return new Socket(URL);})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "generator close does not evaluate return tail",
    "(async()=>{const[a=await 0]=(function*(){yield undefined;return new Socket(URL);})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "generator return discards later wait and endpoint",
    "(async()=>{const[a=await 0,b]=(function*(){return;yield undefined;new Socket(URL);})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "generator throw discards later wait and endpoint",
    "(async()=>{const[a=await 0,b]=(function*(){throw 0;yield undefined;new Socket(URL);})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throw before wait cannot delay cleanup",
    "(async()=>{const[x=(null.value,await 0)]=(function*(){try{yield undefined;}finally{new Socket(URL);}})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "loop throw before wait cannot delay cleanup",
    "(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket(URL);}})()){throw 0;await 0;}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "optional spread",
    "(()=>{})?.(...(function*(){new Socket(URL);yield 0;})());const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "spread after awaited argument",
    "(async()=>{(()=>{})?.(await ready,...(function*(){new Socket(URL);yield 0;})());})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "return bypasses wrapper wait",
    "export {};const pending=(async()=>{await ready;new Socket(URL);})();await(async()=>{if(skip)return;await pending;})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "local nested return does not bypass wait",
    "export {};const pending=(async()=>{await ready;new Socket(URL);})();await(async()=>{(()=>{return;})();await pending;})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "pattern close enters finally after wait",
    "(async()=>{const[x=await 0]=(function*(){try{yield undefined;}finally{new Socket(URL);}})();})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "pattern close without wait stays eager",
    "const[x]=(function*(){try{yield undefined;}finally{new Socket(URL);}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "pattern close cannot reach normal tail",
    "(async()=>{const[x=await 0]=(function*(){yield undefined;new Socket(URL);})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "destructuring setter consumes generator",
    "({set consume([x]){}}).consume=(function*(){new Socket(URL);yield 0;})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "instance destructuring setter consumes generator",
    "(new(class{set consume([x]){}})()).consume=(function*(){new Socket(URL);yield 0;})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "setter after awaited RHS prefix",
    "(async()=>{({set consume([x]){}}).consume=(await ready,(function*(){new Socket(URL);yield 0;})());})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "default blocks after wait",
    "(async()=>{const[x=(await 0,null.value),next]=(function*(){yield undefined;new Socket(URL);})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "computed key blocks after wait",
    "(async()=>{const[{[(await 0,null.value)]:x},next]=(function*(){yield {};new Socket(URL);})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "later pattern coercion blocks after wait",
    "(async()=>{const[[x=await 0,{}],next]=(function*(){yield [undefined,null];new Socket(URL);})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "abrupt default closes iterator after wait",
    "(async()=>{const[x=(await 0,null.value),next]=(function*(){try{yield undefined;}finally{new Socket(URL);}})();})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "for-of break prevents next step",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL);})()){await 0;break;}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "for-of return prevents next step",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL);})()){await 0;return;}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "for-of continue permits next step",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL);})()){await 0;continue;}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "for-of break enters cleanup after wait",
    "(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket(URL);}})()){await 0;break;}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "unused wrapper parameter",
    "(async()=>{const pending=(async()=>{await 0;new Socket(URL);})();await((_unused)=>pending)();const Socket=globalThis.WebSocket;})();",
    false,
  ],
  [
    "wrapper parameter shadows returned name",
    "(async()=>{const pending=(async()=>{await ready;new Socket(URL);})();await((pending)=>pending)();const Socket=globalThis.WebSocket;})();",
    true,
  ],
  [
    "wrapper default is not inert",
    "(async()=>{const pending=(async()=>{await ready;new Socket(URL);})();await((x=fail())=>pending)();const Socket=globalThis.WebSocket;})();",
    true,
  ],
  [
    "negative numeric receiver",
    "(async()=>{(-1)?.[await 0];new Socket(URL);})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "negative bigint receiver",
    "(async()=>{(-1n)?.[await 0];new Socket(URL);})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "null receiver still skips key",
    "(async()=>{null?.[await 0];new Socket(URL);})();const Socket=globalThis.WebSocket;",
    false,
  ],
  ["object sequence prefix", "new({},globalThis.WebSocket)(URL);", true],
  [
    "object data sequence prefix",
    "new({key:1},globalThis.WebSocket)(URL);",
    true,
  ],
  ["regexp sequence prefix", "new(/safe/,globalThis.WebSocket)(URL);", true],
  [
    "object getter definition is inert",
    "new({get key(){throw 0;}},globalThis.WebSocket)(URL);",
    true,
  ],
  [
    "throwing object value is not safe prefix",
    "new({key:null.value},globalThis.WebSocket)(URL);",
    false,
  ],
  [
    "safe wrapper argument preserves blocking wait",
    "(async()=>{const pending=(async()=>{await 0;new Socket(URL)})();await((_unused)=>pending)(0);const Socket=globalThis.WebSocket})();",
    false,
  ],
  [
    "throwing wrapper argument skips blocking wait",
    "(async()=>{const pending=(async()=>{await 0;new Socket(URL)})();try{await((_unused)=>pending)(null.value)}catch{}const Socket=globalThis.WebSocket})();",
    true,
  ],
  [
    "wrapper supplied parameter shadows promise",
    "(async()=>{const pending=(async()=>{await ready;new Socket(URL)})();await((pending)=>pending)(0);const Socket=globalThis.WebSocket})();",
    true,
  ],
  [
    "null prototype pattern blocks later default",
    "(async()=>{const[[x],y=await 0]=(function*(){try{yield {__proto__:null};yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "primitive noniterable pattern blocks later default",
    "(async()=>{const[[x],y=await 0]=(function*(){try{yield 1;yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "string pattern permits later default",
    "(async()=>{const[[x],y=await 0]=(function*(){try{yield 'a';yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "failed pattern assignment blocks later default",
    "const fixed=0;(async()=>{let y;[fixed,y=await 0]=(function*(){try{yield 0;yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "mutable pattern assignment permits later default",
    "let fixed=0;(async()=>{let y;[fixed,y=await 0]=(function*(){try{yield 0;yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "failed assignment retains earlier wait",
    "const fixed=0;(async()=>{let x;[x=await 0,fixed]=(function*(){try{yield undefined;yield 0}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "unreachable catch cannot resume generator",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{break}catch{await 0;continue}}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throwing catch can resume generator",
    "(async()=>{for(const x of(function*(){yield 0;new Socket(URL)})()){try{throw 0}catch{await 0;continue}}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "conditional break bypasses update not its wait",
    "(async()=>{for(let i=0;i<1;new Socket(URL),i++){if(skip)break;await 0}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "conditional continue bypasses update wait",
    "(async()=>{for(let i=0;i<1;new Socket(URL),i++){if(skip)continue;await 0}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "catch inherits preceding literal wait",
    "(async()=>{try{await 0;throw 0}catch{new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "catch before wait remains eager",
    "(async()=>{try{null.value;await 0}catch{new Socket(URL)}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "positive numeric receiver",
    "(async()=>{(+1)?.[await 0];new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "boolean unary receiver",
    "(async()=>{(!0)?.[await 0];new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "typeof unary receiver",
    "(async()=>{(typeof 0)?.[await 0];new Socket(URL)})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "empty class sequence prefix",
    "new(class{},globalThis.WebSocket)(URL);",
    true,
  ],
  [
    "inert method class sequence prefix",
    "new(class{run(){throw 0}},globalThis.WebSocket)(URL);",
    true,
  ],
  [
    "throwing class heritage prefix",
    "new(class extends null.value{},globalThis.WebSocket)(URL);",
    false,
  ],
  [
    "throwing class static prefix",
    "new(class{static x=null.value},globalThis.WebSocket)(URL);",
    false,
  ],
  [
    "private static effect retains dormant body metadata",
    "(class{static run(){new Socket(URL)}static #effect=(this.run=()=>{})}).run();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "private inert static field keeps eager method",
    "(class{static run(){new Socket(URL)}static #value=1}).run();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "changed then adopted by async return",
    "export {};const pending=import('ws');pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await(async()=>pending)();new Socket(URL);",
    false,
  ],
  [
    "unchanged promise adopted by async return",
    "export {};const pending=import('ws');const{WebSocket:Socket}=await(async()=>pending)();new Socket(URL);",
    true,
  ],
  [
    "return await bypasses own promise then",
    "export {};const pending=import('ws');pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await(async()=>await pending)();new Socket(URL);",
    true,
  ],
  [
    "number prototype iterator leaves consumer phase unresolved",
    "Number.prototype[Symbol.iterator]=function*(){yield 0};(async()=>{const[[x],y=await 0]=(function*(){try{yield 1;yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "null prototype with data still blocks iteration",
    "(async()=>{const[[x],y=await 0]=(function*(){try{yield {__proto__:null,x:1};yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "own iterator on null prototype leaves consumer phase unresolved",
    "(async()=>{const[[x],y=await 0]=(function*(){try{yield {__proto__:null,*[Symbol.iterator](){yield 0}};yield undefined}finally{new Socket(URL)}})()})();const Socket=globalThis.WebSocket;",
    false,
  ],
] as const;
describe("web bundle completed consumer routes", () => {
  it.each(consumerRouteReviewCases)(
    "preserves %s in both consumers",
    (_name, input, present) => {
      const source = input.replaceAll(
        "URL",
        '"wss://example.test/review-completion"',
      );
      const expected = present ? ["wss://example.test/review-completion"] : [];
      expect(
        socketEndpoints(source).map((items) => items.map((item) => item.value)),
      ).toEqual([expected, expected]);
    },
  );
});

const invocationReviewCases = [
  [
    "mandatory branching catch wait",
    "(async()=>{try{if(flag)throw 0;else throw 1;}catch{await 0;}new Socket(URL);})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "catch return skips unreachable wait",
    "(async()=>{try{throw 0;}catch{return;await 0;}finally{new Socket(URL);}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "catch throw skips unreachable wait",
    "(async()=>{try{throw 0;}catch{throw 1;await 0;}finally{new Socket(URL);}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "throwing catch binding skips wait",
    "(async()=>{try{throw null;}catch({}){await 0;}finally{new Socket(URL);}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "nullish object rest blocks later wait",
    "(async()=>{const [{...x},y=await 0,next]=(function*(){yield null;yield undefined;new Socket(URL);})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "void object pattern key",
    "(async()=>{const [{[await 0]:x},next]=(function*(){yield void 0;new Socket(URL);})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "wrapped class constructor parameter",
    "new(0,class{constructor([x]){}})((function*(){new Socket(URL);yield 0;})());const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "optional fresh method parameter",
    "({run([x]){}})?.run?.((function*(){new Socket(URL);yield 0;})());const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "class constructor parameter",
    "new(class{constructor([x]){}})((function*(){new Socket(URL);yield 0;})());const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "object method parameter",
    "({run([x]){}}).run((function*(){new Socket(URL);yield 0;})());const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "class static method parameter",
    "(class{static run([x]){}}).run((function*(){new Socket(URL);yield 0;})());const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "fresh instance method parameter",
    "(new(class{run([x]){}})()).run((function*(){new Socket(URL);yield 0;})());const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "method call parameter",
    "({run([x]){}}).run.call(null,(function*(){new Socket(URL);yield 0;})());const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "method apply parameter",
    "({run([x]){}}).run.apply(null,[(function*(){new Socket(URL);yield 0;})()]);const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "awaited constructor argument",
    "(async()=>{new(class{constructor([x],y){}})((function*(){new Socket(URL);yield 0;})(),await ready);})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "non-consuming class parameter metadata",
    "new(class{constructor(x){}})((function*(){new Socket(URL);yield 0;})());const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "mandatory catch wait",
    "(async()=>{try{throw 0;}catch{await 0;}new Socket(URL);})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "return bypasses catch wait",
    "(async()=>{try{return;}catch{await 0;}finally{new Socket(URL);}})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "normal path bypasses catch wait",
    "(async()=>{try{0;}catch{await 0;}new Socket(URL);})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "conditional throw bypasses catch wait",
    "(async()=>{try{if(flag)throw 0;}catch{await 0;}new Socket(URL);})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "caught throw before finalizer",
    "(async()=>{try{throw 0;}catch{await 0;}finally{new Socket(URL);}})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "optional promise wrapper",
    "(async()=>{const pending=(async()=>{await ready;new Socket(URL);})();await(()=>pending)?.();const Socket=globalThis.WebSocket;})();",
    false,
  ],
  [
    "optional function promise wrapper",
    "(async()=>{const pending=(async()=>{await ready;new Socket(URL);})();await(function(){return pending;})?.();const Socket=globalThis.WebSocket;})();",
    false,
  ],
  [
    "nullish object pattern key",
    "(async()=>{const [{[await 0]:x},next]=(function*(){yield null;new Socket(URL);})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "undefined object pattern key",
    "(async()=>{const [{[await 0]:x},next]=(function*(){yield undefined;new Socket(URL);})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "nullish pattern blocks later slot wait",
    "(async()=>{const [{},x=await 0,next]=(function*(){yield null;yield undefined;new Socket(URL);})();})();const Socket=globalThis.WebSocket;",
    false,
  ],
  [
    "defined object pattern key",
    "(async()=>{const [{[await 0]:x},next]=(function*(){yield {};new Socket(URL);})();})();const Socket=globalThis.WebSocket;",
    true,
  ],
  [
    "object default selects non-null value",
    "(async()=>{const [{[await 0]:x}={},next]=(function*(){yield undefined;new Socket(URL);})();})();const Socket=globalThis.WebSocket;",
    true,
  ],
] as const;
describe("web bundle reviewed invocation and pattern phases", () => {
  it.each(invocationReviewCases)(
    "preserves %s in both consumers",
    (_name, input, present) => {
      const source = input.replaceAll(
        "URL",
        '"wss://example.test/review-invocation"',
      );
      const expected = present ? ["wss://example.test/review-invocation"] : [];
      expect(
        socketEndpoints(source).map((items) => items.map((item) => item.value)),
      ).toEqual([expected, expected]);
    },
  );
});

describe("web bundle literal consumers and iteration phases", () => {
  it.each(iterationReviewCases)(
    "preserves $name in both consumers",
    ({ source, present }) => {
      const expected = present ? ["wss://example.test/review-iteration"] : [];
      expect(
        socketEndpoints(source).map((items) => items.map((item) => item.value)),
      ).toEqual([expected, expected]);
    },
  );
});

describe("web bundle native Promise chain waits", () => {
  it.each([
    'const {WebSocket:Socket}=await import("ws").then(()=>({WebSocket:class{}}));',
    'const loaded=import("ws");const replacement=loaded.then(()=>({WebSocket:class{}}));const {WebSocket:Socket}=await replacement;',
    'const {WebSocket:Socket}=await import("ws").catch(()=>({WebSocket:class{}}));',
    'const {WebSocket:Socket}=await (async()=>await import("ws").then(()=>({WebSocket:class{}})))();',
  ])(
    "does not give handler replacements the parent's module origin: %s",
    (source) => {
      expect(
        socketEndpoints(
          `export {};${source}new Socket("wss://example.test/replaced-import");`,
        ).map((items) => items.map((item) => item.value)),
      ).toEqual([[], []]);
    },
  );
  it.each([
    'const pending=(async()=>{await 0;new Socket("wss://example.test/chain")})();await pending.finally(()=>{});',
    'const pending=new Promise(async resolve=>{await 0;new Socket("wss://example.test/chain");resolve()});await pending.finally(()=>{});',
    'const pending=(async()=>{await 0;new Socket("wss://example.test/chain")})();const tail=pending.finally(()=>{});await tail;',
    'const pending=(async()=>{await 0;new Socket("wss://example.test/chain")})();await pending.catch(()=>{}).finally(()=>{}).then(()=>{});',
    'const pending=(async()=>{await 0;new Socket("wss://example.test/chain")})();await pending["finally"](()=>{});',
    'const pending=(async()=>{await 0;new Socket("wss://example.test/chain")})();await pending.finally();',
    'const pending=(async()=>{await 0;new Socket("wss://example.test/chain")})();await pending.then(()=>{});',
    'const pending=(async()=>{await 0;new Socket("wss://example.test/chain")})();await pending.catch(()=>{});',
    'const pending=new Promise(async resolve=>{await 0;new Socket("wss://example.test/chain");resolve()});await pending.then(()=>{});',
    'const pending=new Promise(async resolve=>{await 0;new Socket("wss://example.test/chain");resolve()});await pending.catch(()=>{});',
    'const pending=(async()=>{await 0;new Socket("wss://example.test/chain")})();const tail=pending.then(()=>{});await tail.catch(()=>{});',
  ])("retains parent blocking in both consumers: %s", (source) => {
    expect(
      socketEndpoints(
        `export {};${source}const Socket=globalThis.WebSocket;`,
      ).map((items) => items.map((item) => item.value)),
    ).toEqual([[], []]);
    expect(
      socketEndpoints(
        `export {};const Socket=globalThis.WebSocket;${source}`,
      ).map((items) => items.map((item) => item.value)),
    ).toEqual([["wss://example.test/chain"], ["wss://example.test/chain"]]);
  });
  it.each([
    ["pending.finally=()=>undefined;", "pending.finally()"],
    ["const alias=pending;alias.finally=()=>undefined;", "pending.finally()"],
    ["Promise.prototype.finally=()=>undefined;", "pending.finally()"],
    ["pending.then=()=>undefined;", "pending.finally()"],
    ["const alias=pending;alias.then=()=>undefined;", "pending.finally()"],
    ["Promise.prototype.then=()=>undefined;", "pending.finally()"],
    [
      "Object.setPrototypeOf(pending,{finally:()=>undefined});",
      "pending.finally()",
    ],
    [
      "class Fast extends Promise{constructor(executor){super(resolve=>{resolve();executor(()=>{},()=>{})})}}pending.constructor={[Symbol.species]:Fast};",
      "pending.finally()",
    ],
  ] as const)(
    "keeps changed finally identity unknown in both consumers: %s",
    (change, wait) => {
      const source = `export {};let release;const ready=new Promise(resolve=>{release=resolve});const pending=(async()=>{await ready;new Socket("wss://example.test/changed-chain")})();${change}await ${wait};const Socket=globalThis.WebSocket;release();`;
      expect(
        socketEndpoints(source).map((items) => items.map((item) => item.value)),
      ).toEqual([
        ["wss://example.test/changed-chain"],
        ["wss://example.test/changed-chain"],
      ]);
    },
  );
});

describe("web bundle Promise capability reference roles", () => {
  it.each([
    ["object key", "({resolve:0});"],
    ["member name", "({}).resolve;"],
    ["object method", "({resolve(){}});"],
    ["class method", "class K{resolve(){}}"],
    ["label", "resolve:for(;;){break resolve;}"],
    ["destructuring binding", "{const {resolve}= {resolve:0};}"],
    ["eval property", "({eval:0});"],
    ["arguments property", "({arguments:0});"],
  ] as const)("ignores a %s in both consumers", (_name, prefix) => {
    const source = `export {};const pending=new Promise(async function(resolve){${prefix}await 0;new Socket("wss://example.test/property-name");resolve()});await pending;const Socket=globalThis.WebSocket;`;
    expect(
      socketEndpoints(source).map((items) => items.map((item) => item.value)),
    ).toEqual([[], []]);
  });
  it.each([
    ["shorthand value", "({resolve});"],
    ["computed key", "({[resolve]:0});"],
    ["member receiver", "resolve.name;"],
    ["call argument", "consume(resolve);"],
  ] as const)(
    "retains a real %s reference in both consumers",
    (_name, prefix) => {
      const source = `export {};const pending=new Promise(async resolve=>{${prefix}await 0;new Socket("wss://example.test/real-reference");resolve()});await pending;const Socket=globalThis.WebSocket;`;
      expect(
        socketEndpoints(source).map((items) => items.map((item) => item.value)),
      ).toEqual([
        ["wss://example.test/real-reference"],
        ["wss://example.test/real-reference"],
      ]);
    },
  );
});

describe("web bundle invocation and descriptor review follow-ups", () => {
  it.each([
    [
      "callback suppliers stay paired with their calls",
      'const invoke=run=>run();invoke(()=>{});const Socket=globalThis.WebSocket;invoke(()=>new Socket("wss://example.test/pair"));',
      "wss://example.test/pair",
    ],
    [
      "a rejected apply argument list does not enter its receiver",
      'const connect=()=>new Socket("wss://example.test/apply");try{connect.apply(null,1)}catch{}const Socket=globalThis.WebSocket;',
      "wss://example.test/apply",
    ],
    [
      "an inert method is a valid import-attributes value",
      'export {};const{WebSocket:Socket}=await import("ws",{with(){}});new Socket("wss://example.test/options");',
      "wss://example.test/options",
    ],
    [
      "a setter-only async disposer falls back to a sync disposer",
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/disposer")})()){await using r={set[Symbol.asyncDispose](value){},[Symbol.dispose](){}}}})();const Socket=globalThis.WebSocket;',
      "wss://example.test/disposer",
    ],
  ] as const)("preserves %s in both consumers", (_name, source, endpoint) => {
    expect(
      socketEndpoints(source).map((items) => items.map((item) => item.value)),
    ).toEqual([[endpoint], [endpoint]]);
  });

  it("orders helper selection before argument writes in both consumers", () => {
    const source =
      'const connect=()=>new Socket("wss://example.test/helper-read");connect.call(null,connect.call=()=>{});const Socket=globalThis.WebSocket;';
    expect(
      socketEndpoints(source).map((items) => items.map((item) => item.value)),
    ).toEqual([[], []]);
  });

  it.each([
    [
      "a computed destructuring key wait before getter entry",
      '(async()=>{const{[void await 0]:value}={get undefined(){return new Socket("wss://example.test/getter-key-wait")}}})();const Socket=globalThis.WebSocket;',
      "wss://example.test/getter-key-wait",
    ],
    [
      "an async Promise executor result independent of the outer promise",
      'let release;const ready=new Promise(resolve=>{release=resolve});const pending=new Promise(async resolve=>{resolve();await ready;new Socket("wss://example.test/async-executor")});await pending;const Socket=globalThis.WebSocket;release();',
      "wss://example.test/async-executor",
    ],
    [
      "an implicit subclass whose constructor prototype changed",
      'class Base{field=new Socket("wss://example.test/changed-base")}class Other{}class Derived extends Base{}Object.setPrototypeOf(Derived,Other);new Derived();const Socket=globalThis.WebSocket;',
      "wss://example.test/changed-base",
    ],
  ] as const)("preserves %s in both consumers", (_name, source, endpoint) => {
    expect(
      socketEndpoints(source).map((items) => items.map((item) => item.value)),
    ).toEqual([[endpoint], [endpoint]]);
  });

  it.each([
    [
      "nested binding waits after getter entry",
      '(async()=>{const{run:{[await 0]:x}}={get run(){new Socket("wss://example.test/nested-getter");return {}}}})();const Socket=globalThis.WebSocket;',
      [],
    ],
    [
      "destructuring default waits after getter entry",
      '(async()=>{const{run:x=await 0}={get run(){new Socket("wss://example.test/default-getter")}}})();const Socket=globalThis.WebSocket;',
      [],
    ],
    [
      "a getter key wait before nested binding work",
      '(async()=>{const{[void await 0]:{x}}={get undefined(){new Socket("wss://example.test/key-before-getter");return {}}}})();const Socket=globalThis.WebSocket;',
      ["wss://example.test/key-before-getter"],
    ],
    [
      "an outer promise settled by resolve after the socket read",
      'const pending=new Promise(async resolve=>{await 0;new Socket("wss://example.test/late-resolve");resolve()});await pending;const Socket=globalThis.WebSocket;',
      [],
    ],
    [
      "an outer promise settled by reject after the socket read",
      'const pending=new Promise(async(resolve,reject)=>{await 0;new Socket("wss://example.test/late-reject");reject()});await pending;const Socket=globalThis.WebSocket;',
      [],
    ],
    [
      "an outer promise without any settlement",
      'const pending=new Promise(async()=>{await 0;new Socket("wss://example.test/no-settlement")});await pending;const Socket=globalThis.WebSocket;',
      [],
    ],
    [
      "an escaped early resolver",
      'let release;const pending=new Promise(async resolve=>{release=resolve;await 0;new Socket("wss://example.test/escaped-resolve")});release();await pending;const Socket=globalThis.WebSocket;',
      ["wss://example.test/escaped-resolve"],
    ],
    [
      "a resolver name shadowed by a nested function",
      'const pending=new Promise(async resolve=>{(()=>{const resolve=()=>{};resolve()})();await 0;new Socket("wss://example.test/shadowed-resolve");resolve()});await pending;const Socket=globalThis.WebSocket;',
      [],
    ],
  ] as const)("orders %s in both consumers", (_name, source, expected) => {
    expect(
      socketEndpoints(source).map((items) => items.map((item) => item.value)),
    ).toEqual([expected, expected]);
  });

  it.each([
    [
      "base fields reached through implicit subclass construction",
      'class Base{field=new Socket("wss://example.test/base-field")}class Derived extends Base{}new Derived();const Socket=globalThis.WebSocket;',
    ],
    [
      "a native Promise executor invoked synchronously",
      'new Promise(()=>new Socket("wss://example.test/promise-executor"));const Socket=globalThis.WebSocket;',
    ],
    [
      "a fresh getter selected by object destructuring",
      'const{run}={get run(){return new Socket("wss://example.test/destructured-getter")}};const Socket=globalThis.WebSocket;',
    ],
  ] as const)(
    "suppresses %s before the constructor binding",
    (_name, source) => {
      expect(
        socketEndpoints(source).map((items) => items.map((item) => item.value)),
      ).toEqual([[], []]);
    },
  );
});

it("keeps known capture omissions in compact route summaries and queryable gap facts", () => {
  const captured = inspection("createBrowserRouter([{path:'/reports'}]);");
  captured.completeness.excluded.push(
    { section: "scripts", reason: "resource_budget_exhausted", count: 3 },
    {
      section: "script_sources",
      reason: "resource_budget_exhausted",
      count: null,
    },
  );
  const report = analyzeWebBundleFixture(captured),
    parent = {
      evidenceId: `ev_${"a".repeat(64)}`,
      operation: "analyze_web_bundle",
      normalizedResult: report,
      limitations: report.limitations,
      subject: null,
    };
  const summary = projectAnalysisView(
    parent,
    analysisViewRequestSchema.parse({
      kind: "javascript-routes",
      collection: "summary",
    }),
  );
  if (!summary.ok) throw summary.error;
  if (summary.value.kind !== "javascript-routes") throw new Error("Wrong view");
  expect(summary.value.source_coverage.candidate_enumeration).toBe("partial");
  expect(summary.value.summary!.reported_capture_omissions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ unit: "script-records", count: 3 }),
      expect.objectContaining({ unit: "script-sources", count: null }),
    ]),
  );
  const gaps = projectAnalysisView(
    parent,
    analysisViewRequestSchema.parse({
      kind: "javascript-routes",
      collection: "unknowns",
      where: { kinds: ["capture-omission"] },
      fields: ["capture_omission", "reason"],
    }),
  );
  if (!gaps.ok) throw gaps.error;
  if (gaps.value.kind !== "javascript-routes") throw new Error("Wrong view");
  expect(gaps.value.items).toHaveLength(2);
  for (const row of gaps.value.items)
    expect(row).toMatchObject({ source_id: null, provenance: null });
});
