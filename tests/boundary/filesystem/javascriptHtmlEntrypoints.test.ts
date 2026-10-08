import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
