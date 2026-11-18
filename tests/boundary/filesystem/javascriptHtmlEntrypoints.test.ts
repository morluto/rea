import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { reconstructJavaScriptArtifact } from "../../support/javascriptApplicationScope.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("preserves source digest, opening-tag range and decoded local base resolution", async () => {
  const root = await createTestTempDirectory("rea-html-entrypoint-evidence-");
  const opening = '<script title=">" src="actual&#46;js" src="decoy.js">';
  const prefix =
    '<base data-href="decoy/"><base href=assets/><template><script src="decoy.js"></script></template>\n';
  const html = `${prefix}${opening}</script>`;
  await mkdir(join(root, "assets"));
  await Promise.all([
    writeFile(join(root, "index.html"), html),
    writeFile(
      join(root, "assets", "actual.js"),
      "globalThis.ownedActual = true;",
    ),
    writeFile(join(root, "assets", "decoy.js"), "globalThis.decoy = true;"),
  ]);
  const result = await reconstructJavaScriptArtifact({ input_path: root });
  const loads = result.graph.edges.filter(
    ({ relation, properties }) =>
      relation === "loads" && properties.script_path !== undefined,
  );
  expect(loads).toHaveLength(1);
  expect(loads[0]).toMatchObject({
    properties: {
      script_path: "actual.js",
      base_href: "assets/",
      resolved_path: "assets/actual.js",
    },
    evidence: {
      authority: "static-relationship-inference",
      artifact: {
        available: true,
        sha256: createHash("sha256").update(html).digest("hex"),
      },
      location: {
        available: true,
        value: {
          kind: "source-range",
          source: "index.html",
          start: { line: 2, column: 0 },
          end: { line: 2, column: opening.length },
        },
      },
    },
  });
});

it("preserves external and inline HTML script ranges across line endings", async () => {
  const root = await createTestTempDirectory("rea-html-coordinate-evidence-");
  const opening = '<script src="actual.js">';
  const missingOpening = '<script src="missing.js">';
  const closing = "</script>";
  const inlineOpening = "<script>";
  const cases = [
    ["lf", "before\n", opening, 2, 0, 2, 24],
    ["crlf", "before\r\n", opening, 2, 0, 2, 24],
    ["cr", "before\r", opening, 2, 0, 2, 24],
    ["mixed", "before\r\nafter\r", opening, 3, 0, 3, 24],
    ["tag-cr", "before\n", '<script\r src="actual.js">', 2, 0, 3, 17],
    ["tag-crlf", "before\n", '<script\r\n src="actual.js">', 2, 0, 3, 17],
    ["astral", "😀", opening, 1, 2, 1, 26],
    ["literal-separator", "before\u2028", opening, 1, 7, 1, 31],
  ] as const;
  const documents = cases.map(
    ([name, prefix, tag, startLine, startColumn, endLine, endColumn]) => ({
      source: `${name}.html`,
      html: `${prefix}${tag}${closing}${missingOpening}${closing}${inlineOpening}\r\nrun();\rnext();\n${closing}`,
      start: { line: startLine, column: startColumn },
      end: { line: endLine, column: endColumn },
    }),
  );
  await Promise.all([
    writeFile(join(root, "actual.js"), "export const actual = true;"),
    ...documents.map(({ source, html }) => writeFile(join(root, source), html)),
  ]);

  const { graph } = await reconstructJavaScriptArtifact({ input_path: root });
  const loads = graph.edges.filter(
    ({ relation, properties }) =>
      relation === "loads" && properties.script_path === "actual.js",
  );
  const observations = graph.nodes.flatMap(({ observations }) => observations);
  const unresolved = observations.filter(
    ({ properties }) =>
      properties.mechanism === "html-script-reference" &&
      properties.script_path === "missing.js",
  );
  const inlineGaps = observations.filter(
    ({ properties }) => properties.operation === "parse-html-inline-scripts",
  );
  for (const records of [loads, unresolved, inlineGaps])
    expect(records).toHaveLength(documents.length);

  for (const { source, html, start, end } of documents) {
    const missingStart = {
      line: end.line,
      column: end.column + closing.length,
    };
    const missingEnd = {
      line: end.line,
      column: missingStart.column + missingOpening.length,
    };
    const artifact = {
      available: true,
      sha256: createHash("sha256").update(html).digest("hex"),
    };
    for (const [records, range] of [
      [loads, { start, end }],
      [unresolved, { start: missingStart, end: missingEnd }],
    ] as const) {
      const record = records.find(
        ({ evidence }) =>
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          evidence.location.value.source === source,
      );
      expect(record?.evidence, source).toMatchObject({
        artifact,
        location: {
          available: true,
          value: { kind: "source-range", source, ...range },
        },
      });
    }
    const gap = inlineGaps.find(({ properties }) => properties.path === source);
    expect(gap, source).toMatchObject({
      evidence: { artifact },
      properties: {
        inline_scripts: [
          {
            script_type: "classic",
            location: {
              start: {
                line: end.line,
                column:
                  missingEnd.column + closing.length + inlineOpening.length,
              },
              end: { line: end.line + 3, column: 0 },
            },
          },
        ],
      },
    });
  }
});

