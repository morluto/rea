import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  defaultTreeAdapter,
  parse,
  type DefaultTreeAdapterTypes,
} from "parse5";
import { expect, it } from "vitest";

import { reconstructJavaScriptArtifact } from "../../../src/application/javascript/JavaScriptArtifactReconstruction.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const cases = [
  ['<script data-src="decoy.js"></script>', []],
  ['<script x:src="decoy.js"></script>', []],
  [`<script title='src="decoy.js"'></script>`, []],
  ["<script src=actual.js></script>", ["actual.js"]],
  ['<script title=">" src="actual.js"></script>', ["actual.js"]],
  ['<script src="actual.js"></script>', ["actual.js"]],
  ["<script src='actual.js'></script>", ["actual.js"]],
  ['<script data-src="decoy.js" src="actual.js"></script>', ["actual.js"]],
  ['<!-- <script src="decoy.js"></script> -->', []],
  ['<textarea><script src="decoy.js"></script></textarea>', []],
  ['<template><script src="decoy.js"></script></template>', []],
  ['<script src="actual&#46;js" src="decoy.js"></script>', ["actual.js"]],
] as const;

it.each(cases)(
  "projects local loads from actual HTML attributes in %s",
  async (html, expected) => {
    const root = await createTestTempDirectory("rea-html-entrypoints-");
    await Promise.all([
      writeFile(join(root, "index.html"), html),
      writeFile(join(root, "actual.js"), "globalThis.ownedActual = true;"),
      writeFile(join(root, "decoy.js"), "globalThis.ownedDecoy = true;"),
    ]);
    const result = await reconstructJavaScriptArtifact({ input_path: root });
    const loads = result.graph.edges.filter(
      ({ relation, properties }) =>
        relation === "loads" && properties.script_path !== undefined,
    );
    expect(loads.map(({ properties }) => properties.resolved_path)).toEqual(
      expected,
    );
  },
);

it("preserves source digest, opening-tag range and decoded local base resolution", async () => {
  const root = await createTestTempDirectory("rea-html-entrypoint-evidence-");
  const opening = '<script title=">" src="actual&#46;js">';
  const prefix = '<base data-href="decoy/"><base href=assets/>\n';
  const html = `${prefix}${opening}</script>`;
  await mkdir(join(root, "assets"));
  await Promise.all([
    writeFile(join(root, "index.html"), html),
    writeFile(
      join(root, "assets", "actual.js"),
      "globalThis.ownedActual = true;",
    ),
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

const coordinateCases = [
  { name: "LF", prefix: "before\n", opening: '<script src="actual.js">' },
  { name: "CRLF", prefix: "before\r\n", opening: '<script src="actual.js">' },
  { name: "bare CR", prefix: "before\r", opening: '<script src="actual.js">' },
  {
    name: "mixed CRLF and CR",
    prefix: "before\r\nafter\r",
    opening: '<script src="actual.js">',
  },
  {
    name: "CR inside opening tag",
    prefix: "before\n",
    opening: '<script\r src="actual.js">',
  },
  {
    name: "CRLF inside opening tag",
    prefix: "before\n",
    opening: '<script\r\n src="actual.js">',
  },
  {
    name: "astral UTF-16 columns",
    prefix: "😀",
    opening: '<script src="actual.js">',
  },
  {
    name: "U+2028 literal text",
    prefix: "before\u2028",
    opening: '<script src="actual.js">',
  },
] as const;

it.each(coordinateCases)(
  "retains parse5 source coordinates for resolved and unresolved scripts with $name",
  async ({ prefix, opening }) => {
    const root = await createTestTempDirectory("rea-html-coordinate-evidence-");
    const html = `${prefix}${opening}</script><script src="missing.js"></script>`;
    const expected = htmlScriptRanges(html);
    expect(expected).toHaveLength(2);
    await Promise.all([
      writeFile(join(root, "index.html"), html),
      writeFile(join(root, "actual.js"), "export const actual = true;"),
    ]);
    const result = await reconstructJavaScriptArtifact({ input_path: root });
    const resolved = result.graph.edges.filter(
      ({ relation, properties }) =>
        relation === "loads" && properties.script_path === "actual.js",
    );
    const unresolved = result.graph.nodes
      .flatMap(({ observations }) => observations)
      .filter(
        ({ properties }) =>
          properties.mechanism === "html-script-reference" &&
          properties.script_path === "missing.js",
      );
    expect(resolved).toHaveLength(1);
    expect(unresolved).toHaveLength(1);
    for (const [index, observation] of [resolved[0], unresolved[0]].entries()) {
      expect(observation).toMatchObject({
        evidence: {
          artifact: {
            available: true,
            sha256: createHash("sha256").update(html).digest("hex"),
          },
          location: {
            available: true,
            value: {
              kind: "source-range",
              source: "index.html",
              ...expected[index],
            },
          },
        },
      });
    }
  },
);

const htmlScriptRanges = (html: string) => {
  const pending: DefaultTreeAdapterTypes.Node[] = [
    parse(html, { sourceCodeLocationInfo: true }),
  ];
  const ranges = [];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    if (defaultTreeAdapter.isElementNode(node) && node.tagName === "script") {
      const location = node.sourceCodeLocation?.startTag;
      if (location === undefined)
        throw new Error("Missing parse5 script range");
      ranges.push({
        start: { line: location.startLine, column: location.startCol - 1 },
        end: { line: location.endLine, column: location.endCol - 1 },
      });
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes.toReversed()) pending.push(child);
    }
  }
  return ranges;
};
