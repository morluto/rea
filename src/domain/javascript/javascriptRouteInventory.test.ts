import { expect, it } from "vitest";
import { analyzeJavaScriptStaticSource } from "../../../tests/fixtures/javascriptStaticAnalysis.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import {
  buildJavaScriptRouteInventorySteps,
  javaScriptRouteInventorySchema,
  type JavaScriptRouteInventoryInput,
} from "./javascriptRouteInventory.js";

const source = (
  key: string,
  text: string,
  url: string | null = null,
): JavaScriptRouteInventoryInput => ({
  key,
  path: url === null ? key : null,
  url,
  sha256: "a".repeat(64),
  container_sha256: null,
  status: "complete",
  reason: null,
  facts: analyzeJavaScriptStaticSource(text).routes!,
  ...(url === null && key.startsWith("app/")
    ? {
        next_app_context: {
          kind: "app-directory" as const,
          directory: "app",
          package: {
            path: "package.json",
            sha256: "b".repeat(64),
            container_sha256: "c".repeat(64),
          },
        },
      }
    : {}),
});
const build = (inputs: JavaScriptRouteInventoryInput[], bytes?: number) =>
  javaScriptRouteInventorySchema.parse(
    completeSemanticSteps(buildJavaScriptRouteInventorySteps(inputs, bytes)),
  );

it("keeps rejected program-var paths out of independent route inventory", () => {
  const result = build([
    source(
      "routes.js",
      "var PATH='/reports/stale';globalThis.PATH='/other';createBrowserRouter([{path:PATH},{path:'/reports'}]);const independent='/reports/help';",
    ),
  ]);
  expect(result.routes.map(({ path }) => path)).toEqual([
    "/reports",
    "/reports/help",
  ]);
  expect(result.unknowns).toEqual([
    expect.objectContaining({
      kind: "interpretation",
      reason: expect.stringContaining("parent segment is unknown"),
    }),
  ]);
  expect(result.coverage).toMatchObject({
    source_parsing: "complete",
    candidate_enumeration: "partial",
  });
});

it.each([
  ["hello world", "hello%20world"],
  ["team?admin", "team%3Fadmin"],
  ["team#admin", "team%23admin"],
] as const)(
  "preserves Next filename pattern %s and its source identity",
  (segment, encoded) => {
    const url = `https://example.test/_next/static/chunks/app/${encoded}/page-abc.js`;
    const result = build([
      source(`app/${segment}/page.js`, ""),
      source("captured.js", "", url),
      source(
        "runtime.js",
        `globalThis.TURBOPACK=[];const page=${JSON.stringify(url)};`,
      ),
    ]);
    expect(result.routes).toMatchObject([
      { path: `/${segment}`, source_count: 3, occurrence_count: 3 },
    ]);
    expect(result.occurrences.map(({ source_id }) => source_id).sort()).toEqual(
      result.sources.map(({ id }) => id).sort(),
    );
    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: `app/${segment}/page.js`, url: null }),
        expect.objectContaining({ path: null, url }),
      ]),
    );
    expect(result.unknowns).toEqual([]);
    expect(result.coverage).toMatchObject({
      source_parsing: "complete",
      candidate_enumeration: "complete",
    });
  },
);

it.each(["app/page.js", "app/hello\nworld/page.js"])(
  "does not promote page-shaped path %j without source-router applicability",
  (path) => {
    const unknown = source(path, "");
    delete (unknown as { next_app_context?: unknown }).next_app_context;
    const result = build([unknown]);
    expect(result.routes).toEqual([]);
    expect(result.unknowns).toMatchObject([
      {
        source_id: result.sources[0]!.id,
        kind: "interpretation",
        reason: expect.stringContaining("not measured"),
      },
    ]);
    expect(result.sources[0]!.path).toBe(path);
    expect(result.coverage.candidate_enumeration).toBe("partial");
  },
);

it("binds source identity to the package evidence establishing router applicability", () => {
  const first = source("app/page.js", "");
  const context = first.next_app_context;
  if (context?.kind !== "app-directory")
    throw new Error("Expected declared fixture context");
  const second = {
    ...first,
    next_app_context: {
      ...context,
      package: { ...context.package, sha256: "d".repeat(64) },
    },
  };
  expect(build([first]).sources[0]!.id).not.toBe(
    build([second]).sources[0]!.id,
  );
});