it("reports unanalyzed inline HTML scripts instead of claiming complete coverage", async () => {
  const root = await createTestTempDirectory("rea-html-inline-scripts-");
  const html = [
    "<!doctype html><html><head>",
    '<script src="cordova.js"></script>',
    '<script type="application/ld+json">{"@type":"Thing"}</script>',
    "</head><body>",
    "<script>",
    'function startGame(){ fetch("https://api.example.test/score"); }',
    "</script>",
    '<script type="module">import { x } from "./mod.js"; console.log(x);</script>',
    "</body></html>",
  ].join("\n");
  await mkdir(join(root, "www"));
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "game", version: "1.0.0" }),
    ),
    writeFile(join(root, "www", "index.html"), html),
    writeFile(join(root, "www", "cordova.js"), "globalThis.cordova = {};"),
  ]);

  const result = await reconstructJavaScriptArtifact({ input_path: root });
  const gaps = result.graph.nodes.filter(
    ({ kind, observations }) =>
      kind === "unknown" &&
      observations.some(
        ({ properties }) =>
          properties.operation === "parse-html-inline-scripts",
      ),
  );

  expect(result.graph.coverage.status).toBe("partial");
  expect(gaps).toHaveLength(1);
  expect(gaps[0]?.observations[0]).toMatchObject({
    properties: {
      path: "www/index.html",
      inline_script_count: 2,
      inline_scripts: [
        {
          script_type: "classic",
          location: {
            start: { line: 5, column: 8 },
            end: { line: 7, column: 0 },
          },
        },
        {
          script_type: "module",
          location: {
            start: { line: 8, column: 22 },
            end: { line: 8, column: 67 },
          },
        },
      ],
    },
    evidence: {
      state: "unavailable",
      artifact: {
        sha256: createHash("sha256").update(html).digest("hex"),
      },
      coverage: { status: "partial" },
    },
  });
  expect(result.graph.limitations).toContain(
    "www/index.html has 2 inline JavaScript bodies starting at lines 5, 8 that were not analyzed; endpoints, storage, imports and other facts in them are absent from the evidence.",
  );
  // The external script is still projected as before.
  expect(
    result.graph.edges.some(
      ({ relation, properties }) =>
        relation === "loads" && properties.resolved_path === "www/cordova.js",
    ),
  ).toBe(true);
});

it("keeps complete coverage when HTML has only external scripts and data blocks", async () => {
  const root = await createTestTempDirectory("rea-html-no-inline-scripts-");
  await Promise.all([
    writeFile(
      join(root, "index.html"),
      '<script src="actual.js"></script><script type="importmap">{"imports":{}}</script><script>  </script>',
    ),
    writeFile(join(root, "actual.js"), "globalThis.ownedActual = true;"),
  ]);

  const result = await reconstructJavaScriptArtifact({ input_path: root });

  expect(result.graph.coverage.status).toBe("complete");
  expect(
    result.graph.limitations.some((limitation) =>
      limitation.includes("inline JavaScript"),
    ),
  ).toBe(false);
});

it("retains the first 100 HTML and SVG inline script locations in document order", async () => {
  const root = await createTestTempDirectory("rea-html-many-inline-scripts-");
  const scriptPair = [
    "<script>run();</script>",
    "<svg><script>svgRun();</script></svg>",
    "",
  ].join("\n");
  await writeFile(join(root, "index.html"), scriptPair.repeat(2_500));

  const result = await reconstructJavaScriptArtifact({ input_path: root });
  const gap = result.graph.nodes
    .flatMap(({ observations }) => observations)
    .find(
      ({ properties }) => properties.operation === "parse-html-inline-scripts",
    );
  const limit = {
    name: "html_inline_script_locations_per_file",
    value: 100,
    unit: "items",
  };

  expect(gap?.properties.inline_script_count).toBe(5_000);
  expect(gap?.properties.inline_scripts).toEqual(
    Array.from({ length: 100 }, (_, index) => {
      const line = index + 1;
      const svg = line % 2 === 0;
      return {
        script_type: "classic",
        location: {
          start: { line, column: svg ? 13 : 8 },
          end: { line, column: svg ? 22 : 14 },
        },
      };
    }),
  );
  // The gap record knows exactly which locations the bound dropped.
  expect(gap?.evidence.coverage).toEqual({
    status: "partial",
    truncated: true,
    omitted_count: 4_900,
    limits: [limit],
  });
  // The graph is truncated too, but unanalyzed bodies hide an unknown total.
  expect(result.graph.coverage).toMatchObject({
    status: "partial",
    truncated: true,
    omitted_count: null,
    limits: expect.arrayContaining([limit]),
  });
  expect(result.graph.limitations).toContain(
    "index.html has 5000 inline JavaScript bodies starting at lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 and 4990 more that were not analyzed; endpoints, storage, imports and other facts in them are absent from the evidence.",
  );
});