it("coalesces exact patterns while retaining independent occurrences and stable identities", () => {
  const inputs = [
    source("one.js", `router.push('/reports');`),
    source(
      "two.js",
      `createBrowserRouter([{path:'/reports',children:[{path:'settings'}]}]);`,
    ),
    source("three.js", `createBrowserRouter([{path:'/reports'}]);`),
  ];
  const result = build(inputs),
    repeated = build([...inputs].reverse());
  expect(result.routes.map(({ path }) => path)).toEqual([
    "/reports",
    "/reports/settings",
  ]);
  expect(result.routes[0]).toMatchObject({
    occurrence_count: 3,
    source_count: 3,
  });
  const reportOccurrences = result.occurrences.filter(
    ({ route_id }) => route_id === result.routes[0]!.id,
  );
  expect(
    reportOccurrences
      .map(({ source_id, mechanism, segments }) => ({
        source: result.sources.find(({ id }) => id === source_id)?.key,
        mechanism,
        segments: segments.map(({ value }) => value),
      }))
      .sort((left, right) => left.source!.localeCompare(right.source!)),
  ).toEqual([
    {
      source: "one.js",
      mechanism: "navigation-target",
      segments: ["/reports"],
    },
    {
      source: "three.js",
      mechanism: "nested-route-object",
      segments: ["/reports"],
    },
    {
      source: "two.js",
      mechanism: "nested-route-object",
      segments: ["/reports"],
    },
  ]);
  expect(repeated).toEqual(result);
});
it("publishes the unresolved index flag alongside its usable child route", () => {
  const prefix = "createBrowserRouter([{index:";
  const result = build([
    source(
      "routes.js",
      `const INDEX=choose();\n${prefix}INDEX,children:[{path:'child'}]}]);`,
    ),
  ]);
  expect(result.routes.map(({ path }) => path)).toEqual(["/child"]);
  expect(result.unknowns).toMatchObject([
    {
      source_id: result.sources[0]?.id,
      kind: "interpretation",
      reason: expect.stringContaining("index-route flag"),
      source_range: {
        start: { line: 2, column: prefix.length },
        end: { line: 2, column: prefix.length + "INDEX".length },
      },
    },
  ]);
  expect(result.coverage).toMatchObject({
    source_parsing: "complete",
    candidate_enumeration: "partial",
  });
});
it("retains filename route provenance when source syntax is available or missing", () => {
  const available = "app/(account)/reports/[id]/page.tsx";
  const unavailable = "app/reports/[id]/page.js";
  const result = build([
    source(available, "export default function Page() { return null; }"),
    {
      ...source(unavailable, ""),
      status: "unavailable",
      reason: "source was not selected",
      facts: null,
    },
  ]);
  expect(result.routes).toMatchObject([
    {
      path: "/reports/:id",
      classification: "page",
      classification_basis: "next-app-page",
      source_count: 2,
      occurrence_count: 2,
    },
  ]);
  for (const [path, status] of [
    [available, "complete"],
    [unavailable, "unavailable"],
  ] as const) {
    const input = result.sources.find(({ key }) => key === path);
    expect(input).toMatchObject({ path, status });
    expect(result.occurrences).toContainEqual(
      expect.objectContaining({
        route_id: result.routes[0]?.id,
        source_id: input?.id,
        origin: "source-path",
        source_range: null,
      }),
    );
  }
  expect(result.unknowns).toMatchObject([
    {
      source_id: result.sources.find(({ key }) => key === unavailable)?.id,
      kind: "source-unavailable",
      reason: "source was not selected",
      source_range: null,
    },
  ]);
  expect(result.coverage).toMatchObject({
    source_parsing: "partial",
    candidate_enumeration: "partial",
  });
});
it("keeps host names and file URL paths from becoming deployment bases", () => {
  const urls = ["https://app/reports/page.js", "file:///tmp/_next/123.js"];
  const result = build(
    urls.map((url, index) =>
      source(`script-${index}`, "router.push('/reports');", url),
    ),
  );
  expect(result.routes).toMatchObject([
    { path: "/reports", occurrence_count: 2, source_count: 2 },
  ]);
  expect(result.sources).toMatchObject(
    urls.map((url) => ({ url, base_path: null })),
  );
  expect(result.unknowns).toEqual([]);
});
it("rejects forged aggregate counts and detached provenance", () => {
  const result = build([source("one.js", `router.push('/reports');`)]);
  const badCount = javaScriptRouteInventorySchema.safeParse({
    ...result,
    routes: result.routes.map((route) => ({ ...route, occurrence_count: 99 })),
  });
  const detachedOccurrence = javaScriptRouteInventorySchema.safeParse({
    ...result,
    sources: [],
    statistics: { ...result.statistics, sources_retained: 0 },
  });
  expect(badCount.error?.issues.map(({ path }) => path)).toContainEqual([
    "routes",
  ]);
  expect(
    detachedOccurrence.error?.issues.map(({ path }) => path),
  ).toContainEqual(["occurrences"]);
});

it("retains the first complete route rows that fit the result budget", () => {
  const paths = Array.from(
    { length: 100 },
    (_, index) => `/reports/${String(index).padStart(2, "0")}`,
  );
  const input = source(
    "many.js",
    paths.map((path) => `router.push('${path}');`).join("\n"),
  );
  const limit = 8192;
  const result = build([input], limit);
  const retainedPaths = result.routes.map(({ path }) => path);
  expect(retainedPaths.length).toBeGreaterThan(0);
  expect(retainedPaths.length).toBeLessThan(paths.length);
  expect(retainedPaths).toEqual(paths.slice(0, retainedPaths.length));
  expect(
    result.occurrences.map(({ unprefixed_path }) => unprefixed_path).sort(),
  ).toEqual(retainedPaths);
  expect(result.coverage).toMatchObject({
    source_parsing: "partial",
    candidate_enumeration: "partial",
  });
  expect(result.capacity?.limit_bytes).toBe(limit);
  expect(result.capacity?.accounted_bytes).toBeLessThanOrEqual(limit);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
    result.capacity?.accounted_bytes ?? 0,
  );
  expect(() => build([input], 1)).toThrow(
    expect.objectContaining({
      name: "RangeError",
      message: expect.stringContaining("envelope"),
    }),
  );
});

it("classifies typed page configuration while generic server route calls remain unknown", () => {
  const result = build([
    source(
      "typed.js",
      `defineRoutes({reports:{_$:'reports',settings:{_$:'settings'}}});app.route('/api/users');`,
    ),
  ]);
  expect(
    result.routes
      .filter((row) => row.classification === "page")
      .map((row) => row.path),
  ).toEqual(["/reports", "/reports/settings"]);
  expect(result.routes.find((row) => row.path === "/api/users")).toMatchObject({
    classification: "unknown",
    classification_basis: "unknown",
  });
});

it("coalesces inferred deployment roots without rewriting explicit trailing slashes", () => {
  const result = build([
    source(
      "root-call",
      "router.push('/');",
      "https://example.test/app/_next/static/chunks/runtime.js",
    ),
    source(
      "root-page",
      "",
      "https://example.test/app/_next/static/chunks/app/page.tsx",
    ),
    source("explicit.js", "router.push('/app');router.push('/app/');"),
  ]);
  expect(result.routes.map(({ path }) => path)).toEqual(["/app", "/app/"]);
  const root = result.routes.find(({ path }) => path === "/app")!;
  expect(root.source_count).toBe(3);
  const page = result.occurrences.find(({ origin }) => origin === "source-url");
  expect(page).toMatchObject({
    route_id: root.id,
    unprefixed_path: "/",
    inferred_base_path: "/app",
    source_range: null,
  });
  expect(result.unknowns.some(({ kind }) => kind === "inferred-base")).toBe(
    true,
  );
});

it("keeps enumeration partial when a recognized navigation target is unresolved", () => {
  const result = build([source("navigation.js", "router.navigate(target);")]);
  expect(result.routes).toEqual([]);
  expect(result.coverage.candidate_enumeration).toBe("partial");
  expect(result.unknowns).toEqual([
    expect.objectContaining({
      kind: "interpretation",
      source_id: result.sources[0]!.id,
    }),
  ]);
});

it("anchors based and unbased constants while preserving original paths and deployment evidence", () => {
  const reportsUrl = "https://example.test/app/_next/static/chunks/reports.js";
  const plannerUrl = "https://example.test/app/_next/static/chunks/planner.js";
  const result = build([
    source(
      "reports.js",
      `globalThis.TURBOPACK=[];router.push('/app/reports');const paths=['/reports/settings','/app/reports/history','/noise','/app/noise','/ROOT/node_modules/framework'];`,
      reportsUrl,
    ),
    source(
      "planner.js",
      `globalThis.TURBOPACK=[];createBrowserRouter([{path:'/planner'}]);const help='/planner/help';`,
      plannerUrl,
    ),
  ]);
  expect(result.routes.map(({ path }) => path)).toEqual([
    "/app/planner",
    "/app/planner/help",
    "/app/reports",
    "/app/reports/history",
    "/app/reports/settings",
  ]);
  expect(result.sources).toMatchObject(
    [plannerUrl, reportsUrl].map((url) => ({
      url,
      base_path: {
        value: "/app",
        basis: "next-script-url",
        status: "inferred",
      },
    })),
  );
  const [planner, reports] = result.sources;
  for (const [path, input, unprefixedPath, basePath] of [
    ["/app/planner", planner, "/planner", "/app"],
    ["/app/planner/help", planner, "/planner/help", "/app"],
    ["/app/reports", reports, "/app/reports", null],
    ["/app/reports/history", reports, "/app/reports/history", null],
    ["/app/reports/settings", reports, "/reports/settings", "/app"],
  ] as const) {
    expect(result.occurrences, path).toContainEqual(
      expect.objectContaining({
        route_id: result.routes.find((route) => route.path === path)?.id,
        source_id: input?.id,
        unprefixed_path: unprefixedPath,
        inferred_base_path: basePath,
        ...(basePath === null ? {} : { confidence: "low" }),
      }),
    );
  }
  expect(
    result.unknowns
      .filter(({ kind }) => kind === "inferred-base")
      .map(({ source_id }) => source_id)
      .sort(),
  ).toEqual(result.sources.map(({ id }) => id).sort());
  expect(result.statistics.unanchored_literals_excluded).toBe(3);
});

it("keeps filename and module-derived anchors application-relative when a deployment base matches an application segment", () => {
  const result = build([
    source(
      "page",
      "",
      "https://example.test/app/_next/static/chunks/app/app/page-abc.js",
    ),
    source(
      "root-runtime",
      "globalThis.TURBOPACK=[];const paths=['/app/settings','/noise'];",
      "https://example.test/_next/static/chunks/root.js",
    ),
    source(
      "module-runtime",
      "globalThis.TURBOPACK=[];const modulePath='app/app/page.js';",
      "https://example.test/app/_next/static/chunks/runtime.js",
    ),
  ]);
  expect(result.routes.map(({ path }) => path)).toEqual([
    "/app/app",
    "/app/settings",
  ]);
  const page = result.routes.find(({ path }) => path === "/app/app")!;
  expect(page.source_count).toBe(2);
  for (const origin of ["source-url", "source-syntax"])
    expect(result.occurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          route_id: page.id,
          origin,
          unprefixed_path: "/app",
          inferred_base_path: "/app",
        }),
      ]),
    );
  const base = { value: "/app", basis: "next-script-url", status: "inferred" };
  expect(
    Object.fromEntries(
      result.sources.map(({ key, base_path }) => [key, base_path]),
    ),
  ).toEqual({ page: base, "root-runtime": null, "module-runtime": base });
  expect(result.statistics.unanchored_literals_excluded).toBe(1);
});

it("reports generated typed configurations as partial even without retained candidates", () => {
  const result = build([
    source("generated.js", "defineRoutes({reports:buildRoutes()});"),
  ]);
  expect(result.routes).toEqual([]);
  expect(result.coverage.candidate_enumeration).toBe("partial");
  expect(result.unknowns).toHaveLength(1);
  expect(result.unknowns[0]!.kind).toBe("interpretation");
});

it("retains intercepted local and captured filenames as separate interpretation gaps", () => {
  const path = "app/feed/(.)photo/page.tsx";
  const url =
    "https://example.test/_next/static/chunks/app/feed/(.)photo/page-123.js";
  const result = build([source(path, ""), source("captured", "", url)]);
  expect(result.routes).toEqual([]);
  expect(result.occurrences).toEqual([]);
  expect(result.coverage.candidate_enumeration).toBe("partial");
  expect(result.sources).toMatchObject([
    { key: path, path, url: null },
    { key: "captured", path: null, url },
  ]);
  expect(result.unknowns).toHaveLength(2);
  for (const { id } of result.sources)
    expect(result.unknowns).toContainEqual(
      expect.objectContaining({
        source_id: id,
        kind: "interpretation",
        reason: expect.stringContaining("intercepted"),
        source_range: null,
      }),
    );
});

it("decodes captured script paths once and retains the original source identities", () => {
  const basedUrl =
    "https://example.test/base/_next/static/chunks/app/%28shop%29/blog/%5Bid%5D/page-abc.js";
  const escapedUrl =
    "https://example.test/_next/static/chunks/app/blog/%255Bid%255D/page-abc.js";
  const local = "app/blog/%5Bid%5D/page.js";
  const result = build([
    source("captured", "", basedUrl),
    source("escaped", "", escapedUrl),
    source(local, ""),
  ]);
  expect(result.routes).toMatchObject([
    { path: "/base/blog/:id", source_count: 1, occurrence_count: 1 },
    { path: "/blog/%5Bid%5D", source_count: 2, occurrence_count: 2 },
  ]);
  expect(result.sources).toHaveLength(3);
  for (const [key, url, routePath, unprefixed, base] of [
    [local, null, "/blog/%5Bid%5D", "/blog/%5Bid%5D", null],
    ["captured", basedUrl, "/base/blog/:id", "/blog/:id", "/base"],
    ["escaped", escapedUrl, "/blog/%5Bid%5D", "/blog/%5Bid%5D", null],
  ] as const) {
    const input = result.sources.find((row) => row.key === key);
    expect(input).toMatchObject({ path: url === null ? local : null, url });
    expect(result.occurrences).toContainEqual(
      expect.objectContaining({
        route_id: result.routes.find(({ path }) => path === routePath)?.id,
        source_id: input?.id,
        origin: url === null ? "source-path" : "source-url",
        unprefixed_path: unprefixed,
        inferred_base_path: base,
        source_range: null,
      }),
    );
  }
});

it("reports invalid Next filename interpretations while retaining usable script routes", () => {
  const cases = [
    ["nul", "hello%00world", "control character"],
    ["tab", "hello%09world", "control character"],
    ["line-feed", "hello%0Aworld", "control character"],
    ["delete", "hello%7Fworld", "control character"],
    ["slash", "team%2Fadmin", "encoded path separator"],
    ["backslash", "team%5Cadmin", "encoded path separator"],
    ["malformed", "%E0%A4%A", "malformed percent encoding"],
  ] as const;
  const captured = cases.map(([key, segment, reason]) => ({
    key,
    url: `https://example.test/_next/static/chunks/app/${segment}/page-abc.js`,
    reason,
  }));
  const result = build(
    captured.map(({ key, url }) => source(key, "router.push('/usable');", url)),
  );
  expect(result.routes).toMatchObject([
    {
      path: "/usable",
      source_count: cases.length,
      occurrence_count: cases.length,
    },
  ]);
  expect(result.sources).toHaveLength(cases.length);
  expect(result.unknowns).toHaveLength(cases.length);
  for (const { key, url, reason } of captured) {
    const input = result.sources.find((row) => row.key === key);
    expect(input, key).toMatchObject({ path: null, url });
    expect(result.unknowns, key).toContainEqual(
      expect.objectContaining({
        source_id: input?.id,
        kind: "interpretation",
        reason: expect.stringContaining(reason),
      }),
    );
  }
  expect(result.coverage.candidate_enumeration).toBe("partial");
});

it("distinguishes URL suffixes from literal Next script filename bytes", () => {
  const baseUrl = "https://example.test/_next/static/chunks/app/dashboard/";
  const captured = [
    [`${baseUrl}page-abc.js?cache=1`, true],
    [`${baseUrl}page-abc.js#section`, true],
    [`${baseUrl}page-abc.js?cache=1#section`, true],
    [`${baseUrl}page%3Fnotes.js`, false],
    [`${baseUrl}page%23notes.js`, false],
    [`${baseUrl}page.js%3Fnotes`, false],
    [`${baseUrl}page.js%23notes`, false],
  ] as const;
  const local = [
    "app/dashboard/page?notes.js",
    "app/dashboard/page#notes.js",
    "app/dashboard/page.js?notes",
    "app/dashboard/page.js#notes",
  ];
  const result = build([
    ...captured.map(([url], index) => source(`captured-${index}`, "", url)),
    ...local.map((path) => source(path, "")),
  ]);
  expect(result.routes).toMatchObject([
    { path: "/dashboard", source_count: 3, occurrence_count: 3 },
  ]);
  const sourcesByUrl = new Map(result.sources.map((row) => [row.url, row]));
  const expectedOccurrences = [];
  for (const [url, resolves] of captured) {
    const row = sourcesByUrl.get(url);
    expect(row, url).toMatchObject({ path: null, url });
    if (resolves) expectedOccurrences.push(row?.id);
  }
  expect(result.occurrences.map(({ source_id }) => source_id).sort()).toEqual(
    expectedOccurrences.sort(),
  );
  expect(
    result.sources
      .filter(({ url }) => url === null)
      .map(({ path }) => path)
      .sort(),
  ).toEqual([...local].sort());
});
